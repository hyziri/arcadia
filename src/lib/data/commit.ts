/** Persists and validates immutable version-control commits in IndexedDB.
 *
 * Commits are immutable, content-addressed objects shared across repositories. Reads validate stored
 * rows globally. Deletion is unavailable until dependent commits and refs can be collected safely.
 *
 * @example
 * ```ts
 * import { getDatabase } from '#lib/db';
 * import { CommitRepo } from '#lib/data';
 *
 * const database = await getDatabase();
 * const commitRepo = new CommitRepo(database);
 * const commit = await commitRepo.get('commit-456');
 * ```
 */

import * as v from 'valibot';

import { withTransaction, type ArcadiaTransaction, type Database } from '#lib/db';
import { AppError } from '#lib/error';
import { getLogger } from '#lib/logger';
import { CommitSchema, type Commit } from '#lib/model';

import { throwVersionControlDatabaseFailure } from './version-control-errors';

/** Validates fields accepted when creating a commit. */
export const CreateDbCommitParamSchema = v.omit(CommitSchema, ['id', 'repoId', 'createdAt']);

/** Fields required to create a commit. */
export type CreateDbCommitParam = v.InferOutput<typeof CreateDbCommitParamSchema>;

/** Logger scoped to commit persistence and validation. */
const log = getLogger('data/commit');

/** Indicates that a persisted commit row does not match its schema. */
export class CommitCorruptError extends AppError {
	readonly kind = 'commit_corrupt';
	readonly commitId: string;
	readonly issues: readonly v.InferIssue<typeof CommitSchema>[];

	/** Creates an error describing an invalid persisted commit row. */
	constructor(commitId: string, issues: readonly v.InferIssue<typeof CommitSchema>[]) {
		super(`Persisted commit is invalid: ${commitId}`);
		this.commitId = commitId;
		this.issues = issues;
	}
}

/** Provides validated create and read operations for immutable commits. */
export class CommitRepo {
	private readonly _db: Database;

	/** Creates a commit repository backed by the supplied database connection. */
	constructor(database: Database) {
		this._db = database;
	}

	/**
	 * Creates an immutable commit object.
	 *
	 * @param commitId - The content-addressed ID assigned to the commit.
	 * @param createCommitParam - The commit ancestry and tagged payload to persist.
	 * @param transaction - Optional caller-owned transaction spanning repository operations.
	 * @returns The created commit row.
	 * @throws {v.ValiError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when validation or the IndexedDB write fails.
	 */
	async create(
		commitId: string,
		createCommitParam: CreateDbCommitParam,
		transaction?: ArcadiaTransaction<'readwrite'>
	): Promise<Commit> {
		log.trace('create enter', { commitId });

		const input = v.parse(CreateDbCommitParamSchema, createCommitParam);
		const commit = v.parse(CommitSchema, {
			...input,
			id: commitId,
			createdAt: Date.now()
		});

		try {
			await withTransaction(this._db, ['commits'], 'readwrite', transaction, async (tx) => {
				await tx.objectStore('commits').add(commit);
			});
		} catch (cause: unknown) {
			throwVersionControlDatabaseFailure(log, 'commit', 'create', commitId, undefined, cause);
		}

		log.debug('commit created', { commitId });
		return commit;
	}

	/**
	 * Gets one shared commit by ID.
	 *
	 * @param commitId - The content-addressed commit ID to retrieve.
	 * @param transaction - Optional caller-owned transaction containing the commit store.
	 * @returns The validated commit, or `undefined` if it does not exist.
	 * @throws {CommitCorruptError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when the row is invalid or cannot be read.
	 */
	async get(commitId: string, transaction?: ArcadiaTransaction): Promise<Commit | undefined> {
		log.trace('get enter', { commitId });

		let storedRow: unknown;
		try {
			storedRow = await withTransaction(
				this._db,
				['commits'],
				'readonly',
				transaction,
				async (tx) => tx.objectStore('commits').get(commitId)
			);
		} catch (cause: unknown) {
			throwVersionControlDatabaseFailure(log, 'commit', 'read', commitId, undefined, cause);
		}

		if (storedRow === undefined) return undefined;
		return parseCommit(storedRow, commitId);
	}
}

/** Validates a commit row read from IndexedDB. */
function parseCommit(storedRow: unknown, commitId: string): Commit {
	const parsed = v.safeParse(CommitSchema, storedRow);
	if (!parsed.success) {
		const error = new CommitCorruptError(commitId, parsed.issues);
		log.error('corrupt commit row', { err: error, commitId });
		throw error;
	}
	return parsed.output;
}
