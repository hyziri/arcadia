/** Lazily initializes the shared database and application services. */

import { getDatabase, type Database, type DatabasePromise } from '#lib/db';
import { getLogger } from '#lib/logger';
import { SettingsService, LlmService, VersionControlService, ChatService } from '#lib/service';

import { GarbageCollectionService } from '../service/version-control/garbage-collection';

/** Logger scoped to shared application state initialization. */
const log = getLogger('state/app');

/** Provides lazily initialized shared persistence services to application components. */
export class AppState {
	private _db: DatabasePromise | undefined;
	private _settingsService: SettingsService | undefined;
	private _llmService: LlmService | undefined;
	private _chatService: ChatService | undefined;
	private _versionControlService: VersionControlService | undefined;
	private _garbageCollectionService: GarbageCollectionService | undefined;
	private _recoveryScheduled = false;

	/**
	 * Initializes the application database once.
	 *
	 * @returns The shared database connection.
	 * @throws {Error|DOMException} when IndexedDB is unavailable or cannot be opened.
	 */
	initialize(): DatabasePromise {
		log.trace('initialize enter');
		if (this._db !== undefined) return this._db;

		const databasePromise = getDatabase();
		this._db = databasePromise;
		void databasePromise.catch(() => {
			if (this._db === databasePromise) this._db = undefined;
		});

		if (!this._recoveryScheduled) {
			this._recoveryScheduled = true;
			void databasePromise
				.then((database) => {
					this._getGarbageCollectionService(database).recoverJobs();
				})
				.catch(() => {
					this._recoveryScheduled = false;
				});
		}

		return databasePromise;
	}

	/**
	 * Returns the database promise after initialization has started.
	 *
	 * @returns The shared database promise, or `undefined` before initialization starts.
	 */
	get db(): DatabasePromise | undefined {
		return this._db;
	}

	/**
	 * Returns the shared settings service.
	 *
	 * @returns The lazily initialized settings service.
	 * @throws {Error|DOMException} when the database cannot be opened.
	 */
	async getSettingsService(): Promise<SettingsService> {
		log.trace('getSettingsService enter');
		if (this._settingsService !== undefined) return this._settingsService;

		const database = await this.initialize();
		return (this._settingsService ??= new SettingsService(database));
	}

	/**
	 * Returns the shared LLM service.
	 *
	 * @returns The lazily initialized LLM service.
	 * @throws {Error|DOMException} when the database cannot be opened.
	 */
	async getLlmService(): Promise<LlmService> {
		log.trace('getLlmService enter');
		if (this._llmService !== undefined) return this._llmService;

		return (this._llmService ??= new LlmService(await this.getSettingsService()));
	}

	/**
	 * Returns the shared chat service.
	 *
	 * @returns The lazily initialized chat service.
	 * @throws {Error|DOMException} when the database cannot be opened.
	 */
	async getChatService(): Promise<ChatService> {
		log.trace('getChatService enter');
		if (this._chatService !== undefined) return this._chatService;

		const database = await this.initialize();
		return (this._chatService ??= new ChatService(
			database,
			await this._getVersionControlService()
		));
	}

	/**
	 * Returns the shared version-control service.
	 *
	 * @returns The lazily initialized version-control service.
	 * @throws {Error|DOMException} when the database cannot be opened.
	 */
	private async _getVersionControlService(): Promise<VersionControlService> {
		log.trace('getVersionControlService enter');
		if (this._versionControlService !== undefined) return this._versionControlService;

		const database = await this.initialize();
		return (this._versionControlService ??= new VersionControlService(
			database,
			this._getGarbageCollectionService(database)
		));
	}

	/** Returns the single collector shared by startup recovery and version-control operations. */
	private _getGarbageCollectionService(database: Database): GarbageCollectionService {
		return (this._garbageCollectionService ??= new GarbageCollectionService(database));
	}
}

/** Application-wide lazy state and service registry. */
export const appState = new AppState();
