/** Coordinates content-addressed commit preparation and version-control persistence.
 *
 * Commit hashes are prepared before any IndexedDB transaction starts. Persistence methods accept
 * the prepared value and use the database connection supplied at construction, so caller-owned
 * transactions never wait for hashing or database initialization.
 *
 * @example
 * ```ts
 * import { appState } from '#lib/state';
 *
 * const database = await appState.initialize();
 * const versionControl = await appState.getVersionControlService();
 * const prepared = await versionControl.prepareCommit({
 * 	parentCommitId: null,
 * 	alternateOfCommitId: null,
 * 	data: { type: 'chat-message', message: { sender: 'user', content: 'Hello' } }
 * });
 * const transaction = database.transaction(['commits'], 'readwrite');
 * await versionControl.createCommit(prepared, transaction);
 * await transaction.done;
 * ```
 */

import * as v from 'valibot';

import {
	CommitRepo,
	CreateDbCommitParamSchema,
	CreateDbRefParamSchema,
	RefRepo,
	RepoAlternateRepo,
	RepoRepo,
	UpdateDbRefParamSchema,
	type CreateDbCommitParam,
	type UpdateDbRefParam
} from '#lib/data';
import { withTransaction, type ArcadiaTransaction, type Database } from '#lib/db';
import { AppError } from '#lib/error';
import { getLogger } from '#lib/logger';
import type { Commit, Ref, Repo, RepoAlternate, RepoKind } from '#lib/model';

import type { GarbageCollectionService } from './garbage-collection';
import {
	throwVersionControlDatabaseFailure,
	VersionControlResourceNotFoundError
} from '#lib/data/version-control/version-control-errors.ts';

const COMMIT_CONTENT_FORMAT = 'arcadia/version-control-commit/v2';
const log = getLogger('service/version-control');
const preparedCommits = new WeakSet<object>();

type DeepReadonly<T> = T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> } : T;
declare const preparedCommitBrand: unique symbol;
type PreparedCommitValue = {
	commitId: string;
	createCommitParam: CreateDbCommitParam;
};

/** Content-addressed commit data produced before opening an IndexedDB transaction. */
export type PreparedCommit = DeepReadonly<PreparedCommitValue> & {
	readonly [preparedCommitBrand]: true;
};

/** The new repository and copied refs returned when forking a repository. */
export interface ForkedRepository {
	readonly repository: Repo;
	readonly refs: readonly Ref[];
}

/** Indicates that a commit ID already exists with content different from its prepared content. */
export class VersionControlCommitConflictError extends AppError {
	readonly kind = 'version_control_commit_conflict';
	readonly commitId: string;

	/** Creates an error describing a content-addressed commit ID conflict. */
	constructor(commitId: string) {
		super(`Commit ID already exists with different content: ${commitId}`);
		this.commitId = commitId;
	}
}

/** Indicates that a commit is not in the parent history of a reference. */
export class VersionControlCommitNotOnRefHistoryError extends AppError {
	readonly kind = 'version_control_commit_not_on_ref_history';
	readonly repoId: string;
	readonly refId: string;
	readonly commitId: string;

	/** Creates an error identifying the ref history that excludes a commit. */
	constructor(repoId: string, refId: string, commitId: string) {
		super(`Commit ${commitId} is not in ref ${refId} history for repository ${repoId}`);
		this.repoId = repoId;
		this.refId = refId;
		this.commitId = commitId;
	}
}

/** Indicates that a reference's parent chain contains a cycle. */
export class VersionControlCommitAncestryCycleError extends AppError {
	readonly kind = 'version_control_commit_ancestry_cycle';
	readonly repoId: string;
	readonly refId: string;
	readonly commitId: string;

	/** Creates an error identifying a cycle in a ref's parent chain. */
	constructor(repoId: string, refId: string, commitId: string) {
		super(
			`Commit ancestry for ref ${refId} in repository ${repoId} contains a cycle at ${commitId}`
		);
		this.repoId = repoId;
		this.refId = refId;
		this.commitId = commitId;
	}
}

/** Indicates that a commit was not produced by `prepareCommit`. */
export class VersionControlCommitNotPreparedError extends AppError {
	readonly kind = 'version_control_commit_not_prepared';

	/** Creates an error describing a commit value that lacks a trusted prepared identity. */
	constructor() {
		super('Commit must be prepared by VersionControlService.prepareCommit before persistence');
	}
}

/** Indicates that content-addressed commit preparation failed. */
export class VersionControlCommitPreparationError extends AppError {
	readonly kind = 'version_control_commit_preparation';
	/** Creates an error describing a failure while hashing a commit. */
	constructor(options?: ErrorOptions) {
		super('Could not prepare a content-addressed commit', options);
	}
}

