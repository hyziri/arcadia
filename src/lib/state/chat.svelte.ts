/** Manages reactive state and operations for a streamed chat conversation.
 *
 * User messages are trimmed and ignored when blank or while another response is generating.
 * Assistant text is streamed into history; regeneration keeps the previous answer until new
 * content arrives. Failures are exposed through `generationError`, and stopping preserves partial content.
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

	/** Clears the conversation history to start a new chat.
	 *
	 * @returns Resolves after the conversation history is cleared.
	 */
	async newChat(): Promise<void> {
		this.messages = [];
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

	/** Regenerates the final assistant message, or responds to the current history if it is not assistant-authored.
	 *
	 * @returns Resolves when generation finishes or is ignored because another response is active.
	 */
	async regenerateLastMessage(): Promise<void> {
		if (this.isGenerating) return;

		const lastMessageIndex = this.messages.length - 1;
		const lastMessage = this.messages[lastMessageIndex];
		const replaceIndex = lastMessage?.sender === 'assistant' ? lastMessageIndex : undefined;

		return this._generateAssistantResponse(replaceIndex);
	}

	/** Aborts the active response stream while preserving any received content.
	 *
	 * @returns Nothing.
	 */
	stopGeneration(): void {
		this._abortController?.abort();
	}

	/** Owns one response's cancellation, streaming, and cleanup lifecycle. */
	private async _generateAssistantResponse(replaceIndex?: number): Promise<void> {
		this.isGenerating = true;
		this.generationError = null;

		const abortController = new AbortController();
		this._abortController = abortController;
		const requestEndIndex = replaceIndex ?? this.messages.length;
		const requestMessages = this.messages
			.slice(0, requestEndIndex)
			.map(({ sender, content }) => ({ sender, content }));
		const createsAssistantMessage = replaceIndex === undefined;
		const assistantMessageIndex = createsAssistantMessage
			? this.messages.push({ sender: 'assistant', content: '' }) - 1
			: replaceIndex;

		try {
			await this._appendResponseChunks(
				requestMessages,
				assistantMessageIndex,
				abortController.signal,
				replaceIndex !== undefined
			);
		} catch (cause: unknown) {
			if (!abortController.signal.aborted) {
				this.generationError =
					cause instanceof Error ? cause.message : 'Failed to generate a response.';
			}
		} finally {
			if (createsAssistantMessage && this.messages[assistantMessageIndex]?.content === '') {
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
		abortSignal: AbortSignal,
		replaceOnFirstChunk: boolean
	): Promise<void> {
		let isFirstContentChunk = true;
		for await (const chunk of this._llm.generateResponse(requestMessages, abortSignal)) {
			if (chunk.content === undefined || chunk.content === '') continue;

			const assistantMessage = this.messages[assistantMessageIndex];
			if (assistantMessage === undefined) continue;

			if (replaceOnFirstChunk && isFirstContentChunk) {
				assistantMessage.content = chunk.content;
			} else {
				assistantMessage.content += chunk.content;
			}
			isFirstContentChunk = false;
		}
	}
}
