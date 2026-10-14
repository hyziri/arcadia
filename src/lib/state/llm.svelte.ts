/** Loads saved LLM settings and adapts chat history to the OpenAI-compatible API.
 *
 * The provider reads the latest persisted configuration for each request so settings changes take
 * effect without recreating the chat session. Model and API key are omitted when blank because
 * some compatible providers, such as local servers, do not require them.
 *
 * @example
 * ```ts
 * const provider = new LlmProvider();
 * for await (const chunk of provider.generateResponse([{ sender: 'user', content: 'Hello!' }])) {
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
import { getLogger } from '#lib/logger.ts';
import { SettingsService } from '#lib/service';
import type { ChatMessage, ProviderConfig } from '#lib/model';

/** Identifies which required LLM configuration value is missing. */
export type LlmConfigurationIssue = 'provider' | 'endpoint';

/** Indicates that no usable LLM provider configuration is available for a request. */
export class LlmConfigurationError extends AppError {
	readonly kind = 'llm_configuration';
	readonly issue: LlmConfigurationIssue;

	/** Creates an error identifying the missing provider configuration. */
	constructor(issue: LlmConfigurationIssue) {
		super(
			issue === 'provider'
				? 'No LLM provider is configured.'
				: 'The LLM endpoint is not configured.'
		);
		this.issue = issue;
	}
}

/** Logger scoped to LLM provider configuration and request preparation. */
const log = getLogger('state/llm');

/** Adapts configured chat history to the OpenAI-compatible streaming API. */
export class LlmProvider {
	private config: ProviderConfig | null = null;
	private readonly _settingsService: SettingsService;

	/** Creates a provider that reads persisted settings before each request.
	 *
	 * @param settingsService - The service used to load the current provider configuration.
	 */
	constructor(settingsService: SettingsService = new SettingsService()) {
		this._settingsService = settingsService;
	}

	/**
	 * Streams completion chunks for the supplied conversation history.
	 *
	 * @param messages - The conversation history to send to the provider.
	 * @param abortSignal - Optional signal used by the caller to cancel generation.
	 * @yields {OpenAiChatCompletionChunk} Normalized content, reasoning, or finish-reason chunks.
	 * @throws {LlmConfigurationError|AppError|OpenAiError|Error|DOMException} when configuration, storage, or the provider request fails.
	 */
	async *generateResponse(
		messages: ChatMessage[],
		abortSignal?: AbortSignal
	): AsyncGenerator<OpenAiChatCompletionChunk, void, void> {
		this.config = (await this._settingsService.getProviderConfig()) ?? null;
		if (this.config === null) this._throwConfigurationError('provider');

		const endpoint = this.config.endpoint.trim();
		if (endpoint === '') this._throwConfigurationError('endpoint');

		const credentials: OpenAiCredentials = {
			endpoint,
			...(this.config.model.trim() === '' ? {} : { model: this.config.model }),
			...(this.config.apiKey.trim() === '' ? {} : { apiKey: this.config.apiKey })
		};

		yield* streamOpenAiChat(credentials, this._prepareMessages(messages), abortSignal);
	}

	/** Converts history messages to the request message shape expected by the API. */
	private _prepareMessages(messages: ChatMessage[]): OpenAiMessageRequest[] {
		return messages.map(({ sender, content }) => ({ role: sender, content }));
	}

	/** Logs and creates a typed configuration error at the provider boundary. */
	private _throwConfigurationError(issue: LlmConfigurationIssue): never {
		const error = new LlmConfigurationError(issue);
		log.error('LLM configuration is incomplete', { err: error, issue });
		throw error;
	}
}