/** Indicates that a source repository's configured default ref was not among its refs. */
export class SourceRepoDefaultRefUnresolvedError extends AppError {
	readonly kind = 'default_ref_not_forked_for_repository';
	readonly sourceRepoId: string;
	readonly sourceDefaultRefId: string;
	readonly forkedRepoId: string;

	/** Creates an error identifying the source ref that could not be mapped into the fork. */
	constructor(sourceRepoId: string, sourceDefaultRefId: string, forkedRepoId: string) {
		super(
			`Default ref ${sourceDefaultRefId} from repo ${sourceRepoId} was not properly forked for ${forkedRepoId}`
		);
		this.sourceRepoId = sourceRepoId;
		this.sourceDefaultRefId = sourceDefaultRefId;
		this.forkedRepoId = forkedRepoId;
	}
}

/** Indicates that a repository-alternate link disagrees with the globally shared commit. */
export class VersionControlAlternateMembershipError extends AppError {
	readonly kind = 'version_control_alternate_membership_invalid';
	readonly repoId: string;
	readonly alternateOfCommitId: string;
	readonly alternateCommitId: string;

	/** Creates an error identifying an inconsistent repository-alternate link. */
	constructor(repoId: string, alternateOfCommitId: string, alternateCommitId: string) {
		super(
			`Alternate commit ${alternateCommitId} does not alternate ${alternateOfCommitId} in repo ${repoId}`
		);
		this.repoId = repoId;
		this.alternateOfCommitId = alternateOfCommitId;
		this.alternateCommitId = alternateCommitId;
	}
}

/** Exposes repository deletion only to the version-control orchestrator. */
class MutableRepoRepo extends RepoRepo {
	delete(repository: Repo, transaction: ArcadiaTransaction<'readwrite'>): Promise<boolean> {
		return this._delete(repository, transaction);
	}
}

/** Exposes ref deletion only to the version-control orchestrator. */
class MutableRefRepo extends RefRepo {
	updateValidated(
		ref: Ref,
		updateRefParam: UpdateDbRefParam,
		transaction: ArcadiaTransaction<'readwrite'>
	): Promise<Ref> {
		return this._update(ref, updateRefParam, transaction);
	}

	delete(ref: Ref, transaction: ArcadiaTransaction<'readwrite'>): Promise<boolean> {
		return this._delete(ref, transaction);
	}
}

/** Coordinates version-control repositories using an already-open database connection. */
export class VersionControlService {
	private readonly _db: Database;
	private readonly _repoRepo: MutableRepoRepo;
	private readonly _refRepo: MutableRefRepo;
	private readonly _repoAlternateRepo: RepoAlternateRepo;
	private readonly _commitRepo: CommitRepo;
	private readonly _garbageCollectionService: GarbageCollectionService;

	/** Creates a version-control service using the application-owned collector.
	 *
	 * @param database - The already-open application database.
	 * @param garbageCollectionService - The collector shared with application startup recovery.
	 */
	constructor(database: Database, garbageCollectionService: GarbageCollectionService) {
		this._db = database;
		this._repoRepo = new MutableRepoRepo(database);
		this._refRepo = new MutableRefRepo(database);
		this._repoAlternateRepo = new RepoAlternateRepo(database);
		this._commitRepo = new CommitRepo(database);
		this._garbageCollectionService = garbageCollectionService;
	}

	/**
	 * Creates a repository and lets the data layer generate its ID.
	 *
	 * @param repoKind - The kind of data grouped by the repository.
	 * @param transaction - Optional caller-owned transaction containing the repository store.
	 * @returns The created repository row.
	 * @throws {v.ValiError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when validation or persistence fails.
	 */
	async createRepository(
		repoKind: RepoKind,
		transaction?: ArcadiaTransaction<'readwrite'>
	): Promise<Repo> {
		log.trace('createRepository enter');
		return await this._repoRepo.create(repoKind, transaction);
	}

