/** Persists and validates application settings in IndexedDB.
 *
 * Settings are stored as string values keyed by setting name. Reads validate persisted rows so
 * malformed data from an older version or manual edits fail with a typed corruption error.
 *
 * @example
 * ```ts
 * import { SettingsRepo } from '#lib/data';
 *
 * const settingsRepo = new SettingsRepo();
 * await settingsRepo.set('appearance.theme', 'dark');
 * const themeSetting = await settingsRepo.get('appearance.theme');
 * ```
 */

import * as v from 'valibot';

import { getDatabase } from '../db/index.ts';
import { AppError } from '../error.ts';
import { getLogger } from '../logger.ts';

/** Validates the persisted row shape for the settings store. */
export const DbSettingSchema = v.object({
	key: v.string(),
	value: v.string()
});

/** A validated settings row as persisted in IndexedDB. */
export type DbSetting = v.InferOutput<typeof DbSettingSchema>;

/** Logger scoped to settings persistence and validation. */
const log = getLogger('data/settings');

/** Indicates that a persisted settings row does not match the settings schema. */
export class SettingsCorruptError extends AppError {
	readonly kind = 'settings_corrupt';
	readonly settingKey: string | undefined;
	readonly issues: readonly v.InferIssue<typeof DbSettingSchema>[];

	/** Creates an error describing an invalid persisted settings row. */
	constructor(
		settingKey: string | undefined,
		issues: readonly v.InferIssue<typeof DbSettingSchema>[]
	) {
		super(
			settingKey === undefined
				? 'A persisted settings row is invalid'
				: `Persisted setting is invalid: ${settingKey}`
		);
		this.settingKey = settingKey;
		this.issues = issues;
	}
}

/** Indicates that an IndexedDB operation on the settings store failed. */
export class SettingsDatabaseError extends AppError {
	readonly kind = 'settings_database';
	readonly operation: 'read' | 'write' | 'delete';
	readonly settingKey: string | undefined;

	/** Creates an error describing a failed settings-store operation. */
	constructor(
		operation: 'read' | 'write' | 'delete',
		settingKey: string | undefined,
		options?: ErrorOptions
	) {
		super(
			settingKey === undefined
				? `Settings ${operation} operation failed`
				: `Settings ${operation} operation failed: ${settingKey}`,
			options
		);
		this.operation = operation;
		this.settingKey = settingKey;
	}
}

/** Provides validated create, read, and delete operations for application settings. */
export class SettingsRepo {
	/**
	 * Creates or replaces a setting value.
	 *
	 * @param settingKey - The setting name used as the IndexedDB key.
	 * @param value - The string value to persist.
	 * @returns A promise that resolves when the setting is stored.
	 * @throws {v.ValiError|SettingsDatabaseError|Error|DOMException} when validation or the IndexedDB write fails.
	 */
	async set(settingKey: string, value: string): Promise<void> {
		log.trace('set enter', { settingKey });

		const setting = v.parse(DbSettingSchema, { key: settingKey, value });
		const database = await getDatabase();
		try {
			await database.put('settings', setting);
		} catch (cause: unknown) {
			throw logDatabaseFailure('write', settingKey, cause);
		}

		log.debug('setting saved', { settingKey });
	}

	/**
	 * Gets one setting by its key.
	 *
	 * @param settingKey - The setting name to retrieve.
	 * @returns The validated setting, or `undefined` if it does not exist.
	 * @throws {SettingsCorruptError|SettingsDatabaseError|Error|DOMException} when the row is corrupt or the IndexedDB read fails.
	 */
	async get(settingKey: string): Promise<DbSetting | undefined> {
		log.trace('get enter', { settingKey });

		const database = await getDatabase();
		let setting: DbSetting | undefined;
		try {
			setting = await database.get('settings', settingKey);
		} catch (cause: unknown) {
			throw logDatabaseFailure('read', settingKey, cause);
		}

		if (setting === undefined) {
			return undefined;
		}

		return parseSetting(setting);
	}

	/**
	 * Deletes one setting by its key.
	 *
	 * @param settingKey - The setting name to delete.
	 * @returns A promise that resolves when the setting is deleted.
	 * @throws {SettingsDatabaseError|Error|DOMException} when the IndexedDB write fails.
	 */
	async delete(settingKey: string): Promise<void> {
		log.trace('delete enter', { settingKey });

		const database = await getDatabase();
		try {
			await database.delete('settings', settingKey);
		} catch (cause: unknown) {
			throw logDatabaseFailure('delete', settingKey, cause);
		}

		log.debug('setting deleted', { settingKey });
	}
}

/** Wraps and logs an IndexedDB operation failure at the repository boundary. */
function logDatabaseFailure(
	operation: 'read' | 'write' | 'delete',
	settingKey: string | undefined,
	cause: unknown
): SettingsDatabaseError {
	const error = new SettingsDatabaseError(operation, settingKey, { cause });
	log.error(`settings ${operation} failed`, {
		err: error,
		...(settingKey === undefined ? {} : { settingKey })
	});
	return error;
}

/** Validates a row read from IndexedDB and reports corruption at the repository boundary. */
function parseSetting(candidate: unknown): DbSetting {
	const parsed = v.safeParse(DbSettingSchema, candidate);

	if (!parsed.success) {
		const settingKey = getSettingKey(candidate);
		const error = new SettingsCorruptError(settingKey, parsed.issues);

		log.error('corrupt settings row', {
			err: error,
			...(settingKey === undefined ? {} : { settingKey })
		});

		throw error;
	}

	return parsed.output;
}

/** Extracts a usable key from an unknown persisted row for corruption diagnostics. */
function getSettingKey(candidate: unknown): string | undefined {
	if (typeof candidate !== 'object' || candidate === null || !('key' in candidate)) {
		return undefined;
	}

	return typeof candidate.key === 'string' ? candidate.key : undefined;
}
