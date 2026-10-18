/** Persists repository-scoped availability links for globally shared alternate commits. */

import * as v from 'valibot';

import { withTransaction, type ArcadiaTransaction, type Database } from '#lib/db';
import { AppError } from '#lib/error';
import { getLogger } from '#lib/logger';
import { RepoAlternateSchema, type RepoAlternate } from '#lib/model';

import { throwVersionControlDatabaseFailure } from './version-control-errors';

/** Validates fields accepted when creating repository alternate membership. */
export const CreateDbRepoAlternateParamSchema = v.omit(RepoAlternateSchema, ['repoId']);

/** Repository alternate fields supplied to persistence operations. */
export type CreateDbRepoAlternateParam = v.InferOutput<typeof CreateDbRepoAlternateParamSchema>;

/** Logger scoped to repository-alternate persistence and validation. */
const log = getLogger('data/version-control/repo-alternate');

/** Indicates that a persisted repository-alternate row is invalid or inconsistent with its index. */
export class RepoAlternateCorruptError extends AppError {
	readonly kind = 'repo_alternate_corrupt';
	readonly repoId: string | undefined;
	readonly alternateCommitId: string | undefined;
	readonly issues: readonly v.BaseIssue<unknown>[];

	/** Creates an error describing an invalid persisted repository-alternate row. */
	constructor(
		repoId: string | undefined,
		alternateCommitId: string | undefined,
		issues: readonly v.BaseIssue<unknown>[]
	) {
		super(
			repoId === undefined || alternateCommitId === undefined
				? 'Persisted repository-alternate row is invalid'
				: `Persisted repository-alternate row is invalid: ${repoId}:${alternateCommitId}`
		);
		this.repoId = repoId;
		this.alternateCommitId = alternateCommitId;
		this.issues = issues;
	}
}

/** Provides validated create, read, and delete operations for repository alternate links. */
export class RepoAlternateRepo {
	private readonly _db: Database;

	/** Creates a repository-alternate repository backed by the supplied database connection. */
	constructor(database: Database) {
		this._db = database;
	}

	/** Creates or confirms one repository-scoped alternate link.
	 *
	 * @param repoId - The repository in which the alternate is available.
	 * @param createRepoAlternateParam - The base and alternate commit IDs to link.
	 * @param transaction - Optional caller-owned transaction spanning related stores.
	 * @returns The validated repository-alternate link.
	 * @throws {v.ValiError|RepoAlternateCorruptError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when validation or persistence fails.
	 */
	async create(
		repoId: string,
		createRepoAlternateParam: CreateDbRepoAlternateParam,
		transaction?: ArcadiaTransaction<'readwrite'>
	): Promise<RepoAlternate> {
		const [repoAlternate] = await this.createMany(repoId, [createRepoAlternateParam], transaction);
		return repoAlternate;
	}

	/** Creates or confirms repository-scoped links in one transaction.
	 *
	 * @param repoId - The repository in which the alternates are available.
	 * @param createRepoAlternateParams - The base and alternate commit IDs to link.
	 * @param transaction - Optional caller-owned transaction spanning related stores.
	 * @returns The validated repository-alternate links.
	 * @throws {v.ValiError|RepoAlternateCorruptError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when validation or persistence fails.
	 */
	async createMany(
		repoId: string,
		createRepoAlternateParams: readonly CreateDbRepoAlternateParam[],
		transaction?: ArcadiaTransaction<'readwrite'>
	): Promise<RepoAlternate[]> {
		const repoAlternates = createRepoAlternateParams.map((createParam) =>
			v.parse(RepoAlternateSchema, {
				repoId,
				...v.parse(CreateDbRepoAlternateParamSchema, createParam)
			})
		);
		if (repoAlternates.length === 0) return [];

		try {
			await withTransaction(this._db, ['repoAlternates'], 'readwrite', transaction, async (tx) => {
				const store = tx.objectStore('repoAlternates');
				await Promise.all(repoAlternates.map((repoAlternate) => store.put(repoAlternate)));
			});
		} catch (cause: unknown) {
			throwVersionControlDatabaseFailure(
				log,
				'repo-alternate',
				'create',
				`${repoId}:${repoAlternates.length}`,
				repoId,
				cause
			);
		}

		return repoAlternates;
	}