	/**
	 * Forks a repository by copying its refs and alternate visibility links while sharing immutable commits.
	 *
	 * @param sourceRepoId - The repository whose kind, refs, and alternate links should be copied.
	 * @param transaction - Optional caller-owned transaction spanning repositories, refs, commits, and alternate links.
	 * @returns The new repository and its generated refs.
	 * @throws {v.ValiError|VersionControlResourceNotFoundError|RepoCorruptError|RefCorruptError|RepoAlternateCorruptError|CommitCorruptError|VersionControlOwnershipError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when the source or linked data is invalid or persistence fails.
	 */
	async forkRepository(
		sourceRepoId: string,
		transaction?: ArcadiaTransaction<'readwrite'>
	): Promise<ForkedRepository> {
		log.trace('forkRepository enter', { sourceRepoId });

		return withTransaction(
			this._db,
			['repos', 'refs', 'commits', 'repoAlternates'],
			'readwrite',
			transaction,
			async (tx) => {
				const sourceRepository = await this.requireRepository(sourceRepoId, tx);
				const sourceRefs = await this._refRepo.getAllByRepo(sourceRepoId, tx);
				const sourceAlternates: RepoAlternate[] = await this._repoAlternateRepo.getAllByRepo(
					sourceRepoId,
					tx
				);
				const targetCommitIds = new Set(
					sourceRefs
						.map((ref) => ref.targetCommitId)
						.filter(
							(targetCommitId): targetCommitId is string => typeof targetCommitId === 'string'
						)
				);
				for (const targetCommitId of targetCommitIds) {
					await this.requireCommit(targetCommitId, tx);
				}

				let forkedRepo = await this._repoRepo.create(sourceRepository.kind, tx);
				await this._repoAlternateRepo.createMany(
					forkedRepo.id,
					sourceAlternates.map(({ alternateOfCommitId, alternateCommitId }) => ({
						alternateOfCommitId,
						alternateCommitId
					})),
					tx
				);
				const forkedRefs: Ref[] = [];
				let forkedDefaultRefId: string | undefined = undefined;
				for (const sourceRef of sourceRefs) {
					const forkedRef = await this._refRepo.create(
						forkedRepo.id,
						{ name: sourceRef.name, targetCommitId: sourceRef.targetCommitId },
						tx
					);

					if (sourceRepository.defaultRefId === sourceRef.id) {
						forkedDefaultRefId = forkedRef.id;
					}

					forkedRefs.push(forkedRef);
				}

				if (typeof sourceRepository.defaultRefId === 'string') {
					if (forkedDefaultRefId !== undefined) {
						forkedRepo = await this._repoRepo.setDefaultRef(forkedRepo.id, forkedDefaultRefId, tx);
					} else {
						const error = new SourceRepoDefaultRefUnresolvedError(
							sourceRepository.id,
							sourceRepository.defaultRefId,
							forkedRepo.id
						);
						log.error('Failed to fork repository', {
							err: error
						});
						throw error;
					}
				}

				return { repository: forkedRepo, refs: forkedRefs };
			}
		);
	}

	/**
	 * Gets one repository by ID.
	 *
	 * @param repoId - The repository ID to retrieve.
	 * @param transaction - Optional caller-owned transaction containing the repository store.
	 * @returns The repository, or `undefined` if it does not exist.
	 * @throws {RepoCorruptError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when the row is invalid or cannot be read.
	 */
	getRepository(repoId: string, transaction?: ArcadiaTransaction): Promise<Repo | undefined> {
		log.trace('getRepository enter', { repoId });
		return this._repoRepo.get(repoId, transaction);
	}

	/** Sets a repository's default ref after verifying the ref belongs to that repository.
	 *
	 * @param repoId - The repository whose default ref to update.
	 * @param refId - The ref to make the repository default.
	 * @param transaction - Optional caller-owned read-write transaction containing repos and refs.
	 * @returns The updated repository and validated ref.
	 * @throws {v.ValiError|VersionControlResourceNotFoundError|RepoCorruptError|RefCorruptError|VersionControlOwnershipError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when validation, resource lookup, ownership verification, or persistence fails.
	 */
	async setRepoDefaultRef(
		repoId: string,
		refId: string,
		transaction?: ArcadiaTransaction<'readwrite'>
	): Promise<{ repo: Repo; ref: Ref }> {
		log.trace('set repo default ref enter', { repoId, refId });

		try {
			return await withTransaction(
				this._db,
				['repos', 'refs'],
				'readwrite',
				transaction,
				async (tx) => {
					const ref = await this.requireRef(repoId, refId, tx);
					const repo = await this._repoRepo.setDefaultRef(repoId, refId, tx);

					return { repo, ref };
				}
			);
		} catch (cause: unknown) {
			throwVersionControlDatabaseFailure(log, 'repo', 'update', repoId, undefined, cause);
		}
	}

