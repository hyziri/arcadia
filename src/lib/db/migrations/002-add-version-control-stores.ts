/** Adds the repositories, refs, and commits stores for version-controlled data.
 *
 * The indexes support branch lookup, commit ancestry traversal, and alternate-commit collection.
 * This migration is safe to invoke repeatedly: it creates missing stores and indexes only.
 */

import type { MigrationContext } from './context';

/** Creates the version-control stores and their lookup indexes.
 *
 * @param context - The database and active version-change transaction.
 * @throws {DOMException} if IndexedDB cannot create a store or index.
 */
export function migrateToV2({ database, transaction }: MigrationContext): void {
	if (!database.objectStoreNames.contains('repos')) {
		database.createObjectStore('repos', { keyPath: 'id' });
	}

	const refs = database.objectStoreNames.contains('refs')
		? transaction.objectStore('refs')
		: database.createObjectStore('refs', { keyPath: 'id' });

	if (!refs.indexNames.contains('by-repo')) {
		refs.createIndex('by-repo', 'repoId');
	}
	if (!refs.indexNames.contains('by-repo-name')) {
		refs.createIndex('by-repo-name', ['repoId', 'name'], { unique: true });
	}
	if (!refs.indexNames.contains('by-target-commit')) {
		refs.createIndex('by-target-commit', 'targetCommitId');
	}

	const commits = database.objectStoreNames.contains('commits')
		? transaction.objectStore('commits')
		: database.createObjectStore('commits', { keyPath: 'id' });

	if (!commits.indexNames.contains('by-repo')) {
		commits.createIndex('by-repo', 'repoId');
	}
	if (!commits.indexNames.contains('by-repo-parent')) {
		commits.createIndex('by-repo-parent', ['repoId', 'parentCommitId']);
	}
	if (!commits.indexNames.contains('by-repo-alternate')) {
		commits.createIndex('by-repo-alternate', ['repoId', 'alternateOfCommitId']);
	}
}