	/** Gets all alternate links belonging to a repository.
	 *
	 * @param repoId - The repository whose alternate links are requested.
	 * @param transaction - Optional caller-owned transaction containing the repository-alternate store.
	 * @returns The validated links for that repository.
	 * @throws {RepoAlternateCorruptError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when a row is invalid or the read fails.
	 */
	async getAllByRepo(repoId: string, transaction?: ArcadiaTransaction): Promise<RepoAlternate[]> {
		try {
			return await withTransaction(
				this._db,
				['repoAlternates'],
				'readonly',
				transaction,
				async (tx) => {
					const rows: RepoAlternate[] = [];
					let cursor = await tx
						.objectStore('repoAlternates')
						.index('by-repo')
						.openCursor(IDBKeyRange.only(repoId));
					while (cursor !== null) {
						rows.push(parseRepoAlternate(cursor.value, repoId));
						cursor = await cursor.continue();
					}
					return rows;
				}
			);
		} catch (cause: unknown) {
			throwVersionControlDatabaseFailure(log, 'repo-alternate', 'read', repoId, repoId, cause);
		}
	}

	/** Gets links for one base commit within one repository.
	 *
	 * @param repoId - The repository whose alternate links are requested.
	 * @param alternateOfCommitId - The commit whose alternatives are requested.
	 * @param transaction - Optional caller-owned transaction containing the repository-alternate store.
	 * @returns The validated alternate links for the base commit.
	 * @throws {RepoAlternateCorruptError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when a row is invalid or the read fails.
	 */
	async getAllByAlternateOf(
		repoId: string,
		alternateOfCommitId: string,
		transaction?: ArcadiaTransaction
	): Promise<RepoAlternate[]> {
		try {
			return await withTransaction(
				this._db,
				['repoAlternates'],
				'readonly',
				transaction,
				async (tx) => {
					const rows: RepoAlternate[] = [];
					let cursor = await tx
						.objectStore('repoAlternates')
						.index('by-repo-alternate-of')
						.openCursor(IDBKeyRange.only([repoId, alternateOfCommitId]));
					while (cursor !== null) {
						rows.push(parseRepoAlternate(cursor.value, repoId, alternateOfCommitId));
						cursor = await cursor.continue();
					}
					return rows;
				}
			);
		} catch (cause: unknown) {
			throwVersionControlDatabaseFailure(
				log,
				'repo-alternate',
				'read',
				`${repoId}:${alternateOfCommitId}`,
				repoId,
				cause
			);
		}
	}

	/** Counts live repository memberships for one alternate commit.
	 *
	 * @param alternateCommitId - The alternate commit whose memberships are counted.
	 * @param transaction - Optional caller-owned transaction containing the repository-alternate store.
	 * @returns The validated membership count.
	 * @throws {RepoAlternateCorruptError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when a row is invalid or the read fails.
	 */
	async countByAlternateCommit(
		alternateCommitId: string,
		transaction?: ArcadiaTransaction
	): Promise<number> {
		try {
			return await withTransaction(
				this._db,
				['repoAlternates'],
				'readonly',
				transaction,
				async (tx) => {
					let count = 0;
					let cursor = await tx
						.objectStore('repoAlternates')
						.index('by-alternate-commit')
						.openCursor(IDBKeyRange.only(alternateCommitId));
					while (cursor !== null) {
						parseRepoAlternate(cursor.value, undefined, undefined, alternateCommitId);
						count += 1;
						cursor = await cursor.continue();
					}
					return count;
				}
			);
		} catch (cause: unknown) {
			throwVersionControlDatabaseFailure(
				log,
				'repo-alternate',
				'read',
				alternateCommitId,
				undefined,
				cause
			);
		}
	}