	/**
	 * Deletes a repository and atomically queues its ref and alternate targets for background collection.
	 *
	 * @param repoId - The repository to delete.
	 * @param transaction - Optional caller-owned transaction spanning repositories, refs, alternate links, and GC stores.
	 * @returns `true` if the repository existed and was queued for deletion, otherwise `false`.
	 * @throws {RepoCorruptError|RefCorruptError|RepoAlternateCorruptError|GarbageCollectionCorruptError|GarbageCollectionDatabaseError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when validation or persistence fails.
	 */
	async deleteRepository(
		repoId: string,
		transaction?: ArcadiaTransaction<'readwrite'>
	): Promise<boolean> {
		log.trace('deleteRepository enter', { repoId });
		const deleted = await withTransaction(
			this._db,
			['repos', 'refs', 'repoAlternates', 'garbageJobs', 'garbageJobItems'],
			'readwrite',
			transaction,
			async (tx) => {
				const repository = await this._repoRepo.get(repoId, tx);
				if (repository === undefined) return false;
				const refs = await this._refRepo.getAllByRepo(repoId, tx);
				const repoAlternates: RepoAlternate[] = await this._repoAlternateRepo.deleteAllByRepo(
					repoId,
					tx
				);

				const targetCommitIds = [
					...refs
						.map((ref) => ref.targetCommitId)
						.filter(
							(targetCommitId): targetCommitId is string => typeof targetCommitId === 'string'
						),
					...repoAlternates.map((alternate) => alternate.alternateCommitId)
				];
				if (targetCommitIds.length > 0) {
					await this._garbageCollectionService.enqueue(
						repoId,
						'repository-deleted',
						targetCommitIds,
						tx
					);
				}

				await Promise.all(refs.map((ref) => this._refRepo.delete(ref, tx)));
				await this._repoRepo.delete(repository, tx);
				return true;
			}
		);

		return deleted;
	}

	/**
	 * Validates and hashes a commit before a persistence transaction is opened.
	 *
	 * Commit payload fields and ancestry links are hashed; repository and generated storage metadata
	 * are excluded. Object keys are sorted before serialization for stable, cross-repository IDs.
	 *
	 * @param createCommitParam - The ancestry links and tagged commit payload.
	 * @returns An immutable prepared commit that can be persisted without further hashing.
	 * @throws {v.ValiError|VersionControlCommitPreparationError} when input validation or hashing fails.
	 */
	async prepareCommit(createCommitParam: CreateDbCommitParam): Promise<PreparedCommit> {
		log.trace('prepareCommit enter');

		const validatedParam = v.parse(CreateDbCommitParamSchema, createCommitParam);

		let digest: ArrayBuffer;
		try {
			const content = serializeCommitContent(validatedParam);
			digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
		} catch (cause: unknown) {
			const error = new VersionControlCommitPreparationError({ cause });
			log.error('content-addressed commit preparation failed', { err: error });
			throw error;
		}

		const commitId = `sha256:v2:${toHex(new Uint8Array(digest))}`;
		const preparedCommit = { commitId, createCommitParam: validatedParam };
		freezeRecursively(preparedCommit);
		preparedCommits.add(preparedCommit);

		log.debug('commit prepared', { commitId });
		return preparedCommit as PreparedCommit;
	}

	/**
	 * Persists a prepared commit and returns an existing identical commit when its ID is already stored.
	 *
	 * @param preparedCommit - The exact immutable object returned by `prepareCommit`; do not copy or serialize it.
	 * @param transaction - Optional caller-owned transaction containing the commit store.
	 * @returns The persisted commit, or the existing row when identical content was already stored.
	 * @throws {v.ValiError|VersionControlCommitNotPreparedError|VersionControlResourceNotFoundError|VersionControlCommitConflictError|CommitCorruptError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when validation, linked-resource checks, or persistence fails.
	 */
	createCommit(
		preparedCommit: PreparedCommit,
		transaction?: ArcadiaTransaction<'readwrite'>
	): Promise<Commit> {
		if (!preparedCommits.has(preparedCommit)) {
			const error = new VersionControlCommitNotPreparedError();
			log.error('attempted to persist an unprepared commit', { err: error });
			throw error;
		}

		log.trace('createCommit enter', { commitId: preparedCommit.commitId });
		return withTransaction(this._db, ['commits'], 'readwrite', transaction, async (tx) => {
			const existingCommit = await this._commitRepo.get(preparedCommit.commitId, tx);
			if (existingCommit !== undefined && !matchesPreparedCommit(existingCommit, preparedCommit)) {
				const error = new VersionControlCommitConflictError(preparedCommit.commitId);
				log.error('prepared commit ID conflicts with stored content', {
					err: error,
					commitId: preparedCommit.commitId
				});
				throw error;
			}

			await this._assertCommitLinksExist(preparedCommit, tx);
			if (existingCommit !== undefined) return existingCommit;

			return this._commitRepo.create(preparedCommit.commitId, preparedCommit.createCommitParam, tx);
		});
	}

