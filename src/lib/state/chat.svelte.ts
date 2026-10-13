/** Manages reactive state and operations for a streamed chat conversation.
 *
 * User messages are trimmed and ignored when blank or while another response is generating.
 * Assistant text is appended as chunks arrive; failures are exposed through `generationError`,
 * and stopping preserves any partial response.
 *
 * @example
 * ```ts
 * import { ChatSession } from './chat.svelte';
 * import { LlmProvider } from './llm.svelte';
 *
 * const chat = new ChatSession(new LlmProvider());
 * await chat.sendMessage('Hello!');
 * console.log(chat.messages);
 * ```
 */

import type { ChatMessage } from '../model';
import type { LlmProvider } from './llm.svelte';

/** Owns one conversation's reactive message history and response-generation lifecycle. */
export class ChatSession {
	/** Reactive conversation history, including any partial assistant response. */
	messages: ChatMessage[] = $state([]);

	/** Whether an assistant response is currently being generated. */
	isGenerating = $state(false);

	/** The latest generation failure message, or `null` when no failure is active. */
	generationError: string | null = $state(null);

	readonly _llm: LlmProvider;
	private _abortController: AbortController | null = null;

	/** Creates a chat session backed by the supplied language model provider.
	 *
	 * @param llm - The provider used to stream assistant responses.
	 */
	constructor(llm: LlmProvider) {
		this._llm = llm;
	}

	/**
	 * Adds a user message and streams the assistant response into the conversation.
	 *
	 * @param content - The user's message text.
	 * @returns Resolves when generation finishes or fails; inspect `generationError` for failures.
	 */
	async sendMessage(content: string): Promise<void> {
		const trimmedContent = content.trim();
		if (trimmedContent === '' || this.isGenerating) return;

		this.messages.push({ sender: 'user', content: trimmedContent });
		return this._generateAssistantResponse();
	}

	/** Aborts the active response stream while preserving any received content.
	 *
	 * @returns Nothing.
	 */
	stopGeneration(): void {
		this._abortController?.abort();
	}

	/** Owns one response's cancellation, streaming, and cleanup lifecycle. */
	private async _generateAssistantResponse(): Promise<void> {
		this.isGenerating = true;
		this.generationError = null;

		const abortController = new AbortController();
		this._abortController = abortController;
		const requestMessages = this.messages.map(({ sender, content }) => ({ sender, content }));
		const assistantMessageIndex = this.messages.push({ sender: 'assistant', content: '' }) - 1;

		try {
			await this._appendResponseChunks(
				requestMessages,
				assistantMessageIndex,
				abortController.signal
			);
		} catch (cause: unknown) {
			if (!abortController.signal.aborted) {
				this.generationError =
					cause instanceof Error ? cause.message : 'Failed to generate a response.';
			}
		} finally {
			if (this.messages[assistantMessageIndex]?.content === '') {
				this.messages.splice(assistantMessageIndex, 1);
			}
			if (this._abortController === abortController) this._abortController = null;
			this.isGenerating = false;
		}
	}

	/** Applies each streamed content delta to the assistant message in reactive history. */
	private async _appendResponseChunks(
		requestMessages: ChatMessage[],
		assistantMessageIndex: number,
		abortSignal: AbortSignal
	): Promise<void> {
		for await (const chunk of this._llm.generateResponse(requestMessages, abortSignal)) {
			if (chunk.content === undefined) continue;

			const assistantMessage = this.messages[assistantMessageIndex];
			if (assistantMessage !== undefined) assistantMessage.content += chunk.content;
		}
	}
}
