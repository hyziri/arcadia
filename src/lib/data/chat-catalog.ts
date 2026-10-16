/** Persists and validates the chat catalog read model in IndexedDB.
 *
 * Catalog rows provide a compact, recently-updated listing for chats whose message history lives
 * in version-control repositories. Reads validate persisted rows so storage drift is reported as a
 * typed corruption error rather than leaking malformed data to callers.
 */

import * as v from 'valibot';

import {
	ChatCatalogSchema,
	PaginationSchema,
	type ChatCatalog as ChatCatalogModel,
	type Pagination
} from '#lib/model';
import { getLogger } from '#lib/logger.ts';
import { withTransaction, type ArcadiaTransaction, type Database } from '#lib/db';
import { AppError } from '#lib/error.ts';

/** Logger scoped to chat catalog persistence and validation. */
const log = getLogger('data/chat-catalog');

/** Indicates that a persisted chat catalog row does not match the chat catalog schema. */
export class ChatCatalogCorruptError extends AppError {
	/** Discriminator used to narrow this error. */
	readonly kind = 'chat_catalog_corrupt';
	/** ID of the invalid catalog row. */
	readonly catalogId: string;
	/** Validation issues reported for the persisted row. */
	readonly issues: readonly v.InferIssue<typeof ChatCatalogSchema>[];

	/** Creates an error describing an invalid persisted chat catalog row.
	 *
	 * @param catalogId - The ID of the invalid catalog row.
	 * @param issues - The schema validation issues found in the row.
	 */
	constructor(catalogId: string, issues: readonly v.InferIssue<typeof ChatCatalogSchema>[]) {
		super('A persisted chat catalog row is invalid');
		this.catalogId = catalogId;
		this.issues = issues;
	}
}

/** Indicates that an IndexedDB operation on the chat catalog failed. */
export class ChatCatalogDatabaseError extends AppError {
	/** Discriminator used to narrow this error. */
	readonly kind = 'chat_catalog_database';
	/** Catalog operation that failed. */
	readonly operation: 'create' | 'read' | 'update' | 'delete';
	/** ID of the affected catalog row, or `undefined` if it was not known when the failure occurred. */
	readonly catalogId: string | undefined;

	/** Creates an error describing a failed chat catalog database operation.
	 *
	 * @param operation - The database operation that failed.
	 * @param catalogId - The affected catalog row ID, when one is available.
	 * @param options - The underlying failure to preserve as the error cause.
	 */
	constructor(
		operation: 'create' | 'read' | 'update' | 'delete',
		catalogId: string | undefined,
		options?: ErrorOptions
	) {
		super(`Chat catalog ${operation} operation failed`, options);
		this.operation = operation;
		this.catalogId = catalogId;
	}
}

/** Indicates that a catalog entry was accessed through the wrong chat repository. */
export class ChatCatalogOwnershipError extends AppError {
	/** Discriminator used to narrow this error. */
	readonly kind = 'chat_catalog_ownership';
	/** ID of the catalog entry addressed by the operation. */
	readonly catalogId: string;
	/** Chat repository ID supplied by the caller. */
	readonly expectedRepoId: string;
	/** Chat repository ID recorded on the catalog entry. */
	readonly actualRepoId: string;

	/** Creates an error describing a chat repository ownership mismatch.
	 *
	 * @param catalogId - The ID of the catalog entry addressed.
	 * @param expectedRepoId - The chat repository ID expected by the caller.
	 * @param actualRepoId - The chat repository ID stored on the catalog entry.
	 */
	constructor(catalogId: string, expectedRepoId: string, actualRepoId: string) {
		super(`${catalogId} does not belong to repository ${expectedRepoId}`);
		this.catalogId = catalogId;
		this.expectedRepoId = expectedRepoId;
		this.actualRepoId = actualRepoId;
	}
}

/** Provides validated CRUD and recent-list operations for persisted chat catalog rows. */
export class ChatCatalogRepo {
	private readonly _db: Database;

	/** Creates a chat catalog repository backed by the supplied database connection.
	 *
	 * @param database - The database used for catalog persistence.
	 */
	constructor(database: Database) {
		this._db = database;
	}

	/** Creates a catalog entry for a chat repository.
	 *
	 * The entry receives a generated ID and matching creation/update timestamps.
	 *
	 * @param chatRepoId - The version-control repository that stores the chat history.
	 * @param lastMessageCommitId - The commit used to identify the latest chat message.
	 * @param tx - Optional caller-owned read-write transaction containing the catalog store.
	 * @returns The created catalog entry.
	 * @throws {v.ValiError|ChatCatalogDatabaseError|TransactionScopeError|OperationTimeoutError|DOMException} when validation or persistence fails.
	 */
	async create(
		chatRepoId: string,
		lastMessageCommitId: string,
		tx?: ArcadiaTransaction<'readwrite'>
	): Promise<ChatCatalogModel> {
		log.trace('create enter', { chatRepoId });

		const chatCatalogId = crypto.randomUUID();
		const now = Date.now();
		const chatCatalog = v.parse(ChatCatalogSchema, {
			id: chatCatalogId,
			chatRepoId,
			lastMessageCommitId,
			createdAt: now,
			updatedAt: now
		});

		try {
			await withTransaction(this._db, ['chatCatalog'], 'readwrite', tx, async (transaction) => {
				await transaction.objectStore('chatCatalog').add(chatCatalog);
			});
		} catch (cause: unknown) {
			throwDatabaseFailure('create', chatCatalogId, cause);
		}

		log.debug('chat catalog created', { chatCatalogId });
		return chatCatalog;
	}

