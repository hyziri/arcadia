/** Adds durable garbage-collection jobs and resumable per-commit work items. */

import type { MigrationContext } from './context';

/** Creates the garbage-collection stores and their job-scoped indexes.
 *
 * @param context - The database and active version-change transaction.
 * @throws {DOMException} if IndexedDB cannot create a store or index.
 */
export function migrateToV4({ database, transaction }: MigrationContext): void {
	const jobs = database.objectStoreNames.contains('garbageJobs')
		? transaction.objectStore('garbageJobs')
		: database.createObjectStore('garbageJobs', { keyPath: 'id' });

	if (!jobs.indexNames.contains('by-status')) jobs.createIndex('by-status', 'status');

	const items = database.objectStoreNames.contains('garbageJobItems')
		? transaction.objectStore('garbageJobItems')
		: database.createObjectStore('garbageJobItems', { keyPath: ['jobId', 'commitId'] });

	if (!items.indexNames.contains('by-job-state')) {
		items.createIndex('by-job-state', ['jobId', 'state']);
	}
}