	/** Creates a shared commit and registers its alternate visibility in the repository atomically.
	 *
	 * @param repoId - The repository in which an alternate should be visible.
	 * @param preparedCommit - The exact immutable object returned by `prepareCommit`.
	 * @param transaction - Optional caller-owned transaction spanning repositories, commits, and alternate links.
	 * @returns The persisted global commit.
	 * @throws {VersionControlResourceNotFoundError|VersionControlCommitNotPreparedError|VersionControlCommitConflictError|VersionControlAlternateMembershipError|CommitCorruptError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when the repository or linked data is invalid or persistence fails.
	 */
	async createCommitForRepo(
		repoId: string,
		preparedCommit: PreparedCommit,
		transaction?: ArcadiaTransaction<'readwrite'>
	): Promise<Commit> {
		log.trace('create commit for repository enter', { repoId, commitId: preparedCommit.commitId });

		return withTransaction(
			this._db,
			['repos', 'commits', 'repoAlternates'],
			'readwrite',
			transaction,
			async (tx) => {
				await this.requireRepository(repoId, tx);
				const commit = await this.createCommit(preparedCommit, tx);
				if (commit.alternateOfCommitId !== null) {
					await this.createRepoAlternate(repoId, commit.alternateOfCommitId, commit.id, tx);
				}
				return commit;
			}
		);
	}

	/**
	 * Gets one globally shared commit by ID.
	 *
	 * @param commitId - The content-addressed commit ID to retrieve.
	 * @param transaction - Optional caller-owned transaction containing the commit store.
	 * @returns The commit, or `undefined` if it does not exist.
	 * @throws {CommitCorruptError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when the row is invalid or cannot be read.
	 */
	getCommit(commitId: string, transaction?: ArcadiaTransaction): Promise<Commit | undefined> {
		log.trace('getCommit enter', { commitId });
		return this._commitRepo.get(commitId, transaction);
	}

	/** Gets a commit and its ancestors by following parent links.
	 *
	 * @param firstCommitId - The first commit to include in the chain.
	 * @param count - The maximum number of commits to return.
	 * @param transaction - Optional caller-owned transaction containing the commits store.
	 * @returns The validated commits in newest-to-oldest order, including the starting commit.
	 * @throws {VersionControlResourceNotFoundError|CommitAncestryCorruptError|CommitCorruptError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when the start commit is missing, ancestry is broken, a row is corrupt, or the read fails.
	 */
	getCommitParentChain(
		firstCommitId: string,
		count: number,
		transaction?: ArcadiaTransaction
	): Promise<Commit[]> {
		log.trace('get commit parent chain enter', { firstCommitId });
		return this._commitRepo.getParentChain(firstCommitId, count, transaction);
	}

	/** Adds a globally shared alternate to one repository's visible alternate set.
	 *
	 * @param repoId - The repository that owns this alternate relationship.
	 * @param alternateOfCommitId - The commit this alternate replaces.
	 * @param alternateCommitId - The globally shared alternate commit.
	 * @param transaction - Optional caller-owned transaction spanning repositories and commits.
	 * @returns The persisted repository-alternate relationship.
	 * @throws {VersionControlResourceNotFoundError|VersionControlAlternateMembershipError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when linked data is missing, inconsistent, or persistence fails.
	 */
	async createRepoAlternate(
		repoId: string,
		alternateOfCommitId: string,
		alternateCommitId: string,
		transaction?: ArcadiaTransaction<'readwrite'>
	): Promise<RepoAlternate> {
		log.trace('create repository alternate enter', { repoId, alternateCommitId });

		return withTransaction(
			this._db,
			['repos', 'commits', 'repoAlternates'],
			'readwrite',
			transaction,
			async (tx) => {
				await this.requireRepository(repoId, tx);
				await this.requireCommit(alternateOfCommitId, tx);
				const alternateCommit = await this.requireCommit(alternateCommitId, tx);
				if (alternateCommit.alternateOfCommitId !== alternateOfCommitId) {
					throwVersionControlAlternateMembershipError(
						repoId,
						alternateOfCommitId,
						alternateCommitId
					);
				}

				return this._repoAlternateRepo.create(
					repoId,
					{ alternateOfCommitId, alternateCommitId },
					tx
				);
			}
		);
	}

