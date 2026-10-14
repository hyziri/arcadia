/** Provides the database handles required by an IndexedDB schema migration. */

import type { IDBPDatabase, IDBPTransaction } from 'idb';

import type { ArcadiaDbSchema } from '../schema';

/** Store names available on the database during a version-change transaction. */
type DatabaseStoreName = 'settings';

/** Database and active transaction passed to each schema migration. */
export interface MigrationContext {
	/** Database whose schema is being upgraded. */
	database: IDBPDatabase<ArcadiaDbSchema>;

	/** Transaction in which schema changes must be made. */
	transaction: IDBPTransaction<ArcadiaDbSchema, DatabaseStoreName[], 'versionchange'>;
}
