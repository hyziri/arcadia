/** Runs durable garbage-collection jobs without blocking version-control operations.
 *
 * Version-control operations enqueue work atomically with their changes; the collector starts only
 * after those transactions commit. On application startup, `recoverJobs` resumes incomplete jobs
 * from the durable queue.
 *
 * @example
 * ```ts
 * import { appState } from '#lib/state';
 *
 * await appState.initialize(); // Startup also resumes incomplete jobs in the background.
 * ```
 */

import { CommitRepo, RefRepo, RepoAlternateRepo, VersionControlDatabaseError } from '#lib/data';
import { withTransaction, type ArcadiaTransaction, type Database } from '#lib/db';
import { AppError, OperationTimeoutError } from '#lib/error';
import { getLogger } from '#lib/logger';
import type { Commit, GarbageJob, GarbageJobReason } from '#lib/model';

import { GarbageCollectionDatabaseError } from '../../data/version-control/garbage-errors';
import { GarbageItemRepo } from '../../data/version-control/garbage-item';
import { GarbageJobRepo } from '../../data/version-control/garbage-job';

/** Logger scoped to background garbage collection. */
const log = getLogger('service/version-control/garbage-collection');
const RETRY_DELAY_MS = 5_000;

/** Exposes commit deletion only to the collector after it verifies global liveness. */
class CollectibleCommitRepo extends CommitRepo {
	delete(commit: Commit, transaction: ArcadiaTransaction<'readwrite'>): Promise<boolean> {
		return this._delete(commit, transaction);
	}
}

/** Runs resumable queue jobs and coordinates their work with version-control repositories. */
export class GarbageCollectionService {
	private readonly _db: Database;
	private readonly _garbageItemRepo: GarbageItemRepo;
	private readonly _garbageJobRepo: GarbageJobRepo;
	private readonly _commitRepo: CollectibleCommitRepo;
	private readonly _refRepo: RefRepo;
	private readonly _repoAlternateRepo: RepoAlternateRepo;
	private _running = false;
	private _requested = false;
	private _retryTimer: ReturnType<typeof setTimeout> | undefined;

	/** Creates a collector backed by the supplied database connection.
	 *
	 * @param database - The already-open application database.
	 */
	constructor(database: Database) {
		this._db = database;
		this._garbageItemRepo = new GarbageItemRepo(database);
		this._garbageJobRepo = new GarbageJobRepo(database);
		this._commitRepo = new CollectibleCommitRepo(database);
		this._refRepo = new RefRepo(database);
		this._repoAlternateRepo = new RepoAlternateRepo(database);
	}

	/**
	 * Enqueues roots in the caller's transaction and wakes the worker after commit.
	 *
	 * @param repoId - The repository whose old roots need auditing.
	 * @param reason - Why collection was queued.
	 * @param rootCommitIds - The commit roots to discover.
	 * @param transaction - The caller-owned transaction that changes the matching version-control state.
	 * @returns A promise that resolves after the job is added to the transaction.
	 * @throws {import('valibot').ValiError|GarbageCollectionCorruptError|GarbageCollectionDatabaseError|TransactionScopeError} when validation or queue persistence fails.
	 */
	async enqueue(
		repoId: string,
		reason: GarbageJobReason,
		rootCommitIds: readonly string[],
		transaction: ArcadiaTransaction<'readwrite'>
	): Promise<void> {
		log.trace('enqueue enter', { repoId, reason, rootCount: rootCommitIds.length });
		const job = await this._garbageJobRepo.create(repoId, reason, transaction);
		await this._garbageItemRepo.createMany(job.id, rootCommitIds, transaction);
		void transaction.done.then(
			() => this.wake(),
			() => undefined
		);
	}

	/** Checks the durable queue and resumes incomplete jobs in the background. */
	recoverJobs(): void {
		log.trace('recoverJobs enter');
		this.wake();
	}

	/** Schedules worker execution without awaiting its background work. */
	private wake(): void {
		if (this._retryTimer !== undefined) {
			clearTimeout(this._retryTimer);
			this._retryTimer = undefined;
		}
		this._requested = true;
		if (this._running) return;

		this._running = true;
		void this._run()
			.catch((error: unknown) => {
				if (!(error instanceof AppError) || error instanceof OperationTimeoutError) {
					log.error('garbage-collection worker failed', { err: error });
				}
				if (isRetryable(error)) this._scheduleRetry();
			})
			.finally(() => {
				this._running = false;
				if (this._requested) this.wake();
			});
	}

	/** Drains incomplete jobs until no further wake-up request is pending. */
	private async _run(): Promise<void> {
		while (this._requested) {
			this._requested = false;
			const jobIds = await this._garbageJobRepo.getIncompleteJobIds();

			for (const jobId of jobIds) {
				try {
					while (await this._processNextStep(jobId)) {
						// Each step commits independently so a reload can resume at the last checkpoint.
					}
				} catch (error: unknown) {
					if (!(error instanceof AppError) || error instanceof OperationTimeoutError) {
						log.error('garbage-collection job failed', { err: error, jobId });
					}
					if (isRetryable(error)) this._scheduleRetry();
				}
			}
		}
	}