	/** Gets one catalog entry by its ID.
	 *
	 * @param catalogId - The ID of the catalog entry to retrieve.
	 * @param tx - Optional caller-owned transaction containing the catalog store.
	 * @returns The validated catalog entry, or `undefined` if it does not exist.
	 * @throws {ChatCatalogCorruptError|ChatCatalogDatabaseError|TransactionScopeError|OperationTimeoutError|DOMException} when the row is corrupt or the read fails.
	 */
	async getByCatalogId(
		catalogId: string,
		tx?: ArcadiaTransaction
	): Promise<ChatCatalogModel | undefined> {
		log.trace('get enter', { catalogId });

		let storedRow: unknown;
		try {
			storedRow = await withTransaction(
				this._db,
				['chatCatalog'],
				'readonly',
				tx,
				async (transaction) => transaction.objectStore('chatCatalog').get(catalogId)
			);
		} catch (cause: unknown) {
			throwDatabaseFailure('read', catalogId, cause);
		}

		if (storedRow === undefined) return undefined;
		return parseChatCatalog(catalogId, storedRow);
	}

	/** Gets one catalog entry by its owning chat repository ID.
	 *
	 * @param chatRepoId - The chat repository whose catalog entry to retrieve.
	 * @param tx - Optional caller-owned transaction containing the catalog store.
	 * @returns The validated catalog entry, or `undefined` if the repository has no catalog entry.
	 * @throws {ChatCatalogCorruptError|ChatCatalogDatabaseError|TransactionScopeError|OperationTimeoutError|DOMException} when the row is corrupt or the read fails.
	 */
	async getByChatRepoId(
		chatRepoId: string,
		tx?: ArcadiaTransaction
	): Promise<ChatCatalogModel | undefined> {
		log.trace('get by chat repo enter', { chatRepoId });

		let storedEntry: { catalogId: string; storedRow: unknown } | undefined;
		try {
			storedEntry = await withTransaction(
				this._db,
				['chatCatalog'],
				'readonly',
				tx,
				async (transaction) => {
					const cursor = await transaction
						.objectStore('chatCatalog')
						.index('by-chat-repo')
						.openCursor(chatRepoId);
					if (cursor === null) return undefined;

					return { catalogId: cursor.primaryKey, storedRow: cursor.value };
				}
			);
		} catch (cause: unknown) {
			throwDatabaseFailure('read', undefined, cause);
		}

		if (storedEntry === undefined) return undefined;
		return parseChatCatalog(storedEntry.catalogId, storedEntry.storedRow);
	}

	/** Gets a page of catalog entries, with the most recently updated entries first.
	 *
	 * @param pagination - The one-based page number and number of entries per page.
	 * @param tx - Optional caller-owned transaction containing the catalog store.
	 * @returns The validated catalog entries for the requested page.
	 * @throws {v.ValiError|ChatCatalogCorruptError|ChatCatalogDatabaseError|TransactionScopeError|OperationTimeoutError|DOMException} when pagination is invalid, a row is corrupt, or the read fails.
	 */
	async getRecent(pagination: Pagination, tx?: ArcadiaTransaction): Promise<ChatCatalogModel[]> {
		const { page, perPage } = v.parse(PaginationSchema, pagination);
		log.trace('get recent enter', { page, perPage });

		const offset = (page - 1) * perPage;
		let storedRows: { catalogId: string; storedRow: unknown }[];

		try {
			storedRows = await withTransaction(
				this._db,
				['chatCatalog'],
				'readonly',
				tx,
				async (transaction) => {
					const index = transaction.objectStore('chatCatalog').index('by-updated-at');
					const rows: { catalogId: string; storedRow: unknown }[] = [];

					let cursor = await index.openCursor(null, 'prev');
					if (cursor !== null && offset > 0) {
						cursor = await cursor.advance(offset);
					}

					while (cursor !== null && rows.length < perPage) {
						rows.push({ catalogId: cursor.primaryKey, storedRow: cursor.value });
						cursor = await cursor.continue();
					}

					return rows;
				}
			);
		} catch (cause: unknown) {
			throwDatabaseFailure('read', undefined, cause);
		}

		return storedRows.map(({ catalogId, storedRow }) => parseChatCatalog(catalogId, storedRow));
	}

