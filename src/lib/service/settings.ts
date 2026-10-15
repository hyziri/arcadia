/** Coordinates validation and persistence of application settings.
 *
 * The service exposes settings in domain-friendly forms while the repository remains responsible
 * for IndexedDB access. The LLM provider configuration is serialized under one namespaced key and
 * validated both before saving and after loading.
 *
 * @example
 * ```ts
 * import { getDatabase } from '#lib/db';
 * import { SettingsService } from '#lib/service';
 *
 * const database = await getDatabase();
 * const settingsService = new SettingsService(database);
 * const providerConfig = await settingsService.getProviderConfig();
 * ```
 */

import * as v from 'valibot';

import type { Database } from '#lib/db';
import { SettingsRepo } from '#lib/data';
import { AppError } from '#lib/error';
import { getLogger } from '#lib/logger';
import { ProviderConfigSchema, type ProviderConfig } from '#lib/model';

/** IndexedDB key used for the serialized LLM provider configuration. */
const PROVIDER_CONFIG_SETTING_KEY = 'llm.providerConfig';

/** Logger scoped to application settings orchestration. */
const log = getLogger('service/settings');

/** Options describing why a serialized provider configuration is invalid. */
interface SettingsConfigCorruptErrorOptions {
	cause?: unknown;
	issues?: readonly v.InferIssue<typeof ProviderConfigSchema>[];
}

/** Indicates that the stored LLM provider configuration cannot be parsed or validated. */
export class SettingsConfigCorruptError extends AppError {
	readonly kind = 'settings_config_corrupt';
	readonly settingKey: string;
	readonly issues: readonly v.InferIssue<typeof ProviderConfigSchema>[] | undefined;

	/** Creates an error describing an invalid serialized provider configuration. */
	constructor(settingKey: string, options: SettingsConfigCorruptErrorOptions = {}) {
		super(
			`Stored setting is invalid: ${settingKey}`,
			options.cause === undefined ? undefined : { cause: options.cause }
		);
		this.settingKey = settingKey;
		this.issues = options.issues;
	}
}

/** Provides application-level access to persisted settings used by the UI. */
export class SettingsService {
	private readonly _settingsRepo: SettingsRepo;

	/** Creates a settings service backed by the supplied database connection. */
	constructor(database: Database) {
		this._settingsRepo = new SettingsRepo(database);
	}

	/**
	 * Loads and validates the saved LLM provider configuration.
	 *
	 * @returns The provider configuration, or `undefined` when none has been saved.
	 * @throws {SettingsConfigCorruptError|SettingsCorruptError|SettingsDatabaseError|Error|DOMException} when stored data is invalid or cannot be read.
	 */
	async getProviderConfig(): Promise<ProviderConfig | undefined> {
		log.trace('getProviderConfig enter');

		const setting = await this._settingsRepo.get(PROVIDER_CONFIG_SETTING_KEY);
		if (setting === undefined) {
			return undefined;
		}

		return parseProviderConfig(setting.value);
	}

	/**
	 * Validates and saves the LLM provider configuration.
	 *
	 * @param providerConfig - The endpoint, model, and API key to persist.
	 * @returns A promise that resolves when the configuration is stored.
	 * @throws {v.ValiError|SettingsDatabaseError|Error|DOMException} when input validation or the IndexedDB write fails.
	 */
	async saveProviderConfig(providerConfig: ProviderConfig): Promise<void> {
		log.trace('saveProviderConfig enter');

		const validatedConfig = v.parse(ProviderConfigSchema, providerConfig);
		await this._settingsRepo.set(PROVIDER_CONFIG_SETTING_KEY, JSON.stringify(validatedConfig));
	}

	/**
	 * Deletes the saved LLM provider configuration.
	 *
	 * @returns A promise that resolves when the configuration is deleted.
	 * @throws {SettingsDatabaseError|Error|DOMException} when the settings store cannot be updated.
	 */
	async deleteProviderConfig(): Promise<void> {
		log.trace('deleteProviderConfig enter');

		await this._settingsRepo.delete(PROVIDER_CONFIG_SETTING_KEY);
	}
}

/** Parses and validates the JSON representation read from the settings store. */
function parseProviderConfig(serializedValue: string): ProviderConfig {
	let candidate: unknown;

	try {
		candidate = JSON.parse(serializedValue);
	} catch (cause: unknown) {
		const error = new SettingsConfigCorruptError(PROVIDER_CONFIG_SETTING_KEY, { cause });
		log.error('stored provider configuration is not valid JSON', {
			err: error,
			settingKey: PROVIDER_CONFIG_SETTING_KEY
		});
		throw error;
	}

	const parsed = v.safeParse(ProviderConfigSchema, candidate);
	if (!parsed.success) {
		const error = new SettingsConfigCorruptError(PROVIDER_CONFIG_SETTING_KEY, {
			issues: parsed.issues
		});
		log.error('stored provider configuration is invalid', {
			err: error,
			settingKey: PROVIDER_CONFIG_SETTING_KEY
		});
		throw error;
	}

	return parsed.output;
}
