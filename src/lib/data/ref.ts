/** Persists and validates named repository references in IndexedDB.
 *
 * References point to commits within a repository. Reads validate stored rows, and mutations verify
 * that the addressed reference belongs to the requested repository before changing it.
 *
 * @example
 * ```ts
 * import { getDatabase } from '#lib/db';
 * import { RefRepo } from '#lib/data';
 *
 * const database = await getDatabase();
 * const refRepo = new RefRepo(database);
 * const mainRef = await refRepo.get('repo-123', 'ref-main');
 * ```
 */

import * as v from 'valibot';

import { withTransaction, type ArcadiaTransaction, type Database } from '#lib/db';
import { AppError } from '#lib/error';
import { getLogger } from '#lib/logger';
import { RefSchema, type Ref } from '#lib/model';

import {
	reportVersionControlOwnershipFailure,
	throwVersionControlDatabaseFailure
} from './version-control-errors';

/** Validates fields accepted when creating a reference. */
export const CreateDbRefParamSchema = v.omit(RefSchema, ['id', 'repoId', 'createdAt', 'updatedAt']);

/** Validates mutable reference fields. */
export const UpdateDbRefParamSchema = v.partial(
	v.omit(RefSchema, ['id', 'repoId', 'createdAt', 'updatedAt'])
);

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
	readonly issues: readonly v.InferIssue<typeof RefSchema>[];

	/** Creates an error describing an invalid persisted reference row. */
	constructor(refId: string, repoId: string, issues: readonly v.InferIssue<typeof RefSchema>[]) {
		super(`Persisted reference is invalid: ${refId}`);
		this.refId = refId;
		this.repoId = repoId;
		this.issues = issues;
	}
}

/** Provides validated create, read, and update operations for refs. */
export class RefRepo {
	private readonly _db: Database;

	/** Creates a reference repository backed by the supplied database connection. */
	constructor(database: Database) {
		this._db = database;
	}

	/**
	 * Creates a named reference with a generated UUID.
	 *
	 * @param repoId - The owning repository ID.
	 * @param createRefParam - The reference name and target commit ID.
	 * @param transaction - Optional caller-owned transaction spanning repository operations.
	 * @returns The created reference row.
	 * @throws {v.ValiError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when validation or the IndexedDB write fails.
	 */
	async create(
		repoId: string,
		createRefParam: CreateDbRefParam,
		transaction?: ArcadiaTransaction<'readwrite'>
	): Promise<Ref> {
		log.trace('create enter', { repoId });

		const input = v.parse(CreateDbRefParamSchema, createRefParam);
		const refId = crypto.randomUUID();
		const now = Date.now();
		const ref = v.parse(RefSchema, {
			...input,
			id: refId,
			repoId,
			createdAt: now,
			updatedAt: now
		});

		try {
			await withTransaction(this._db, ['refs'], 'readwrite', transaction, async (tx) => {
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
	): Promise<Ref | undefined> {
		log.trace('get enter', { repoId, refId });

		let storedRow: unknown;
		try {
			storedRow = await withTransaction(this._db, ['refs'], 'readonly', transaction, async (tx) =>
				tx.objectStore('refs').get(refId)
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
	 * Gets all references in a repository, validating rows and sorting by name.
	 *
	 * @param repoId - The owning repository ID.
	 * @param transaction - Optional caller-owned transaction containing the reference store.
	 * @returns The repository's validated references in case-insensitive name order.
	 * @throws {RefCorruptError|VersionControlOwnershipError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when a row is invalid, belongs to another repository, or cannot be read.
	 */
	async getAllByRepo(repoId: string, transaction?: ArcadiaTransaction): Promise<Ref[]> {
		log.trace('getAllByRepo enter', { repoId });

		let refs: Ref[];
		try {
			refs = await withTransaction(this._db, ['refs'], 'readonly', transaction, async (tx) => {
				const refs: Ref[] = [];
				let cursor = await tx.objectStore('refs').index('by-repo').openCursor(repoId);
				while (cursor !== null) {
					const ref = parseRef(cursor.value, repoId, cursor.primaryKey);
					assertRefOwnership(ref, repoId);
					refs.push(ref);
					cursor = await cursor.continue();
				}
				return refs;
			});
		} catch (cause: unknown) {
			throwVersionControlDatabaseFailure(log, 'ref', 'read', repoId, repoId, cause);
		}

		return refs.sort(
			(left, right) =>
				left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) ||
				left.id.localeCompare(right.id)
		);
	}

	/**
	 * Updates a reference's name or target commit.
	 *
	 * @param repoId - The expected owning repository ID.
	 * @param refId - The reference ID to update.
	 * @param updateRefParam - The mutable reference fields to apply.
	 * @param transaction - Optional caller-owned transaction spanning repository operations.
	 * @param validateUpdate - Optional service-level invariant check run in the transaction before writing; it must not await non-IndexedDB work.
	 * @returns The updated reference, or `undefined` if it does not exist.
	 * @throws {AppError|v.ValiError} when validation or persistence fails.
	 */
	async update(
		repoId: string,
		refId: string,
		updateRefParam: UpdateDbRefParam,
		transaction?: ArcadiaTransaction<'readwrite'>,
		validateUpdate?: (
			currentRef: Ref,
			transaction: ArcadiaTransaction<'readwrite'>
		) => Promise<void>
	): Promise<Ref | undefined> {
		log.trace('update enter', { repoId, refId });

		const input = v.parse(UpdateDbRefParamSchema, updateRefParam);
		let updated: Ref | undefined;
		try {
			updated = await withTransaction(this._db, ['refs'], 'readwrite', transaction, async (tx) => {
				const store = tx.objectStore('refs');
				const storedRow: unknown = await store.get(refId);
				if (storedRow === undefined) return undefined;

				const currentRef = parseRef(storedRow, repoId, refId);
				assertRefOwnership(currentRef, repoId);
				await validateUpdate?.(currentRef, tx);
				const updatedRef = v.parse(RefSchema, {
					...currentRef,
					...input,
					updatedAt: Date.now()
				});
				await store.put(updatedRef);
				return updatedRef;
			});
		} catch (cause: unknown) {
			throwVersionControlDatabaseFailure(log, 'ref', 'update', refId, repoId, cause);
		}

		if (updated === undefined) return undefined;
		log.debug('reference updated', { repoId, refId });
		return updated;
	}
}

/** Validates a reference row read from IndexedDB. */
function parseRef(storedRow: unknown, repoId: string, refId: string): Ref {
	const parsed = v.safeParse(RefSchema, storedRow);
	if (!parsed.success) {
		const error = new RefCorruptError(refId, repoId, parsed.issues);
		log.error('corrupt reference row', { err: error, repoId, refId });
		throw error;
	}
	return parsed.output;
}

/** Ensures the reference belongs to the requested repository. */
function assertRefOwnership(ref: Ref, repoId: string): void {
	if (ref.repoId !== repoId) {
		throw reportVersionControlOwnershipFailure(log, ref.id, repoId, ref.repoId);
	}
}
