/** Persists and validates immutable version-control commits in IndexedDB.
 *
 * Commits are scoped to a repository and cannot be updated. Reads validate stored rows and verify
 * repository ownership; deleting a commit does not collect its descendants or alternates.
 *
 * @example
 * ```ts
 * import { CommitRepo } from '#lib/data';
 *
 * const commitRepo = new CommitRepo();
 * const commit = await commitRepo.get('repo-123', 'commit-456');
 * ```
 */

import * as v from 'valibot';

import { getDatabase, withTransaction, type ArcadiaTransaction } from '#lib/db';
import { AppError } from '#lib/error';
import { getLogger } from '#lib/logger';
import { CommitSchema } from '#lib/model';

import {
	reportVersionControlOwnershipFailure,
	throwVersionControlDatabaseFailure
} from './version-control-errors';

/** Validates a commit row persisted in IndexedDB. */
export const DbCommitSchema = CommitSchema;

/** Validates fields accepted when creating a commit. */
export const CreateDbCommitParamSchema = v.omit(DbCommitSchema, ['id', 'repoId', 'createdAt']);

/** A validated commit row as persisted in IndexedDB. */
export type DbCommit = v.InferOutput<typeof DbCommitSchema>;

/** Fields required to create a commit. */
export type CreateDbCommitParam = v.InferOutput<typeof CreateDbCommitParamSchema>;

/** Logger scoped to commit persistence and validation. */
const log = getLogger('data/commit');

/** Indicates that a persisted commit row does not match its schema. */
export class CommitCorruptError extends AppError {
	readonly kind = 'commit_corrupt';
	readonly commitId: string;
	readonly repoId: string;
	readonly issues: readonly v.InferIssue<typeof DbCommitSchema>[];

	/** Creates an error describing an invalid persisted commit row. */
	constructor(
		commitId: string,
		repoId: string,
		issues: readonly v.InferIssue<typeof DbCommitSchema>[]
	) {
		super(`Persisted commit is invalid: ${commitId}`);
		this.commitId = commitId;
		this.repoId = repoId;
		this.issues = issues;
	}
}

/** Provides validated create, read, and delete operations for immutable commits. */
export class CommitRepo {
	/**
	 * Creates an immutable commit in a repository.
	 *
	 * @param repoId - The owning repository ID.
	 * @param commitId - The ID assigned to the commit.
	 * @param createCommitParam - The commit ancestry and tagged payload to persist.
	 * @param transaction - Optional caller-owned transaction spanning repository operations.
	 * @returns The created commit row.
	 * @throws {v.ValiError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when validation or the IndexedDB write fails.
	 */
	async create(
		repoId: string,
		commitId: string,
		createCommitParam: CreateDbCommitParam,
		transaction?: ArcadiaTransaction<'readwrite'>
	): Promise<DbCommit> {
		log.trace('create enter', { repoId, commitId });

		const input = v.parse(CreateDbCommitParamSchema, createCommitParam);
		const commit = v.parse(DbCommitSchema, {
			...input,
			id: commitId,
			repoId,
			createdAt: Date.now()
		});

		try {
			await withTransaction(
				await getDatabase(),
				['commits'],
				'readwrite',
				transaction,
				async (tx) => {
					await tx.objectStore('commits').add(commit);
				}
			);
		} catch (cause: unknown) {
			throwVersionControlDatabaseFailure(log, 'commit', 'create', commitId, repoId, cause);
		}

		log.debug('commit created', { repoId, commitId });
		return commit;
	}

	/**
	 * Gets one commit by ID within its owning repository.
	 *
	 * @param repoId - The expected owning repository ID.
	 * @param commitId - The commit ID to retrieve.
	 * @param transaction - Optional caller-owned transaction containing the commit store.
	 * @returns The validated commit, or `undefined` if it does not exist.
	 * @throws {CommitCorruptError|VersionControlOwnershipError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when the row is invalid, belongs to another repository, or cannot be read.
	 */
	async get(
		repoId: string,
		commitId: string,
		transaction?: ArcadiaTransaction
	): Promise<DbCommit | undefined> {
		log.trace('get enter', { repoId, commitId });

		let storedRow: unknown;
		try {
			storedRow = await withTransaction(
				await getDatabase(),
				['commits'],
				'readonly',
				transaction,
				async (tx) => tx.objectStore('commits').get(commitId)
			);
		} catch (cause: unknown) {
			throwVersionControlDatabaseFailure(log, 'commit', 'read', commitId, repoId, cause);
		}

		if (storedRow === undefined) return undefined;
		const commit = parseCommit(storedRow, repoId, commitId);
		assertCommitOwnership(commit, repoId);
		return commit;
	}

	/**
	 * Deletes one commit row without collecting descendants or alternates.
	 *
	 * The caller must ensure no ref or retained commit depends on this commit before deleting it.
	 * @param repoId - The expected owning repository ID.
	 * @param commitId - The commit ID to delete.
	 * @param transaction - Optional caller-owned transaction spanning repository operations.
	 * @returns `true` if a commit was deleted, otherwise `false`.
	 * @throws {CommitCorruptError|VersionControlOwnershipError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when the row is invalid, belongs to another repository, or cannot be deleted.
	 */
	async delete(
		repoId: string,
		commitId: string,
		transaction?: ArcadiaTransaction<'readwrite'>
	): Promise<boolean> {
		log.trace('delete enter', { repoId, commitId });

		let deleted: boolean;
		try {
			deleted = await withTransaction(
				await getDatabase(),
				['commits'],
				'readwrite',
				transaction,
				async (tx) => {
					const store = tx.objectStore('commits');
					const storedRow: unknown = await store.get(commitId);
					if (storedRow === undefined) return false;

					const commit = parseCommit(storedRow, repoId, commitId);
					assertCommitOwnership(commit, repoId);
					await store.delete(commitId);
					return true;
				}
			);
		} catch (cause: unknown) {
			throwVersionControlDatabaseFailure(log, 'commit', 'delete', commitId, repoId, cause);
		}

		if (!deleted) return false;
		log.debug('commit deleted', { repoId, commitId });
		return true;
	}
}

/** Validates a commit row read from IndexedDB. */
function parseCommit(storedRow: unknown, repoId: string, commitId: string): DbCommit {
	const parsed = v.safeParse(DbCommitSchema, storedRow);
	if (!parsed.success) {
		const error = new CommitCorruptError(commitId, repoId, parsed.issues);
		log.error('corrupt commit row', { err: error, repoId, commitId });
		throw error;
	}
	return parsed.output;
}

/** Ensures the commit belongs to the requested repository. */
function assertCommitOwnership(commit: DbCommit, repoId: string): void {
	if (commit.repoId !== repoId) {
		throw reportVersionControlOwnershipFailure(log, 'commit', commit.id, repoId, commit.repoId);
	}
}
