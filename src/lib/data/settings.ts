/** Persists and validates application settings in IndexedDB.
 *
 * Settings are stored as string values keyed by setting name. Reads validate persisted rows so
 * malformed data from an older version or manual edits fail with a typed corruption error. Operations
 * can join a caller-owned transaction when they need to be atomic with other stores.
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

import { getDatabase, withTransaction, type ArcadiaTransaction } from '#lib/db';
import { AppError } from '#lib/error';
import { getLogger } from '#lib/logger';

/** Validates the persisted row shape for the settings store. */
export const DbSettingSchema = v.strictObject({
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
	 * @param transaction - Optional caller-owned transaction spanning related persistence operations.
	 * @returns A promise that resolves when the setting is stored.
	 * @throws {v.ValiError|SettingsDatabaseError|TransactionScopeError|OperationTimeoutError} when validation or persistence fails.
	 */
	async set(
		settingKey: string,
		value: string,
		transaction?: ArcadiaTransaction<'readwrite'>
	): Promise<void> {
		log.trace('set enter', { settingKey });

		const setting = v.parse(DbSettingSchema, { key: settingKey, value });
		try {
			await withTransaction(
				await getDatabase(),
				['settings'],
				'readwrite',
				transaction,
				async (tx) => {
					await tx.objectStore('settings').put(setting);
				}
			);
		} catch (cause: unknown) {
			throwDatabaseFailure('write', settingKey, cause);
		}

		log.debug('setting saved', { settingKey });
	}

	/**
	 * Gets one setting by its key.
	 *
	 * @param settingKey - The setting name to retrieve.
	 * @param transaction - Optional caller-owned transaction containing the settings store.
	 * @returns The validated setting, or `undefined` if it does not exist.
	 * @throws {SettingsCorruptError|SettingsDatabaseError|TransactionScopeError|OperationTimeoutError} when the row is corrupt or the read fails.
	 */
	async get(settingKey: string, transaction?: ArcadiaTransaction): Promise<DbSetting | undefined> {
		log.trace('get enter', { settingKey });

		let storedRow: unknown;
		try {
			storedRow = await withTransaction(
				await getDatabase(),
				['settings'],
				'readonly',
				transaction,
				async (tx) => tx.objectStore('settings').get(settingKey)
			);
		} catch (cause: unknown) {
			throwDatabaseFailure('read', settingKey, cause);
		}

		if (storedRow === undefined) {
			return undefined;
		}

		return parseSetting(storedRow);
	}

	/**
	 * Deletes one setting by its key.
	 *
	 * @param settingKey - The setting name to delete.
	 * @param transaction - Optional caller-owned transaction spanning related persistence operations.
	 * @returns A promise that resolves when the setting is deleted.
	 * @throws {SettingsDatabaseError|TransactionScopeError|OperationTimeoutError} when deletion fails.
	 */
	async delete(settingKey: string, transaction?: ArcadiaTransaction<'readwrite'>): Promise<void> {
		log.trace('delete enter', { settingKey });

		try {
			await withTransaction(
				await getDatabase(),
				['settings'],
				'readwrite',
				transaction,
				async (tx) => {
					await tx.objectStore('settings').delete(settingKey);
				}
			);
		} catch (cause: unknown) {
			throwDatabaseFailure('delete', settingKey, cause);
		}

		log.debug('setting deleted', { settingKey });
	}
}

/** Preserves typed errors and wraps/logs other failures at the repository boundary. */
function throwDatabaseFailure(
	operation: 'read' | 'write' | 'delete',
	settingKey: string | undefined,
	cause: unknown
): never {
	if (cause instanceof AppError) throw cause;

	const error = new SettingsDatabaseError(operation, settingKey, { cause });
	log.error(`settings ${operation} failed`, {
		err: error,
		...(settingKey === undefined ? {} : { settingKey })
	});
	throw error;
}

/** Validates a row read from IndexedDB and reports corruption at the repository boundary. */
function parseSetting(storedRow: unknown): DbSetting {
	const parsed = v.safeParse(DbSettingSchema, storedRow);

	if (!parsed.success) {
		const settingKey = getSettingKey(storedRow);
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
function getSettingKey(storedRow: unknown): string | undefined {
	if (typeof storedRow !== 'object' || storedRow === null || !('key' in storedRow)) {
		return undefined;
	}

	return typeof storedRow.key === 'string' ? storedRow.key : undefined;
}
