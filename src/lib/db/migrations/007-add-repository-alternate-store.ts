/** Adds repository-scoped availability links for globally shared alternate commits. */

import type { MigrationContext } from './context';

/** Creates the repository-alternate store and its lookup indexes.
 *
 * @param context - The database and active version-change transaction.
 * @throws {DOMException} if IndexedDB cannot create the store or indexes.
 */
export function migrateToV7({ database, transaction }: MigrationContext): void {
	const repoAlternates = database.objectStoreNames.contains('repoAlternates')
		? transaction.objectStore('repoAlternates')
		: database.createObjectStore('repoAlternates', {
				keyPath: ['repoId', 'alternateOfCommitId', 'alternateCommitId']
			});

	if (!repoAlternates.indexNames.contains('by-repo')) {
		repoAlternates.createIndex('by-repo', 'repoId');
	}
	if (!repoAlternates.indexNames.contains('by-repo-alternate-of')) {
		repoAlternates.createIndex('by-repo-alternate-of', ['repoId', 'alternateOfCommitId']);
	}
	if (!repoAlternates.indexNames.contains('by-alternate-commit')) {
		repoAlternates.createIndex('by-alternate-commit', 'alternateCommitId');
	}
}
