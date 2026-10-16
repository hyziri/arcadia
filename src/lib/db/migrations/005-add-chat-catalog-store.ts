/** Defines the schema  migration for the chat catalog store. */

import type { MigrationContext } from './context';

/** Creates the chat catalog store when it is not already present.
 *
 * @param context - The database and active version-change transaction.
 * @throws {DOMException} if IndexedDB cannot create the chat catalog store.
 */
export function migrateToV5({ database, transaction }: MigrationContext): void {
	const chatCatalog = database.objectStoreNames.contains('chatCatalog')
		? transaction.objectStore('chatCatalog')
		: database.createObjectStore('chatCatalog', { keyPath: 'id' });

	if (!chatCatalog.indexNames.contains('by-chat-repo')) {
		chatCatalog.createIndex('by-chat-repo', 'chatRepoId', { unique: true });
	}

	if (!chatCatalog.indexNames.contains('by-updated-at')) {
		chatCatalog.createIndex('by-updated-at', 'updatedAt');
	}
}