	/** Removes all alternate links owned by a repository.
	 *
	 * @param repoId - The repository whose alternate links are removed.
	 * @param transaction - The caller-owned transaction that also queues their commit roots for collection.
	 * @returns The validated links removed from the repository.
	 * @throws {RepoAlternateCorruptError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when a row is invalid or deletion fails.
	 */
	async deleteAllByRepo(
		repoId: string,
		transaction: ArcadiaTransaction<'readwrite'>
	): Promise<RepoAlternate[]> {
		try {
			return await withTransaction(
				this._db,
				['repoAlternates'],
				'readwrite',
				transaction,
				async (tx) => {
					const rows: RepoAlternate[] = [];
					let cursor = await tx
						.objectStore('repoAlternates')
						.index('by-repo')
						.openCursor(IDBKeyRange.only(repoId));
					while (cursor !== null) {
						rows.push(parseRepoAlternate(cursor.value, repoId));
						await cursor.delete();
						cursor = await cursor.continue();
					}
					return rows;
				}
			);
		} catch (cause: unknown) {
			throwVersionControlDatabaseFailure(log, 'repo-alternate', 'delete', repoId, repoId, cause);
		}
	}
}

/** Validates a repository-alternate row read from IndexedDB. */
function parseRepoAlternate(
	storedRow: unknown,
	expectedRepoId?: string,
	expectedAlternateOfCommitId?: string,
	expectedAlternateCommitId?: string
): RepoAlternate {
	const parsed = v.safeParse(RepoAlternateSchema, storedRow);
	if (!parsed.success) return throwRepoAlternateCorrupt(storedRow, parsed.issues);

	if (expectedRepoId !== undefined && parsed.output.repoId !== expectedRepoId) {
		const identity = v.safeParse(v.object({ repoId: v.literal(expectedRepoId) }), parsed.output);
		if (!identity.success) return throwRepoAlternateCorrupt(storedRow, identity.issues);
	}
	if (
		expectedAlternateOfCommitId !== undefined &&
		parsed.output.alternateOfCommitId !== expectedAlternateOfCommitId
	) {
		const identity = v.safeParse(
			v.object({ alternateOfCommitId: v.literal(expectedAlternateOfCommitId) }),
			parsed.output
		);
		if (!identity.success) return throwRepoAlternateCorrupt(storedRow, identity.issues);
	}
	if (
		expectedAlternateCommitId !== undefined &&
		parsed.output.alternateCommitId !== expectedAlternateCommitId
	) {
		const identity = v.safeParse(
			v.object({ alternateCommitId: v.literal(expectedAlternateCommitId) }),
			parsed.output
		);
		if (!identity.success) return throwRepoAlternateCorrupt(storedRow, identity.issues);
	}

	return parsed.output;
}

/** Logs and throws a corruption error for an invalid repository-alternate row. */
function throwRepoAlternateCorrupt(
	storedRow: unknown,
	issues: readonly v.BaseIssue<unknown>[]
): never {
	const repoId = getStringField(storedRow, 'repoId');
	const alternateCommitId = getStringField(storedRow, 'alternateCommitId');
	const error = new RepoAlternateCorruptError(repoId, alternateCommitId, issues);
	log.error('corrupt repository-alternate row', {
		err: error,
		...(repoId === undefined ? {} : { repoId }),
		...(alternateCommitId === undefined ? {} : { alternateCommitId })
	});
	throw error;
}

/** Reads a string field from an unknown persisted row for corruption diagnostics. */
function getStringField(value: unknown, field: string): string | undefined {
	if (typeof value !== 'object' || value === null || !(field in value)) return undefined;
	const candidate = (value as Record<string, unknown>)[field];
	return typeof candidate === 'string' ? candidate : undefined;
}
