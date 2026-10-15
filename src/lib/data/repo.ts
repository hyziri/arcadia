/** Persists and validates version-control repositories in IndexedDB.
 *
 * Repository rows identify the version-control resource kind. Create and read operations validate
 * inputs and stored rows, and can participate in caller-owned transactions. Deletion is unavailable
 * while repositories may own refs and commits.
 *
 * @example
 * ```ts
 * import { getDatabase } from '#lib/db';
 * import { RepoRepo } from '#lib/data';
 *
 * const database = await getDatabase();
 * const repoRepo = new RepoRepo(database);
 * const repository = await repoRepo.get('repo-123');
 * ```
 */

import * as v from 'valibot';

import { withTransaction, type ArcadiaTransaction, type Database } from '#lib/db';
import { AppError } from '#lib/error';
import { getLogger } from '#lib/logger';
import { RepoKindSchema, RepoSchema, type Repo, type RepoKind } from '#lib/model';

import { throwVersionControlDatabaseFailure } from './version-control-errors';

/** Logger scoped to repository persistence and validation. */
const log = getLogger('data/repo');

/** Indicates that a persisted repository row does not match its schema. */
export class RepoCorruptError extends AppError {
	readonly kind = 'repo_corrupt';
	readonly repoId: string;
	readonly issues: readonly v.InferIssue<typeof RepoSchema>[];

	/** Creates an error describing an invalid persisted repository row. */
	constructor(repoId: string, issues: readonly v.InferIssue<typeof RepoSchema>[]) {
		super(`Persisted repository is invalid: ${repoId}`);
		this.repoId = repoId;
		this.issues = issues;
	}
}

/** Provides validated create and read operations for repositories. */
export class RepoRepo {
	private readonly _db: Database;

	/** Creates a repository backed by the supplied database connection. */
	constructor(database: Database) {
		this._db = database;
	}

	/**
	 * Creates a repository and generates its ID.
	 *
	 * @param repoKind - The kind of data grouped by the repository.
	 * @param transaction - Optional caller-owned transaction spanning repository operations.
	 * @returns The created repository row.
	 * @throws {v.ValiError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when validation or persistence fails.
	 */
	async create(repoKind: RepoKind, transaction?: ArcadiaTransaction<'readwrite'>): Promise<Repo> {
		log.trace('create enter');

		const kind = v.parse(RepoKindSchema, repoKind);
		const repoId = crypto.randomUUID();
		const repo = v.parse(RepoSchema, { id: repoId, kind, createdAt: Date.now() });

		try {
			await withTransaction(this._db, ['repos'], 'readwrite', transaction, async (tx) => {
				await tx.objectStore('repos').add(repo);
			});
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
	async get(repoId: string, transaction?: ArcadiaTransaction): Promise<Repo | undefined> {
		log.trace('get enter', { repoId });

		let storedRow: unknown;
		try {
			storedRow = await withTransaction(this._db, ['repos'], 'readonly', transaction, async (tx) =>
				tx.objectStore('repos').get(repoId)
			);
		} catch (cause: unknown) {
			throwVersionControlDatabaseFailure(log, 'repo', 'read', repoId, undefined, cause);
		}

		if (storedRow === undefined) return undefined;
		return parseRepo(storedRow, repoId);
	}

	/**
	 * Deletes a previously validated repository within a caller-owned multi-store transaction.
	 *
	 * @param repository - The repository validated in the active transaction.
	 * @param transaction - The transaction that also removes refs and enqueues collection.
	 * @returns `true` after the repository is deleted.
	 * @throws {VersionControlDatabaseError} when deletion fails.
	 */
	protected async _delete(
		repository: Repo,
		transaction: ArcadiaTransaction<'readwrite'>
	): Promise<boolean> {
		log.trace('delete enter', { repoId: repository.id });
		try {
			await transaction.objectStore('repos').delete(repository.id);
		} catch (cause: unknown) {
			throwVersionControlDatabaseFailure(log, 'repo', 'delete', repository.id, undefined, cause);
		}

		log.debug('repository row deleted', { repoId: repository.id });
		return true;
	}
}

/** Validates a repository row read from IndexedDB. */
function parseRepo(storedRow: unknown, repoId: string): Repo {
	const parsed = v.safeParse(RepoSchema, storedRow);
	if (!parsed.success) {
		const error = new RepoCorruptError(repoId, parsed.issues);
		log.error('corrupt repository row', { err: error, repoId });
		throw error;
	}
	return parsed.output;
}
