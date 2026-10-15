/** Replaces repository-scoped commit indexes with global ancestry indexes.
 *
 * Commit rows can now be shared by multiple repositories. The legacy `repoId` value is retained as
 * optional metadata on existing rows, but it no longer defines ownership or lookup scope.
 */

import type { MigrationContext } from './context';

/** Updates commit indexes for globally shared commits.
 *
 * @param context - The database and active version-change transaction.
 * @throws {DOMException} if IndexedDB cannot update a commit index.
 */
export function migrateToV3({ transaction }: MigrationContext): void {
	const commits = transaction.objectStore('commits') as unknown as IDBObjectStore;

	for (const indexName of ['by-repo', 'by-repo-parent', 'by-repo-alternate']) {
		if (commits.indexNames.contains(indexName)) commits.deleteIndex(indexName);
	}

	if (!commits.indexNames.contains('by-parent')) {
		commits.createIndex('by-parent', 'parentCommitId');
	}
	if (!commits.indexNames.contains('by-alternate')) {
		commits.createIndex('by-alternate', 'alternateOfCommitId');
	}
}
