/** Backfills explicit null values for optional fields on persisted garbage-collection jobs. */

import type { MigrationContext } from './context';

/**
 * Makes legacy garbage-job rows compatible with the required nullable job schema.
 *
 * @param context - The database and active version-change transaction.
 * @throws {DOMException} if IndexedDB cannot update a garbage-job row.
 */
export function migrateToV6({ database, transaction }: MigrationContext): void {
	if (!database.objectStoreNames.contains('garbageJobs')) return;

	const jobs = transaction.objectStore('garbageJobs') as unknown as IDBObjectStore;
	const request = jobs.openCursor();
	request.onsuccess = () => {
		const cursor = request.result;
		if (cursor === null) return;

		const storedRow: unknown = cursor.value;
		if (isRecord(storedRow)) {
			cursor.update({
				...storedRow,
				completedAt: storedRow.completedAt ?? null,
				sweepCursor: storedRow.sweepCursor ?? null
			});
		}
		cursor.continue();
	};
}

/** Checks whether a migration value is a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
