/** Persists and validates durable garbage-collection jobs. */

import * as v from 'valibot';

import { withTransaction, type ArcadiaTransaction, type Database } from '#lib/db';
import { getLogger } from '#lib/logger';
import { GarbageJobSchema, type GarbageJob, type GarbageJobReason } from '#lib/model';

import {
	getStringField,
	throwGarbageCorruptError,
	throwGarbageDatabaseFailure
} from './garbage-errors';

/** Logger scoped to garbage-job persistence. */
const log = getLogger('data/version-control/garbage-job');

/** Provides validated operations for durable garbage-collection jobs. */
export class GarbageJobRepo {
	private readonly _db: Database;

	/** Creates a garbage-job repository backed by the supplied database connection. */
	constructor(database: Database) {
		this._db = database;
	}

	/**
	 * Creates a job in the caller's transaction.
	 *
	 * @param repoId - The repository whose removed or moved roots are being audited.
	 * @param reason - Why the collection job was submitted.
	 * @param transaction - The caller-owned transaction containing the garbage-jobs store.
	 * @returns The persisted job metadata.
	 * @throws {v.ValiError|GarbageCollectionDatabaseError|TransactionScopeError} when validation or persistence fails.
	 */
	async create(
		repoId: string,
		reason: GarbageJobReason,
		transaction: ArcadiaTransaction<'readwrite'>
	): Promise<GarbageJob> {
		log.trace('create enter', { repoId, reason });
		const job = v.parse(GarbageJobSchema, {
			id: crypto.randomUUID(),
			repoId,
			reason,
			status: 'discovering',
			submittedAt: Date.now(),
			completedAt: null,
			sweepCursor: null,
			sweepDeleted: false
		});

		try {
			await withTransaction(this._db, ['garbageJobs'], 'readwrite', transaction, async (tx) => {
				await tx.objectStore('garbageJobs').add(job);
			});
		} catch (cause: unknown) {
			throwGarbageDatabaseFailure(log, 'job', 'write', job.id, cause);
		}

		log.debug('garbage-collection job created', { jobId: job.id, repoId, reason });
		return job;
	}

	/**
	 * Lists job IDs that still require processing.
	 *
	 * @returns The incomplete job IDs for startup recovery or worker scheduling.
	 * @throws {GarbageCollectionCorruptError|GarbageCollectionDatabaseError|OperationTimeoutError} when job records cannot be read.
	 */
	async getIncompleteJobIds(): Promise<string[]> {
		try {
			return await withTransaction(this._db, ['garbageJobs'], 'readonly', undefined, async (tx) => {
				const jobIds: string[] = [];
				for (const status of ['discovering', 'sweeping', 'cleaning'] as const) {
					const storedJobs: unknown[] = await tx
						.objectStore('garbageJobs')
						.index('by-status')
						.getAll(IDBKeyRange.only(status));
					for (const storedJob of storedJobs) jobIds.push(parseGarbageJob(storedJob).id);
				}
				return jobIds;
			});
		} catch (cause: unknown) {
			throwGarbageDatabaseFailure(log, 'job', 'read', undefined, cause);
		}
	}

	/**
	 * Gets one validated job in the caller's transaction.
	 *
	 * @param jobId - The durable job ID to retrieve.
	 * @param transaction - The active transaction containing the garbage-jobs store.
	 * @returns The job, or `undefined` if it does not exist.
	 * @throws {GarbageCollectionCorruptError|GarbageCollectionDatabaseError|TransactionScopeError} when the row cannot be read or validated.
	 */
	async get(
		jobId: string,
		transaction: ArcadiaTransaction<'readwrite'>
	): Promise<GarbageJob | undefined> {
		try {
			const storedJob: unknown = await withTransaction(
				this._db,
				['garbageJobs'],
				'readwrite',
				transaction,
				async (tx) => tx.objectStore('garbageJobs').get(jobId)
			);
			return storedJob === undefined ? undefined : parseGarbageJob(storedJob);
		} catch (cause: unknown) {
			throwGarbageDatabaseFailure(log, 'job', 'read', jobId, cause);
		}
	}