	/** Gets globally shared alternates visible to the requested repository.
	 *
	 * @param repoId - The repository whose alternate set is queried.
	 * @param alternateOfCommitId - The commit whose alternatives are requested.
	 * @param transaction - Optional caller-owned transaction containing repositories, links, and commits.
	 * @returns The validated alternate commits visible in that repository.
	 * @throws {VersionControlResourceNotFoundError|RepoAlternateCorruptError|VersionControlAlternateMembershipError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when linked data is missing, inconsistent, or a read fails.
	 */
	async getAlternateCommits(
		repoId: string,
		alternateOfCommitId: string,
		transaction?: ArcadiaTransaction
	): Promise<Commit[]> {
		log.trace('get repository alternates enter', { repoId, alternateOfCommitId });

		return withTransaction(
			this._db,
			['repos', 'repoAlternates', 'commits'],
			'readonly',
			transaction,
			async (tx) => {
				await this.requireRepository(repoId, tx);
				await this.requireCommit(alternateOfCommitId, tx);
				const repoAlternates: RepoAlternate[] = await this._repoAlternateRepo.getAllByAlternateOf(
					repoId,
					alternateOfCommitId,
					tx
				);
				return Promise.all(
					repoAlternates.map(async (repoAlternate) => {
						const commit = await this.requireCommit(repoAlternate.alternateCommitId, tx);
						if (commit.alternateOfCommitId !== repoAlternate.alternateOfCommitId) {
							throwVersionControlAlternateMembershipError(
								repoId,
								repoAlternate.alternateOfCommitId,
								repoAlternate.alternateCommitId
							);
						}
						return commit;
					})
				);
			}
		);
	}

	/**
	 * Creates a named reference after verifying its repository and target commit exist.
	 *
	 * @param repoId - The owning repository ID.
	 * @param name - The human-readable reference name.
	 * @param targetCommitId - The shared commit targeted by the reference.
	 * @param transaction - Optional caller-owned transaction spanning the related stores.
	 * @returns The created reference row.
	 * @throws {v.ValiError|VersionControlResourceNotFoundError|RepoCorruptError|CommitCorruptError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when validation, linked-resource checks, or persistence fails.
	 */
	createRef(
		repoId: string,
		name: string,
		targetCommitId?: string,
		transaction?: ArcadiaTransaction<'readwrite'>
	): Promise<Ref> {
		log.trace('createRef enter', { repoId });
		const input = v.parse(CreateDbRefParamSchema, { name, targetCommitId: targetCommitId ?? null });

		return withTransaction(
			this._db,
			['repos', 'refs', 'commits'],
			'readwrite',
			transaction,
			async (tx) => {
				await this.requireRepository(repoId, tx);
				if (typeof input.targetCommitId === 'string') {
					await this.requireCommit(input.targetCommitId, tx);
				}

				return this._refRepo.create(repoId, input, tx);
			}
		);
	}

	/**
	 * Gets one reference by ID within its repository.
	 *
	 * @param repoId - The expected owning repository ID.
	 * @param refId - The reference ID to retrieve.
	 * @param transaction - Optional caller-owned transaction containing the reference store.
	 * @returns The reference, or `undefined` if it does not exist.
	 * @throws {RefCorruptError|VersionControlOwnershipError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when the row is invalid or cannot be read.
	 */
	getRef(
		repoId: string,
		refId: string,
		transaction?: ArcadiaTransaction
	): Promise<Ref | undefined> {
		log.trace('getRef enter', { repoId, refId });
		return this._refRepo.get(repoId, refId, transaction);
	}

	/**
	 * Updates a reference after verifying its repository and resulting target commit exist.
	 *
	 * @param repoId - The owning repository ID.
	 * @param refId - The reference ID to update.
	 * @param name - The updated reference name, if changing it.
	 * @param targetCommitId - The new target commit ID, `null` to clear the target, or omitted to leave it unchanged.
	 * @param transaction - Optional caller-owned transaction spanning the related stores.
	 * @returns The updated reference.
	 * @throws {v.ValiError|VersionControlResourceNotFoundError|RepoCorruptError|RefCorruptError|CommitCorruptError|VersionControlOwnershipError|GarbageCollectionCorruptError|GarbageCollectionDatabaseError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when validation, linked-resource checks, or persistence fails.
	 */
	async updateRef(
		repoId: string,
		refId: string,
		name?: string,
		targetCommitId?: string | null,
		transaction?: ArcadiaTransaction<'readwrite'>
	): Promise<Ref> {
		log.trace('updateRef enter', { repoId, refId });
		const input = v.parse(UpdateDbRefParamSchema, {
			...(name === undefined ? {} : { name }),
			...(targetCommitId === undefined ? {} : { targetCommitId })
		});

		const updated = await withTransaction(
			this._db,
			['repos', 'refs', 'commits', 'garbageJobs', 'garbageJobItems'],
			'readwrite',
			transaction,
			async (tx) => {
				await this.requireRepository(repoId, tx);
				const currentRef = await this.requireRef(repoId, refId, tx);

				const target =
					input.targetCommitId === undefined ? currentRef.targetCommitId : input.targetCommitId;
				if (typeof input.targetCommitId === 'string') {
					await this.requireCommit(input.targetCommitId, tx);
				}
				if (target !== currentRef.targetCommitId && typeof currentRef.targetCommitId === 'string') {
					await this._garbageCollectionService.enqueue(
						repoId,
						'reference-moved',
						[currentRef.targetCommitId],
						tx
					);
				}
				return this._refRepo.updateValidated(currentRef, input, tx);
			}
		);

		return updated;
	}

