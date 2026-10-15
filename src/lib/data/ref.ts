/** Persists and validates named repository references in IndexedDB.
 *
 * References point to commits within a repository. Reads validate stored rows, and mutations verify
 * that the addressed reference belongs to the requested repository before changing it.
 *
 * @example
 * ```ts
 * import { RefRepo } from '#lib/data';
 *
 * const refRepo = new RefRepo();
 * const mainRef = await refRepo.get('repo-123', 'ref-main');
 * ```
 */

import * as v from 'valibot';

import { getDatabase, withTransaction, type ArcadiaTransaction } from '#lib/db';
import { AppError } from '#lib/error';
import { getLogger } from '#lib/logger';
import { RefSchema } from '#lib/model';

import {
	reportVersionControlOwnershipFailure,
	throwVersionControlDatabaseFailure
} from './version-control-errors';

/** Validates a reference row persisted in IndexedDB. */
export const DbRefSchema = RefSchema;

/** Validates fields accepted when creating a reference. */
export const CreateDbRefParamSchema = v.omit(DbRefSchema, [
	'id',
	'repoId',
	'createdAt',
	'updatedAt'
]);

/** Validates mutable reference fields. */
export const UpdateDbRefParamSchema = v.partial(
	v.omit(DbRefSchema, ['id', 'repoId', 'createdAt', 'updatedAt'])
);

/** A validated reference row as persisted in IndexedDB. */
export type DbRef = v.InferOutput<typeof DbRefSchema>;

/** Fields required to create a reference. */
export type CreateDbRefParam = v.InferOutput<typeof CreateDbRefParamSchema>;

/** Mutable fields accepted when updating a reference. */
export type UpdateDbRefParam = v.InferOutput<typeof UpdateDbRefParamSchema>;

/** Logger scoped to reference persistence and validation. */
const log = getLogger('data/ref');

/** Indicates that a persisted reference row does not match its schema. */
export class RefCorruptError extends AppError {
	readonly kind = 'ref_corrupt';
	readonly refId: string;
	readonly repoId: string;
	readonly issues: readonly v.InferIssue<typeof DbRefSchema>[];

	/** Creates an error describing an invalid persisted reference row. */
	constructor(refId: string, repoId: string, issues: readonly v.InferIssue<typeof DbRefSchema>[]) {
		super(`Persisted reference is invalid: ${refId}`);
		this.refId = refId;
		this.repoId = repoId;
		this.issues = issues;
	}
}

/** Provides validated create, read, update, and delete operations for refs. */
export class RefRepo {
	/**
	 * Creates a named reference in a repository.
	 *
	 * @param repoId - The owning repository ID.
	 * @param refId - The ID assigned to the reference.
	 * @param createRefParam - The reference name and target commit ID.
	 * @param transaction - Optional caller-owned transaction spanning repository operations.
	 * @returns The created reference row.
	 * @throws {v.ValiError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when validation or the IndexedDB write fails.
	 */
	async create(
		repoId: string,
		refId: string,
		createRefParam: CreateDbRefParam,
		transaction?: ArcadiaTransaction<'readwrite'>
	): Promise<DbRef> {
		log.trace('create enter', { repoId, refId });

		const input = v.parse(CreateDbRefParamSchema, createRefParam);
		const now = Date.now();
		const ref = v.parse(DbRefSchema, {
			...input,
			id: refId,
			repoId,
			createdAt: now,
			updatedAt: now
		});

		try {
			await withTransaction(await getDatabase(), ['refs'], 'readwrite', transaction, async (tx) => {
				await tx.objectStore('refs').add(ref);
			});
		} catch (cause: unknown) {
			throwVersionControlDatabaseFailure(log, 'ref', 'create', refId, repoId, cause);
		}

		log.debug('reference created', { repoId, refId });
		return ref;
	}

