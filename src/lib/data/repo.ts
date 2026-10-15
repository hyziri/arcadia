/** Persists and validates version-control repositories in IndexedDB.
 *
 * Repository rows identify the version-control resource kind. Create, read, and delete operations
 * validate inputs and stored rows, and can participate in caller-owned transactions.
 *
 * @example
 * ```ts
 * import { RepoRepo } from '#lib/data';
 *
 * const repoRepo = new RepoRepo();
 * const repository = await repoRepo.get('repo-123');
 * ```
 */

import * as v from 'valibot';

import { getDatabase, withTransaction, type ArcadiaTransaction } from '#lib/db';
import { AppError } from '#lib/error';
import { getLogger } from '#lib/logger';
import { RepoKindSchema, RepoSchema, type RepoKind } from '#lib/model';

import { throwVersionControlDatabaseFailure } from './version-control-errors';

/** Validates a repository row persisted in IndexedDB. */
export const DbRepoSchema = RepoSchema;

/** A validated repository row as persisted in IndexedDB. */
export type DbRepo = v.InferOutput<typeof DbRepoSchema>;

/** Logger scoped to repository persistence and validation. */
const log = getLogger('data/repo');

/** Indicates that a persisted repository row does not match its schema. */
export class RepoCorruptError extends AppError {
	readonly kind = 'repo_corrupt';
	readonly repoId: string;
	readonly issues: readonly v.InferIssue<typeof DbRepoSchema>[];

	/** Creates an error describing an invalid persisted repository row. */
	constructor(repoId: string, issues: readonly v.InferIssue<typeof DbRepoSchema>[]) {
		super(`Persisted repository is invalid: ${repoId}`);
		this.repoId = repoId;
		this.issues = issues;
	}
}

/** Provides validated create, read, and delete operations for repositories. */
export class RepoRepo {
	/**
	 * Creates a repository with the supplied ID.
	 *
	 * @param repoId - The ID assigned to the repository.
	 * @param repoKind - The kind of data grouped by the repository.
	 * @param transaction - Optional caller-owned transaction spanning repository operations.
	 * @returns The created repository row.
	 * @throws {v.ValiError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when validation or persistence fails.
	 */
	async create(
		repoId: string,
		repoKind: RepoKind,
		transaction?: ArcadiaTransaction<'readwrite'>
	): Promise<DbRepo> {
		log.trace('create enter', { repoId });

		const kind = v.parse(RepoKindSchema, repoKind);
		const repo = v.parse(DbRepoSchema, { id: repoId, kind, createdAt: Date.now() });

		try {
			await withTransaction(
				await getDatabase(),
				['repos'],
				'readwrite',
				transaction,
				async (tx) => {
					await tx.objectStore('repos').add(repo);
				}
			);
		} catch (cause: unknown) {
			throwVersionControlDatabaseFailure(log, 'repo', 'create', repoId, undefined, cause);
		}

		log.debug('repository created', { repoId });
		return repo;
	}

	/**
	 * Gets one repository by ID.
	 *
	 * @param repoId - The repository ID to retrieve.
	 * @param transaction - Optional caller-owned transaction containing the repository store.
	 * @returns The validated repository, or `undefined` if it does not exist.
	 * @throws {RepoCorruptError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when the row is corrupt or the IndexedDB read fails.
	 */
	async get(repoId: string, transaction?: ArcadiaTransaction): Promise<DbRepo | undefined> {
		log.trace('get enter', { repoId });

		let storedRow: unknown;
		try {
			storedRow = await withTransaction(
				await getDatabase(),
				['repos'],
				'readonly',
				transaction,
				async (tx) => tx.objectStore('repos').get(repoId)
			);
		} catch (cause: unknown) {
			throwVersionControlDatabaseFailure(log, 'repo', 'read', repoId, undefined, cause);
		}

		if (storedRow === undefined) return undefined;
		return parseRepo(storedRow, repoId);
	}

	/**
	 * Deletes a repository row without cascading into refs or commits.
	 *
	 * @param repoId - The repository ID to delete.
	 * @param transaction - Optional caller-owned transaction spanning repository operations.
	 * @returns A promise that resolves when the row is deleted.
	 * @throws {VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when the IndexedDB write fails.
	 */
	async delete(repoId: string, transaction?: ArcadiaTransaction<'readwrite'>): Promise<void> {
		log.trace('delete enter', { repoId });

		try {
			await withTransaction(
				await getDatabase(),
				['repos'],
				'readwrite',
				transaction,
				async (tx) => {
					await tx.objectStore('repos').delete(repoId);
				}
			);
		} catch (cause: unknown) {
			throwVersionControlDatabaseFailure(log, 'repo', 'delete', repoId, undefined, cause);
		}

		log.debug('repository deleted', { repoId });
	}
}

/** Validates a repository row read from IndexedDB. */
function parseRepo(storedRow: unknown, repoId: string): DbRepo {
	const parsed = v.safeParse(DbRepoSchema, storedRow);
	if (!parsed.success) {
		const error = new RepoCorruptError(repoId, parsed.issues);
		log.error('corrupt repository row', { err: error, repoId });
		throw error;
	}
	return parsed.output;
}