	/**
	 * Deletes a reference and atomically queues its target for background collection.
	 *
	 * @param repoId - The owning repository ID.
	 * @param refId - The reference ID to delete.
	 * @param transaction - Optional caller-owned transaction spanning refs and GC stores.
	 * @returns `true` if the reference existed and was queued for deletion, otherwise `false`.
	 * @throws {RepoCorruptError|RefCorruptError|VersionControlOwnershipError|GarbageCollectionCorruptError|GarbageCollectionDatabaseError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when validation or persistence fails.
	 */
	async deleteRef(
		repoId: string,
		refId: string,
		transaction?: ArcadiaTransaction<'readwrite'>
	): Promise<boolean> {
		log.trace('deleteRef enter', { repoId, refId });
		return withTransaction(
			this._db,
			['repos', 'refs', 'garbageJobs', 'garbageJobItems'],
			'readwrite',
			transaction,
			async (tx) => {
				const repo = await this.getRepository(repoId, tx);
				if (repo === undefined) return false;
				const ref = await this._refRepo.get(repoId, refId, tx);
				if (ref === undefined) return false;

				await this._refRepo.delete(ref, tx);
				if (typeof ref.targetCommitId === 'string') {
					await this._garbageCollectionService.enqueue(
						repoId,
						'reference-deleted',
						[ref.targetCommitId],
						tx
					);
				}
				if (repo.defaultRefId === ref.id) {
					await this._repoRepo.setDefaultRef(repo.id, null, tx);
				}
				return true;
			}
		);
	}

	/** Gets a required repository row.
	 *
	 * @param repoId - The repository ID that must exist.
	 * @param transaction - Optional caller-owned transaction containing the repository store.
	 * @returns The validated repository row.
	 * @throws {VersionControlResourceNotFoundError|RepoCorruptError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when the repository is missing, corrupt, or cannot be read.
	 */
	async requireRepository(repoId: string, transaction?: ArcadiaTransaction): Promise<Repo> {
		return await this._repoRepo.requireRepository(repoId, transaction);
	}

	/** Gets a required ref scoped to its owning repository.
	 *
	 * @param repoId - The expected owning repository ID.
	 * @param refId - The ref ID that must exist in that repository.
	 * @param transaction - Optional caller-owned transaction containing the refs store.
	 * @returns The validated ref.
	 * @throws {VersionControlResourceNotFoundError|RefCorruptError|VersionControlOwnershipError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when the ref is missing, corrupt, belongs to another repository, or cannot be read.
	 */
	async requireRef(repoId: string, refId: string, transaction?: ArcadiaTransaction): Promise<Ref> {
		const ref = await this._refRepo.get(repoId, refId, transaction);
		if (ref !== undefined) return ref;

		const error = new VersionControlResourceNotFoundError('ref', refId);
		log.error('version-control ref not found', { err: error, refId });
		throw error;
	}

	/** Gets a required globally shared commit.
	 *
	 * @param commitId - The commit ID that must exist.
	 * @param tx - Optional caller-owned transaction containing the commits store.
	 * @returns The validated commit.
	 * @throws {VersionControlResourceNotFoundError|CommitCorruptError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when the commit is missing, corrupt, or cannot be read.
	 */
	async requireCommit(commitId: string, tx?: ArcadiaTransaction): Promise<Commit> {
		const commit = await this._commitRepo.get(commitId, tx);
		if (commit !== undefined) return commit;

		const error = new VersionControlResourceNotFoundError('commit', commitId);
		log.error('version-control commit not found', { err: error, commitId });
		throw error;
	}

