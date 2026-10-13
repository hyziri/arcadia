/** Defines the initial schema migration for the settings store.
 *
 * This migration is safe to invoke repeatedly: it creates the store only when it is absent.
 */

import type { MigrationContext } from './context';

/** Creates the initial settings store when it is not already present.
 *
 * @param context - The database and active version-change transaction.
 * @throws {DOMException} if IndexedDB cannot create the settings store.
 */
export function migrateToV1({ database }: MigrationContext): void {
	if (!database.objectStoreNames.contains('settings')) {
		database.createObjectStore('settings', {
			keyPath: 'key'
		});
	}
}
