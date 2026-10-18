/** Persists and validates per-commit garbage-collection work items. */

import * as v from 'valibot';

import { withTransaction, type ArcadiaTransaction, type Database } from '#lib/db';
import { getLogger } from '#lib/logger';
import { GarbageJobItemSchema, type GarbageJobItem } from '#lib/model';

import {
	getStringField,
	throwGarbageCorruptError,
	throwGarbageDatabaseFailure
} from './garbage-errors';

/** Logger scoped to garbage-collection work-item persistence. */
const log = getLogger('data/version-control/garbage-item');

/** Provides validated operations for per-commit garbage-collection work items. */
export class GarbageItemRepo {
	private readonly _db: Database;

	/** Creates a garbage-item repository backed by the supplied database connection. */
	constructor(database: Database) {
		this._db = database;
	}

	/**
	 * Adds unique commit candidates to a job in the caller's transaction.
	 *
	 * @param jobId - The owning job ID.
	 * @param commitIds - Commit IDs to add to the discovery queue.
	 * @param transaction - The caller-owned transaction containing the garbage-job-items store.
	 * @returns A promise that resolves after all candidates are added.
	 * @throws {v.ValiError|GarbageCollectionDatabaseError|TransactionScopeError} when validation or persistence fails.
	 */
	async createMany(
		jobId: string,
		commitIds: readonly string[],
		transaction: ArcadiaTransaction<'readwrite'>
	): Promise<void> {
		log.trace('createMany enter', { jobId, itemCount: commitIds.length });
		const items = [...new Set(commitIds)].map((commitId) =>
			v.parse(GarbageJobItemSchema, { jobId, commitId, state: 'pending' })
		);

		try {
			await withTransaction(this._db, ['garbageJobItems'], 'readwrite', transaction, async (tx) => {
				const store = tx.objectStore('garbageJobItems');
				for (const item of items) await store.add(item);
			});
		} catch (cause: unknown) {
			throwGarbageDatabaseFailure(log, 'item', 'write', jobId, cause);
		}
	}

	/**
	 * Reads the next pending discovery item.
	 *
	 * @param jobId - The owning job ID.
	 * @param transaction - The active transaction containing the garbage-job-items store.
	 * @returns The next pending item, or `undefined` when discovery is complete.
	 * @throws {GarbageCollectionCorruptError|GarbageCollectionDatabaseError|TransactionScopeError} when the item cannot be read or validated.
	 */
	async getNextPending(
		jobId: string,
		transaction: ArcadiaTransaction<'readwrite'>
	): Promise<GarbageJobItem | undefined> {
		try {
			const storedItem: unknown = await withTransaction(
				this._db,
				['garbageJobItems'],
				'readwrite',
				transaction,
				async (tx) =>
					tx.objectStore('garbageJobItems').index('by-job-state').get([jobId, 'pending'])
			);
			return storedItem === undefined ? undefined : parseGarbageJobItem(storedItem, jobId);
		} catch (cause: unknown) {
			throwGarbageDatabaseFailure(log, 'item', 'read', jobId, cause);
		}
	}

	/**
	 * Adds newly discovered parent or alternate commits unless the job already tracks them.
	 *
	 * @param jobId - The owning job ID.
	 * @param commitIds - Newly discovered commit IDs.
	 * @param transaction - The caller-owned transaction containing the garbage-job-items store.
	 * @returns A promise that resolves after the candidates are added or confirmed present.
	 * @throws {GarbageCollectionCorruptError|GarbageCollectionDatabaseError|TransactionScopeError} when an item cannot be read or written.
	 */
	async enqueueCandidates(
		jobId: string,
		commitIds: readonly string[],
		transaction: ArcadiaTransaction<'readwrite'>
	): Promise<void> {
		try {
			await withTransaction(this._db, ['garbageJobItems'], 'readwrite', transaction, async (tx) => {
				const store = tx.objectStore('garbageJobItems');
				for (const commitId of new Set(commitIds)) {
					const key: [string, string] = [jobId, commitId];
					const storedItem: unknown = await store.get(key);
					if (storedItem === undefined) {
						await store.add(v.parse(GarbageJobItemSchema, { jobId, commitId, state: 'pending' }));
					} else {
						parseGarbageJobItem(storedItem, jobId, commitId);
					}
				}
			});
		} catch (cause: unknown) {
			throwGarbageDatabaseFailure(log, 'item', 'write', jobId, cause);
		}
	}

	/**
	 * Updates one candidate's state.
	 *
	 * @param jobId - The owning job ID.
	 * @param commitId - The candidate commit ID.
	 * @param state - The candidate's updated state.
	 * @param transaction - The caller-owned transaction containing the garbage-job-items store.
	 * @returns A promise that resolves after the item state is updated.
	 * @throws {GarbageCollectionCorruptError|GarbageCollectionDatabaseError|TransactionScopeError} when the item cannot be read or written.
	 */
	async setState(
		jobId: string,
		commitId: string,
		state: GarbageJobItem['state'],
		transaction: ArcadiaTransaction<'readwrite'>
	): Promise<void> {
		try {
			await withTransaction(this._db, ['garbageJobItems'], 'readwrite', transaction, async (tx) => {
				const store = tx.objectStore('garbageJobItems');
				const storedItem: unknown = await store.get([jobId, commitId]);
				if (storedItem === undefined) return;
				const item = parseGarbageJobItem(storedItem, jobId, commitId);
				await store.put(v.parse(GarbageJobItemSchema, { ...item, state }));
			});
		} catch (cause: unknown) {
			throwGarbageDatabaseFailure(log, 'item', 'write', `${jobId}:${commitId}`, cause);
		}
	}

