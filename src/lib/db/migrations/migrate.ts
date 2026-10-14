/** Applies version-bounded migrations during an IndexedDB schema upgrade.
 *
 * Each migration is tagged with the database version it produces. The runner applies migrations
 * newer than the stored version and no newer than the requested version, in declaration order.
 * IndexedDB commits these schema changes with the version-change transaction or rolls them back
 * if an operation fails.
 *
 * @example
 * ```ts
 * runMigrations(oldVersion, targetVersion, { database, transaction });
 * ```
 */

import { migrateToV1 } from './001-add-settings-store';
import { migrateToV2 } from './002-add-version-control-stores';
import { type MigrationContext } from './context';

/** A schema change associated with the database version it produces. */
interface Migration {
	/** Target IndexedDB version for this migration. */
	version: number;

	/** Applies the schema change in the active version-change transaction. */
	migrate: (context: MigrationContext) => void;
}

/** Migrations ordered by ascending target version. */
const migrations: readonly Migration[] = [
	{ version: 1, migrate: migrateToV1 },
	{ version: 2, migrate: migrateToV2 }
];

/**
 * Applies migrations newer than the current version and no newer than the requested version.
 *
 * @param oldVersion - The database version before this upgrade.
 * @param targetVersion - The database version being upgraded to.
 * @param context - The database and version-change transaction used by migrations.
 * @throws {DOMException} if an IndexedDB schema operation fails.
 */
export function runMigrations(
	oldVersion: number,
	targetVersion: number,
	context: MigrationContext
): void {
	for (const migration of migrations) {
		if (migration.version > oldVersion && migration.version <= targetVersion) {
			migration.migrate(context);
		}
	}
}
