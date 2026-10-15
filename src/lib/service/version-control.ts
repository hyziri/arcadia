/** Coordinates content-addressed commit preparation and version-control persistence.
 *
 * Commit hashes are prepared before any IndexedDB transaction starts. Persistence methods accept
 * the prepared value and use the database connection supplied at construction, so caller-owned
 * transactions never wait for hashing or database initialization.
 *
 * @example
 * ```ts
 * import { getDatabase } from '#lib/db';
 * import { VersionControlService } from '#lib/service';
 *
 * const database = await getDatabase();
 * const versionControl = new VersionControlService(database);
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
	RepoRepo,
	UpdateDbRefParamSchema,
	type CreateDbCommitParam
} from '#lib/data';
import { withTransaction, type ArcadiaTransaction, type Database } from '#lib/db';
import { AppError } from '#lib/error';
import { getLogger } from '#lib/logger';
import type { Commit, Ref, Repo, RepoKind } from '#lib/model';

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

/** Indicates that a required version-control resource does not exist. */
export class VersionControlResourceNotFoundError extends AppError {
	readonly kind = 'version_control_resource_not_found';
	readonly resource: 'repo' | 'commit';
	readonly resourceId: string;

	/** Creates an error describing a missing repository or commit. */
	constructor(resource: 'repo' | 'commit', resourceId: string) {
		super(
			resource === 'repo'
				? `Version-control repository not found: ${resourceId}`
				: `Version-control commit not found: ${resourceId}`
		);
		this.resource = resource;
		this.resourceId = resourceId;
	}
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

/** Coordinates version-control repositories using an already-open database connection. */
export class VersionControlService {
	private readonly _db: Database;
	private readonly _repoRepo: RepoRepo;
	private readonly _refRepo: RefRepo;
	private readonly _commitRepo: CommitRepo;

	/** Creates a service and its repositories backed by the supplied database connection. */
	constructor(database: Database) {
		this._db = database;
		this._repoRepo = new RepoRepo(database);
		this._refRepo = new RefRepo(database);
		this._commitRepo = new CommitRepo(database);
	}

	/**
	 * Creates a repository and lets the data layer generate its ID.
	 *
	 * @param repoKind - The kind of data grouped by the repository.
	 * @param transaction - Optional caller-owned transaction containing the repository store.
	 * @returns The created repository row.
	 * @throws {v.ValiError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when validation or persistence fails.
	 */
	createRepository(
		repoKind: RepoKind,
		transaction?: ArcadiaTransaction<'readwrite'>
	): Promise<Repo> {
		log.trace('createRepository enter');
		return this._repoRepo.create(repoKind, transaction);
	}

	/**
	 * Forks a repository by creating a new repository and copying all refs to the same shared commits.
	 *
	 * @param sourceRepoId - The repository whose kind and refs should be copied.
	 * @param transaction - Optional caller-owned transaction spanning repositories, refs, and commits.
	 * @returns The new repository and its generated refs.
	 * @throws {v.ValiError|VersionControlResourceNotFoundError|RepoCorruptError|RefCorruptError|CommitCorruptError|VersionControlOwnershipError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when the source or linked data is invalid or persistence fails.
	 */
	async forkRepository(
		sourceRepoId: string,
		transaction?: ArcadiaTransaction<'readwrite'>
	): Promise<ForkedRepository> {
		log.trace('forkRepository enter', { sourceRepoId });

		return withTransaction(
			this._db,
			['repos', 'refs', 'commits'],
			'readwrite',
			transaction,
			async (tx) => {
				const sourceRepository = await this._requireRepository(sourceRepoId, tx);
				const sourceRefs = await this._refRepo.getAllByRepo(sourceRepoId, tx);
				const targetCommitIds = new Set(sourceRefs.map((ref) => ref.targetCommitId));
				for (const targetCommitId of targetCommitIds) {
					await this._requireCommit(targetCommitId, tx);
				}

				const repository = await this._repoRepo.create(sourceRepository.kind, tx);
				const refs: Ref[] = [];
				for (const sourceRef of sourceRefs) {
					refs.push(
						await this._refRepo.create(
							repository.id,
							{ name: sourceRef.name, targetCommitId: sourceRef.targetCommitId },
							tx
						)
					);
				}

				return { repository, refs };
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
		targetCommitId: string,
		transaction?: ArcadiaTransaction<'readwrite'>
	): Promise<Ref> {
		log.trace('createRef enter', { repoId });
		const input = v.parse(CreateDbRefParamSchema, { name, targetCommitId });

		return withTransaction(
			this._db,
			['repos', 'refs', 'commits'],
			'readwrite',
			transaction,
			async (tx) => {
				await this._requireRepository(repoId, tx);
				await this._requireCommit(input.targetCommitId, tx);
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
	 * @param targetCommitId - The new target commit ID, if moving the ref.
	 * @param transaction - Optional caller-owned transaction spanning the related stores.
	 * @returns The updated reference, or `undefined` if it does not exist.
	 * @throws {v.ValiError|VersionControlResourceNotFoundError|RepoCorruptError|RefCorruptError|CommitCorruptError|VersionControlOwnershipError|VersionControlDatabaseError|TransactionScopeError|OperationTimeoutError} when validation, linked-resource checks, or persistence fails.
	 */
	updateRef(
		repoId: string,
		refId: string,
		name?: string,
		targetCommitId?: string,
		transaction?: ArcadiaTransaction<'readwrite'>
	): Promise<Ref | undefined> {
		log.trace('updateRef enter', { repoId, refId });
		const input = v.parse(UpdateDbRefParamSchema, {
			...(name === undefined ? {} : { name }),
			...(targetCommitId === undefined ? {} : { targetCommitId })
		});

		return withTransaction(
			this._db,
			['repos', 'refs', 'commits'],
			'readwrite',
			transaction,
			async (tx) => {
				await this._requireRepository(repoId, tx);
				return this._refRepo.update(repoId, refId, input, tx, async (currentRef, activeTx) => {
					const target = input.targetCommitId ?? currentRef.targetCommitId;
					await this._requireCommit(target, activeTx);
				});
			}
		);
	}

	/** Requires the requested repository to exist within the active transaction. */
	private async _requireRepository(repoId: string, transaction: ArcadiaTransaction): Promise<Repo> {
		const repository = await this._repoRepo.get(repoId, transaction);
		if (repository !== undefined) return repository;

		const error = new VersionControlResourceNotFoundError('repo', repoId);
		log.error('version-control repository not found', { err: error, repoId });
		throw error;
	}

	/** Requires the requested commit to exist within the active transaction. */
	private async _requireCommit(commitId: string, transaction: ArcadiaTransaction): Promise<void> {
		if ((await this._commitRepo.get(commitId, transaction)) !== undefined) return;

		const error = new VersionControlResourceNotFoundError('commit', commitId);
		log.error('version-control commit not found', { err: error, commitId });
		throw error;
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
			if (commitId !== null) await this._requireCommit(commitId, transaction);
		}
	}
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