	/** Updates a catalog entry's latest-message commit and update timestamp.
	 *
	 * The expected chat repository ID is checked before the row is changed.
	 *
	 * @param catalogId - The ID of the catalog entry to update.
	 * @param chatRepoId - The expected owning chat repository ID.
	 * @param lastMessageCommitId - The commit used to identify the latest chat message.
	 * @param tx - Optional caller-owned read-write transaction containing the catalog store.
	 * @returns The updated entry, or `undefined` if it does not exist.
	 * @throws {v.ValiError|ChatCatalogCorruptError|ChatCatalogOwnershipError|ChatCatalogDatabaseError|TransactionScopeError|OperationTimeoutError|DOMException} when validation, ownership verification, or persistence fails.
	 */
	async update(
		chatRepoId: string,
		catalogId: string,
		lastMessageCommitId: string,
		tx?: ArcadiaTransaction<'readwrite'>
	): Promise<ChatCatalogModel | undefined> {
		log.trace('update enter', { catalogId });

		try {
			return await withTransaction(
				this._db,
				['chatCatalog'],
				'readwrite',
				tx,
				async (transaction) => {
					const store = transaction.objectStore('chatCatalog');
					const storedRow: unknown = await store.get(catalogId);
					if (storedRow === undefined) return undefined;

					const current = parseChatCatalog(catalogId, storedRow);
					if (current.chatRepoId !== chatRepoId)
						throwChatCatalogOwnershipFailure(catalogId, chatRepoId, current.chatRepoId);

					const next = v.parse(ChatCatalogSchema, {
						...current,
						lastMessageCommitId,
						updatedAt: Date.now()
					});

					await store.put(next);
					return next;
				}
			);
		} catch (cause: unknown) {
			throwDatabaseFailure('update', catalogId, cause);
		}
	}

	/** Deletes a catalog entry if it exists; deleting a missing ID has no effect.
	 *
	 * The expected chat repository ID is checked before the row is deleted.
	 *
	 * @param catalogId - The ID of the catalog entry to delete.
	 * @param chatRepoId - The expected owning chat repository ID.
	 * @param tx - Optional caller-owned read-write transaction containing the catalog store.
	 * @returns A promise that resolves when the delete operation completes.
	 * @throws {ChatCatalogCorruptError|ChatCatalogOwnershipError|ChatCatalogDatabaseError|TransactionScopeError|OperationTimeoutError|DOMException} when the stored row is corrupt, ownership verification fails, or deletion fails.
	 */
	async delete(
		chatRepoId: string,
		catalogId: string,
		tx?: ArcadiaTransaction<'readwrite'>
	): Promise<void> {
		log.trace('delete enter', { catalogId });

		try {
			await withTransaction(this._db, ['chatCatalog'], 'readwrite', tx, async (transaction) => {
				const store = transaction.objectStore('chatCatalog');
				const storedRow: unknown = await store.get(catalogId);
				if (storedRow === undefined) return undefined;

				const current = parseChatCatalog(catalogId, storedRow);
				if (current.chatRepoId !== chatRepoId)
					throwChatCatalogOwnershipFailure(catalogId, chatRepoId, current.chatRepoId);

				await transaction.objectStore('chatCatalog').delete(catalogId);
			});
		} catch (cause: unknown) {
			throwDatabaseFailure('delete', catalogId, cause);
		}
	}
}

/** Validates a persisted row and throws a typed corruption error with its catalog ID on failure. */
function parseChatCatalog(catalogId: string, storedRow: unknown): ChatCatalogModel {
	const parsed = v.safeParse(ChatCatalogSchema, storedRow);

	if (!parsed.success) {
		const error = new ChatCatalogCorruptError(catalogId, parsed.issues);

		log.error('corrupt chat catalog row', {
			err: error,
			catalogId
		});

		throw error;
	}

	return parsed.output;
}

/** Preserves typed application failures and wraps unexpected IndexedDB failures with catalog context. */
function throwDatabaseFailure(
	operation: 'create' | 'read' | 'update' | 'delete',
	catalogId: string | undefined,
	cause: unknown
): never {
	if (cause instanceof AppError || cause instanceof v.ValiError) throw cause;

	const error = new ChatCatalogDatabaseError(operation, catalogId, { cause });
	log.error(`Chat catalog ${operation} failed`, {
		err: error,
		...(catalogId === undefined ? {} : { catalogId })
	});
	throw error;
}

/** Logs and throws a typed ownership error when a catalog row belongs to another chat repository. */
function throwChatCatalogOwnershipFailure(
	catalogId: string,
	expectedRepoId: string,
	actualRepoId: string
) {
	const error = new ChatCatalogOwnershipError(catalogId, expectedRepoId, actualRepoId);

	log.error('Chat catalog repo ownership mismatch', {
		err: error,
		catalogId,
		expectedRepoId,
		actualRepoId
	});

	throw error;
}