	/**
	 * Gets one reference by ID within its owning repository.
	 *
	 * @param repoId - The expected owning repository ID.
	 * @param refId - The reference ID to retrieve.
	 * @param transaction - Optional caller-owned transaction containing the reference store.
	 * @returns The validated reference, or `undefined` if it does not exist.
	 * @throws {RefCorruptError|VersionControlOwnershipError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when the row is invalid, belongs to another repository, or cannot be read.
	 */
	async get(
		repoId: string,
		refId: string,
		transaction?: ArcadiaTransaction
	): Promise<DbRef | undefined> {
		log.trace('get enter', { repoId, refId });

		let storedRow: unknown;
		try {
			storedRow = await withTransaction(
				await getDatabase(),
				['refs'],
				'readonly',
				transaction,
				async (tx) => tx.objectStore('refs').get(refId)
			);
		} catch (cause: unknown) {
			throwVersionControlDatabaseFailure(log, 'ref', 'read', refId, repoId, cause);
		}

		if (storedRow === undefined) return undefined;
		const ref = parseRef(storedRow, repoId, refId);
		assertRefOwnership(ref, repoId);
		return ref;
	}

	/**
	 * Updates a reference's name or target commit.
	 *
	 * @param repoId - The expected owning repository ID.
	 * @param refId - The reference ID to update.
	 * @param updateRefParam - The mutable reference fields to apply.
	 * @param transaction - Optional caller-owned transaction spanning repository operations.
	 * @returns The updated reference, or `undefined` if it does not exist.
	 * @throws {v.ValiError|RefCorruptError|VersionControlOwnershipError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when validation or persistence fails.
	 */
	async update(
		repoId: string,
		refId: string,
		updateRefParam: UpdateDbRefParam,
		transaction?: ArcadiaTransaction<'readwrite'>
	): Promise<DbRef | undefined> {
		log.trace('update enter', { repoId, refId });

		const input = v.parse(UpdateDbRefParamSchema, updateRefParam);
		let updated: DbRef | undefined;
		try {
			updated = await withTransaction(
				await getDatabase(),
				['refs'],
				'readwrite',
				transaction,
				async (tx) => {
					const store = tx.objectStore('refs');
					const storedRow: unknown = await store.get(refId);
					if (storedRow === undefined) return undefined;

					const currentRef = parseRef(storedRow, repoId, refId);
					assertRefOwnership(currentRef, repoId);
					const updatedRef = v.parse(DbRefSchema, {
						...currentRef,
						...input,
						updatedAt: Date.now()
					});
					await store.put(updatedRef);
					return updatedRef;
				}
			);
		} catch (cause: unknown) {
			throwVersionControlDatabaseFailure(log, 'ref', 'update', refId, repoId, cause);
		}

		if (updated === undefined) return undefined;
		log.debug('reference updated', { repoId, refId });
		return updated;
	}

	/**
	 * Deletes a reference without deleting commits it points to.
	 *
	 * @param repoId - The expected owning repository ID.
	 * @param refId - The reference ID to delete.
	 * @param transaction - Optional caller-owned transaction spanning repository operations.
	 * @returns `true` if a reference was deleted, otherwise `false`.
	 * @throws {RefCorruptError|VersionControlOwnershipError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when the row is invalid, belongs to another repository, or cannot be deleted.
	 */
	async delete(
		repoId: string,
		refId: string,
		transaction?: ArcadiaTransaction<'readwrite'>
	): Promise<boolean> {
		log.trace('delete enter', { repoId, refId });

		let deleted: boolean;
		try {
			deleted = await withTransaction(
				await getDatabase(),
				['refs'],
				'readwrite',
				transaction,
				async (tx) => {
					const store = tx.objectStore('refs');
					const storedRow: unknown = await store.get(refId);
					if (storedRow === undefined) return false;

					const ref = parseRef(storedRow, repoId, refId);
					assertRefOwnership(ref, repoId);
					await store.delete(refId);
					return true;
				}
			);
		} catch (cause: unknown) {
			throwVersionControlDatabaseFailure(log, 'ref', 'delete', refId, repoId, cause);
		}

		if (!deleted) return false;
		log.debug('reference deleted', { repoId, refId });
		return true;
	}
}

/** Validates a reference row read from IndexedDB. */
function parseRef(storedRow: unknown, repoId: string, refId: string): DbRef {
	const parsed = v.safeParse(DbRefSchema, storedRow);
	if (!parsed.success) {
		const error = new RefCorruptError(refId, repoId, parsed.issues);
		log.error('corrupt reference row', { err: error, repoId, refId });
		throw error;
	}
	return parsed.output;
}

/** Ensures the reference belongs to the requested repository. */
function assertRefOwnership(ref: DbRef, repoId: string): void {
	if (ref.repoId !== repoId) {
		throw reportVersionControlOwnershipFailure(log, 'ref', ref.id, repoId, ref.repoId);
	}
}
