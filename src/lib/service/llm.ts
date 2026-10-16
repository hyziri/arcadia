/** Resolves saved LLM settings and streams chat history through an OpenAI-compatible API.
 *
 * The service reads the latest persisted configuration for each request, so saved setting changes
 * apply to the next request without recreating the service or chat session. Blank model and API key
 * values are omitted for compatible providers that do not require them.
 *
 * @example
 * ```ts
 * import { getDatabase } from '#lib/db';
 * import { LlmService, SettingsService } from '#lib/service';
 *
 * const settingsService = new SettingsService(await getDatabase());
 * const llmService = new LlmService(settingsService);
 * for await (const chunk of llmService.generateResponse([{ sender: 'user', content: 'Hello!' }])) {
 * 	if (chunk.content !== undefined) console.log(chunk.content);
 * }
 * ```
 */

import {
	streamOpenAiChat,
	type OpenAiChatCompletionChunk,
	type OpenAiCredentials,
	type OpenAiMessageRequest
} from '#lib/api';
import { AppError } from '#lib/error';
import type { ChatMessage } from '#lib/model';
import { getLogger } from '#lib/logger.ts';

import type { SettingsService } from './settings.ts';

/** Identifies which required LLM configuration value is missing. */
export type LlmConfigurationIssue = 'provider' | 'endpoint';

/** Indicates that a request lacks a usable LLM configuration. */
export class LlmConfigurationError extends AppError {
	readonly kind = 'llm_configuration';
	readonly issue: LlmConfigurationIssue;

	/** Creates an error identifying the missing required configuration value. */
	constructor(issue: LlmConfigurationIssue) {
		super(
			issue === 'provider'
				? 'No LLM provider is configured.'
				: 'The LLM endpoint is not configured.'
		);
		this.issue = issue;
	}
}

/** Logger scoped to LLM service configuration and request preparation. */
const log = getLogger('service/llm');

/** Resolves request-time LLM settings and streams adapted chat history to the configured API. */
export class LlmService {
	private readonly _settingsService: SettingsService;

	/** Creates an LLM service backed by the supplied settings service. */
	constructor(settingsService: SettingsService) {
		this._settingsService = settingsService;
	}

	/**
	 * Streams completion chunks for the supplied conversation history.
	 *
	 * @param messages - The conversation history to send to the provider.
	 * @param abortSignal - Optional signal used by the caller to cancel generation.
	 * @yields {OpenAiChatCompletionChunk} Normalized content, reasoning, or finish-reason chunks.
	 * @throws {LlmConfigurationError|SettingsConfigCorruptError|SettingsCorruptError|SettingsDatabaseError|OpenAiError|Error|DOMException} when configuration, settings storage, or the API request fails.
	 */
	async *generateResponse(
		messages: ChatMessage[],
		abortSignal?: AbortSignal
	): AsyncGenerator<OpenAiChatCompletionChunk, void, void> {
		const config = await this._settingsService.getProviderConfig();
		if (config === undefined) this._throwConfigurationError('provider');

		const endpoint = config.endpoint.trim();
		if (endpoint === '') this._throwConfigurationError('endpoint');

		const credentials: OpenAiCredentials = {
			endpoint,
			...(config.model.trim() === '' ? {} : { model: config.model }),
			...(config.apiKey.trim() === '' ? {} : { apiKey: config.apiKey })
		};

		yield* streamOpenAiChat(credentials, this._prepareMessages(messages), abortSignal);
	}

	/** Converts history messages to the request message shape expected by the API. */
	private _prepareMessages(messages: ChatMessage[]): OpenAiMessageRequest[] {
		return messages.map(({ sender, content }) => ({ role: sender, content }));
	}

	/** Logs and creates a typed configuration error at the service boundary. */
	private _throwConfigurationError(issue: LlmConfigurationIssue): never {
		const error = new LlmConfigurationError(issue);
		log.error('LLM configuration is incomplete', { err: error, issue });
		throw error;
	}
}
