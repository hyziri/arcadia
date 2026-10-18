/** Moves alternate graph lookup from global commits to repository-scoped links. */

import type { MigrationContext } from './context';

/** Removes the obsolete commit alternate index and adds a global link lookup index.
 *
 * @param context - The database and active version-change transaction.
 * @throws {DOMException} if IndexedDB cannot update the indexes.
 */
export function migrateToV8({ transaction }: MigrationContext): void {
	transaction.objectStore('commits').deleteIndex('by-alternate');

	const repoAlternates = transaction.objectStore('repoAlternates');
	if (!repoAlternates.indexNames.contains('by-alternate-of')) {
		repoAlternates.createIndex('by-alternate-of', 'alternateOfCommitId');
	}
}