	/**
	 * Persists the sweep cursor and whether this pass deleted a commit.
	 *
	 * @param jobId - The active job ID.
	 * @param cursorCommitId - The last candidate examined in this pass.
	 * @param deleted - Whether this step removed a commit.
	 * @param transaction - The caller-owned transaction containing the garbage-jobs store.
	 * @returns A promise that resolves after progress is saved.
	 * @throws {GarbageCollectionCorruptError|GarbageCollectionDatabaseError|TransactionScopeError} when the job cannot be updated.
	 */
	advanceSweep(
		jobId: string,
		cursorCommitId: string,
		deleted: boolean,
		transaction: ArcadiaTransaction<'readwrite'>
	): Promise<void> {
		return this._update(jobId, transaction, (job) => ({
			...job,
			sweepCursor: cursorCommitId,
			sweepDeleted: job.sweepDeleted || deleted
		}));
	}

	/**
	 * Starts another sweep pass after the previous pass removed commits.
	 *
	 * @param jobId - The active job ID.
	 * @param transaction - The caller-owned transaction containing the garbage-jobs store.
	 * @returns A promise that resolves after the cursor is reset.
	 * @throws {GarbageCollectionCorruptError|GarbageCollectionDatabaseError|TransactionScopeError} when the job cannot be updated.
	 */
	resetSweepPass(jobId: string, transaction: ArcadiaTransaction<'readwrite'>): Promise<void> {
		return this._update(jobId, transaction, (job) => ({
			...job,
			sweepCursor: null,
			sweepDeleted: false
		}));
	}

	/**
	 * Changes a job's processing phase.
	 *
	 * @param jobId - The active job ID.
	 * @param status - The next processing phase.
	 * @param transaction - The caller-owned transaction containing the garbage-jobs store.
	 * @returns A promise that resolves after the phase is updated.
	 * @throws {GarbageCollectionCorruptError|GarbageCollectionDatabaseError|TransactionScopeError} when the job cannot be updated.
	 */
	setStatus(
		jobId: string,
		status: GarbageJob['status'],
		transaction: ArcadiaTransaction<'readwrite'>
	): Promise<void> {
		return this._update(jobId, transaction, (job) => ({
			...job,
			status,
			...(status === 'cleaning' ? { sweepCursor: null, sweepDeleted: false } : {})
		}));
	}

	/**
	 * Marks a job complete after all its work items have been removed.
	 *
	 * @param jobId - The completed job ID.
	 * @param transaction - The caller-owned transaction containing the garbage-jobs store.
	 * @returns A promise that resolves after completion is persisted.
	 * @throws {GarbageCollectionCorruptError|GarbageCollectionDatabaseError|TransactionScopeError} when the job cannot be updated.
	 */
	complete(jobId: string, transaction: ArcadiaTransaction<'readwrite'>): Promise<void> {
		return this._update(jobId, transaction, (job) => ({
			...job,
			status: 'completed',
			completedAt: Date.now(),
			sweepCursor: null
		}));
	}

	/** Updates one validated job row inside the caller's transaction. */
	private async _update(
		jobId: string,
		transaction: ArcadiaTransaction<'readwrite'>,
		update: (job: GarbageJob) => GarbageJob
	): Promise<void> {
		try {
			await withTransaction(this._db, ['garbageJobs'], 'readwrite', transaction, async (tx) => {
				const storedJob: unknown = await tx.objectStore('garbageJobs').get(jobId);
				if (storedJob === undefined) return;
				const job = parseGarbageJob(storedJob);
				await tx.objectStore('garbageJobs').put(v.parse(GarbageJobSchema, update(job)));
			});
		} catch (cause: unknown) {
			throwGarbageDatabaseFailure(log, 'job', 'write', jobId, cause);
		}
	}
}

/** Validates a job row read from IndexedDB. */
function parseGarbageJob(storedRow: unknown): GarbageJob {
	const parsed = v.safeParse(GarbageJobSchema, storedRow);
	if (parsed.success) return parsed.output;
	throwGarbageCorruptError(
		log,
		'corrupt garbage-collection job',
		getStringField(storedRow, 'id'),
		parsed.issues
	);
}