	/** Processes one durable job step in its own transaction. */
	private async _processNextStep(jobId: string): Promise<boolean> {
		return withTransaction(
			this._db,
			['garbageJobs', 'garbageJobItems', 'commits', 'refs', 'repoAlternates'],
			'readwrite',
			undefined,
			async (transaction) => {
				const job = await this._garbageJobRepo.get(jobId, transaction);
				if (job === undefined || job.status === 'completed') return false;

				if (job.status === 'discovering') {
					return this._discoverNext(job, transaction);
				}
				if (job.status === 'sweeping') {
					return this._sweepNext(job, transaction);
				}
				return this._cleanNext(job, transaction);
			}
		);
	}

	/** Records one candidate's parent and alternate links before marking it discovered. */
	private async _discoverNext(
		job: GarbageJob,
		transaction: ArcadiaTransaction<'readwrite'>
	): Promise<boolean> {
		const item = await this._garbageItemRepo.getNextPending(job.id, transaction);
		if (item === undefined) {
			await this._garbageJobRepo.setStatus(job.id, 'sweeping', transaction);
			return true;
		}

		const commit = await this._commitRepo.get(item.commitId, transaction);
		if (commit === undefined) {
			await this._garbageItemRepo.setState(job.id, item.commitId, 'collected', transaction);
			return true;
		}

		const alternateCommits = await this._commitRepo.getAllByAlternate(commit.id, transaction);
		await this._garbageItemRepo.enqueueCandidates(
			job.id,
			[
				commit.parentCommitId,
				commit.alternateOfCommitId,
				...alternateCommits.map((alternateCommit) => alternateCommit.id)
			].filter((commitId): commitId is string => commitId !== null),
			transaction
		);
		await this._garbageItemRepo.setState(job.id, item.commitId, 'discovered', transaction);
		return true;
	}

	/** Deletes one candidate only when no reference or surviving commit points to it. */
	private async _sweepNext(
		job: GarbageJob,
		transaction: ArcadiaTransaction<'readwrite'>
	): Promise<boolean> {
		const item = await this._garbageItemRepo.getNextCandidate(job.id, job.sweepCursor, transaction);
		if (item === undefined) {
			if (job.sweepDeleted) {
				await this._garbageJobRepo.resetSweepPass(job.id, transaction);
			} else {
				await this._garbageJobRepo.setStatus(job.id, 'cleaning', transaction);
			}
			return true;
		}

		let deleted = false;
		const commit = await this._commitRepo.get(item.commitId, transaction);
		if (commit === undefined) {
			await this._garbageItemRepo.setState(job.id, item.commitId, 'collected', transaction);
		} else {
			const [refCount, parentCount, alternateCount, repoAlternateCount] = await Promise.all([
				this._refRepo.countByTargetCommit(item.commitId, transaction),
				this._commitRepo.countByParent(item.commitId, transaction),
				this._commitRepo.countByAlternate(item.commitId, transaction),
				this._repoAlternateRepo.countByAlternateCommit(item.commitId, transaction)
			]);
			if (refCount === 0 && parentCount === 0 && alternateCount === 0 && repoAlternateCount === 0) {
				await this._commitRepo.delete(commit, transaction);
				await this._garbageItemRepo.setState(job.id, item.commitId, 'collected', transaction);
				deleted = true;
			}
		}

		await this._garbageJobRepo.advanceSweep(job.id, item.commitId, deleted, transaction);
		return true;
	}

	/** Removes completed job items and marks the job complete when none remain. */
	private async _cleanNext(
		job: GarbageJob,
		transaction: ArcadiaTransaction<'readwrite'>
	): Promise<boolean> {
		const item = await this._garbageItemRepo.getNext(job.id, job.sweepCursor, transaction);
		if (item === undefined) {
			await this._garbageJobRepo.complete(job.id, transaction);
			log.debug('garbage-collection job completed', { jobId: job.id, repoId: job.repoId });
			return false;
		}

		await this._garbageItemRepo.delete(job.id, item.commitId, transaction);
		await this._garbageJobRepo.advanceSweep(job.id, item.commitId, false, transaction);
		return true;
	}

	/** Retries recoverable IndexedDB failures after a delay without blocking application work. */
	private _scheduleRetry(): void {
		if (this._retryTimer !== undefined) return;
		this._retryTimer = setTimeout(() => {
			this._retryTimer = undefined;
			this.wake();
		}, RETRY_DELAY_MS);
	}
}

/** Determines whether a failed transaction may succeed on a later attempt. */
function isRetryable(error: unknown): boolean {
	if (
		error instanceof OperationTimeoutError ||
		error instanceof GarbageCollectionDatabaseError ||
		error instanceof VersionControlDatabaseError
	) {
		return true;
	}

	return (
		typeof DOMException !== 'undefined' &&
		error instanceof DOMException &&
		['AbortError', 'InvalidStateError', 'UnknownError'].includes(error.name)
	);
}
