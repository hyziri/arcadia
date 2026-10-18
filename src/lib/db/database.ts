/** Provides access to Arcadia's shared IndexedDB connection.
 *
 * The connection is opened lazily in browser environments. When the requested database version
 * is newer than the stored version, the matching migrations run in the version-change transaction.
 *
 * @example
 * ```ts
 * import { getDatabase } from '#lib/db';
 *
 * const database = await getDatabase();
 * const themeSetting = await database.get('settings', 'theme');
 * ```
 */

import { openDB, type IDBPDatabase } from 'idb';

import { browser } from '$app/env';
import { getLogger } from '#lib/logger';

import type { ArcadiaDbSchema } from './schema';
import { runMigrations } from './migrations';

/** Name of the IndexedDB database shared by the application. */
const DATABASE_NAME = 'arcadia';

/** Latest schema version; increment this when adding a migration. */
const DATABASE_VERSION = 6;

/** Typed connection to the application's IndexedDB schema. */
export type Database = IDBPDatabase<ArcadiaDbSchema>;

/** Promise resolving to the shared database connection. */
export type DatabasePromise = Promise<Database>;

/** Logger scoped to database connection lifecycle events. */
const log = getLogger('db/database');

/** Lazily initialized connection promise shared by all callers. */
let databasePromise: Promise<Database> | undefined;

/**
 * Opens or returns the shared application database connection.
 *
 * @returns The application's IndexedDB connection.
 * @throws {Error|DOMException} when called outside the browser or when opening/upgrading the database fails.
 */
export function getDatabase(): Promise<Database> {
	log.trace('getDatabase enter');

	if (!browser) {
		const error = new Error('IndexedDB is only available in the browser');

		log.error('database unavailable outside the browser', {
			err: error
		});

		throw error;
	}

	if (!databasePromise) {
		log.debug('opening database', {
			databaseName: DATABASE_NAME,
			databaseVersion: DATABASE_VERSION
		});

		databasePromise = openDB<ArcadiaDbSchema>(DATABASE_NAME, DATABASE_VERSION, {
			upgrade(database, oldVersion, newVersion, transaction) {
				runMigrations(oldVersion, newVersion ?? DATABASE_VERSION, {
					database,
					transaction
				});

				log.info('database upgraded', { oldVersion, newVersion });
			}
		});

		void databasePromise
			.then(() => {
				log.info('database opened', { name: DATABASE_NAME, version: DATABASE_VERSION });
			})
			.catch((error: unknown) => {
				databasePromise = undefined;

				log.error('database opening failed', {
					err: error
				});
			});
	}

	return databasePromise;
}