	/**
	 * Finds the next candidate not yet collected after the sweep cursor.
	 *
	 * @param jobId - The owning job ID.
	 * @param cursorCommitId - The last candidate examined, if any.
	 * @param transaction - The active transaction containing the garbage-job-items store.
	 * @returns The next candidate, or `undefined` after the sweep pass.
	 * @throws {GarbageCollectionCorruptError|GarbageCollectionDatabaseError|TransactionScopeError} when an item cannot be read or validated.
	 */
	getNextCandidate(
		jobId: string,
		cursorCommitId: string | null,
		transaction: ArcadiaTransaction<'readwrite'>
	): Promise<GarbageJobItem | undefined> {
		return this._findAfter(jobId, cursorCommitId, false, transaction);
	}

	/**
	 * Finds the next item, including collected items, after the cleanup cursor.
	 *
	 * @param jobId - The owning job ID.
	 * @param cursorCommitId - The last item removed, if any.
	 * @param transaction - The active transaction containing the garbage-job-items store.
	 * @returns The next item, or `undefined` when cleanup is complete.
	 * @throws {GarbageCollectionCorruptError|GarbageCollectionDatabaseError|TransactionScopeError} when an item cannot be read or validated.
	 */
	getNext(
		jobId: string,
		cursorCommitId: string | null,
		transaction: ArcadiaTransaction<'readwrite'>
	): Promise<GarbageJobItem | undefined> {
		return this._findAfter(jobId, cursorCommitId, true, transaction);
	}

	/**
	 * Deletes one work item after it has been processed.
	 *
	 * @param jobId - The owning job ID.
	 * @param commitId - The completed candidate ID.
	 * @param transaction - The caller-owned transaction containing the garbage-job-items store.
	 * @returns A promise that resolves after the item is deleted.
	 * @throws {GarbageCollectionDatabaseError|TransactionScopeError} when deletion fails.
	 */
	async delete(
		jobId: string,
		commitId: string,
		transaction: ArcadiaTransaction<'readwrite'>
	): Promise<void> {
		try {
			await withTransaction(this._db, ['garbageJobItems'], 'readwrite', transaction, async (tx) => {
				await tx.objectStore('garbageJobItems').delete([jobId, commitId]);
			});
		} catch (cause: unknown) {
			throwGarbageDatabaseFailure(log, 'item', 'delete', `${jobId}:${commitId}`, cause);
		}
	}

	/** Finds the next job-scoped work item while optionally skipping collected items. */
	private async _findAfter(
		jobId: string,
		cursorCommitId: string | null,
		includeCollected: boolean,
		transaction: ArcadiaTransaction<'readwrite'>
	): Promise<GarbageJobItem | undefined> {
		try {
			const item = await withTransaction(
				this._db,
				['garbageJobItems'],
				'readwrite',
				transaction,
				(tx) => findItemAfter(tx, jobId, cursorCommitId, includeCollected)
			);
			return item;
		} catch (cause: unknown) {
			throwGarbageDatabaseFailure(log, 'item', 'read', jobId, cause);
		}
	}
}

/** Validates a work item read from IndexedDB. */
function parseGarbageJobItem(
	storedRow: unknown,
	expectedJobId?: string,
	expectedCommitId?: string
): GarbageJobItem {
	const parsed = v.safeParse(GarbageJobItemSchema, storedRow);
	const jobId = getStringField(storedRow, 'jobId');
	const commitId = getStringField(storedRow, 'commitId');
	const recordId =
		jobId === undefined || commitId === undefined ? undefined : `${jobId}:${commitId}`;
	if (!parsed.success) {
		throwGarbageCorruptError(log, 'corrupt garbage-collection work item', recordId, parsed.issues);
	}

	if (expectedJobId !== undefined) {
		const identity = v.safeParse(v.object({ jobId: v.literal(expectedJobId) }), parsed.output);
		if (!identity.success) {
			throwGarbageCorruptError(
				log,
				'garbage-collection work item job mismatch',
				recordId,
				identity.issues
			);
		}
	}
	if (expectedCommitId !== undefined) {
		const identity = v.safeParse(
			v.object({ commitId: v.literal(expectedCommitId) }),
			parsed.output
		);
		if (!identity.success) {
			throwGarbageCorruptError(
				log,
				'garbage-collection work item commit mismatch',
				recordId,
				identity.issues
			);
		}
	}

	return parsed.output;
}

/** Scans the compound primary key for one job-scoped work item after the durable cursor. */
async function findItemAfter(
	transaction: ArcadiaTransaction<'readwrite'>,
	jobId: string,
	cursorCommitId: string | null,
	includeCollected: boolean
): Promise<GarbageJobItem | undefined> {
	const range =
		cursorCommitId === null
			? IDBKeyRange.bound([jobId], [jobId, []])
			: IDBKeyRange.lowerBound([jobId, cursorCommitId], true);
	let cursor = await transaction.objectStore('garbageJobItems').openCursor(range);
	while (cursor !== null) {
		if (cursor.primaryKey[0] !== jobId) break;
		const item = parseGarbageJobItem(cursor.value, jobId);
		if (includeCollected || item.state !== 'collected') return item;
		cursor = await cursor.continue();
	}
	return undefined;
}
