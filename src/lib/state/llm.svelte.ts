/** Streams chat completions from the configured OpenAI-compatible API.
 *
 * The provider captures the public endpoint, model, and API key when constructed. Values
 * supplied through public environment variables are available to browser code and must not
 * be treated as secret credentials.
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
	type OpenAiMessageRequest
} from '../api';
import { LLM_ENDPOINT, LLM_MODEL, LLM_API_KEY } from '$app/env/public';

import type { ChatMessage, ProviderConfig } from '../model';

/** Adapts chat history to the configured OpenAI-compatible streaming API. */
export class LlmProvider {
	private config: ProviderConfig;

	/** Creates a provider using the configured endpoint, model, and API key. */
	constructor() {
		this.config = {
			endpoint: LLM_ENDPOINT,
			model: LLM_MODEL,
			apiKey: LLM_API_KEY
		};
	}

	/**
	 * Streams completion chunks for the supplied conversation history.
	 *
	 * @param messages - The conversation history to send to the provider.
	 * @param abortSignal - Optional signal used by the caller to cancel generation.
	 * @yields {OpenAiChatCompletionChunk} Normalized content, reasoning, or finish-reason chunks.
	 * @throws {import('../api').OpenAiError} when the provider request or stream fails.
	 */
	async *generateResponse(
		messages: ChatMessage[],
		abortSignal?: AbortSignal
	): AsyncGenerator<OpenAiChatCompletionChunk, void, void> {
		yield* streamOpenAiChat(this.config, this._prepareMessages(messages), abortSignal);
	}

	/** Converts chat history into the OpenAI-compatible request message shape. */
	private _prepareMessages(messages: ChatMessage[]): OpenAiMessageRequest[] {
		return messages.map(({ sender, content }) => ({
			role: sender,
			content
		}));
	}
}