	/** Gets a commit only if it is on the parent chain of the specified ref.
	 *
	 * @param repoId - The repository that owns the ref.
	 * @param refId - The ref whose history is checked.
	 * @param commitId - The commit that must occur in the ref's parent history.
	 * @param tx - Optional caller-owned transaction containing the refs and commits stores.
	 * @returns The validated commit from the ref's history.
	 * @throws {VersionControlResourceNotFoundError|VersionControlCommitNotOnRefHistoryError|VersionControlCommitAncestryCycleError|RefCorruptError|CommitCorruptError|VersionControlOwnershipError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when the ref or commit is missing, the commit is outside the ref history, ancestry is cyclic, or a read fails.
	 */
	async requireCommitOnRefHistory(
		repoId: string,
		refId: string,
		commitId: string,
		tx?: ArcadiaTransaction
	): Promise<Commit> {
		log.trace('require commit on ref history enter', { repoId, refId, commitId });

		return withTransaction(this._db, ['refs', 'commits'], 'readonly', tx, async (transaction) => {
			const ref = await this.requireRef(repoId, refId, transaction);
			const requestedCommit = await this.requireCommit(commitId, transaction);
			let currentCommitId = ref.targetCommitId;
			const visitedCommitIds = new Set<string>();

			while (currentCommitId !== null) {
				if (currentCommitId === requestedCommit.id) return requestedCommit;
				if (visitedCommitIds.has(currentCommitId)) {
					const error = new VersionControlCommitAncestryCycleError(repoId, refId, currentCommitId);
					log.error('cycle in ref ancestry while validating commit history', { err: error });
					throw error;
				}

				visitedCommitIds.add(currentCommitId);
				const currentCommit = await this.requireCommit(currentCommitId, transaction);
				currentCommitId = currentCommit.parentCommitId;
			}

			const error = new VersionControlCommitNotOnRefHistoryError(repoId, refId, commitId);
			log.error('commit is not in ref history', { err: error });
			throw error;
		});
	}

	/** Ensures every non-null ancestry link points to a globally stored commit. */
	private async _assertCommitLinksExist(
		preparedCommit: PreparedCommit,
		transaction: ArcadiaTransaction<'readwrite'>
	): Promise<void> {
		const linkedCommitIds = new Set([
			preparedCommit.createCommitParam.parentCommitId,
			preparedCommit.createCommitParam.alternateOfCommitId
		]);

		for (const commitId of linkedCommitIds) {
			if (commitId !== null) await this.requireCommit(commitId, transaction);
		}
	}
}

/** Logs and throws when a repository link does not match the linked alternate commit. */
function throwVersionControlAlternateMembershipError(
	repoId: string,
	alternateOfCommitId: string,
	alternateCommitId: string
): never {
	const error = new VersionControlAlternateMembershipError(
		repoId,
		alternateOfCommitId,
		alternateCommitId
	);
	log.error('repository alternate membership does not match commit', {
		err: error,
		repoId,
		alternateOfCommitId,
		alternateCommitId
	});
	throw error;
}

/** Compares persisted commit content with the content covered by a prepared ID. */
function matchesPreparedCommit(commit: Commit, preparedCommit: PreparedCommit): boolean {
	return (
		serializeCommitContent(commit) === serializeCommitContent(preparedCommit.createCommitParam)
	);
}

/** Serializes versioned commit content with recursively sorted object keys. */
function serializeCommitContent(content: object): string {
	const fields = Object.fromEntries(
		Object.entries(content).filter(
			([key]) => key !== 'id' && key !== 'repoId' && key !== 'createdAt'
		)
	);

	return canonicalize({ format: COMMIT_CONTENT_FORMAT, content: fields });
}

/** Serializes JSON values with recursively sorted object keys. */
function canonicalize(value: unknown): string {
	if (value === null) return 'null';
	if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new TypeError('Commit content contains a non-finite number');
		return JSON.stringify(value);
	}

	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalize(item)).join(',')}]`;
	}

	if (typeof value !== 'object') throw new TypeError('Commit content is not JSON serializable');

	const entries = Object.entries(value).sort(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0
	);
	return `{${entries
		.map(([key, nestedValue]) => `${JSON.stringify(key)}:${canonicalize(nestedValue)}`)
		.join(',')}}`;
}

/** Converts a SHA-256 digest to lowercase hexadecimal. */
function toHex(digest: Uint8Array): string {
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Recursively freezes a prepared value so its hashed content cannot be mutated before persistence. */
function freezeRecursively(value: unknown): void {
	if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;

	for (const nestedValue of Object.values(value)) {
		freezeRecursively(nestedValue);
	}
	Object.freeze(value);
}
