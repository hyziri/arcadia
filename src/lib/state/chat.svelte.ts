/** Coordinates a persisted chat's reactive history with runtime LLM generation.
 *
 * User messages are persisted before generation. Assistant responses use a temporary session-only
 * entry while streaming, then receive a commit ID when saved; partial text is retained and saved
 * when generation stops or fails after producing content.
 */

import { OpenAiAbortError } from '#lib/api';
import { AppError } from '#lib/error';
import type { ChatService, LlmService } from '#lib/service';
import {
	loaded,
	LoadState,
	type ChatHistoryEntry,
	type ChatMessage,
	type LoadStateType
} from '#lib/model';

/** A message view with a durable history occurrence. */
interface PersistedChatMessageView extends ChatMessage {
	commitId: string;
	viewId: string;
}

/** A session-only response that has not yet been persisted. */
interface PendingChatMessageView extends ChatMessage {
	commitId: null;
	viewId: string;
}

/** Chat message data presented by the session, including commit metadata and transient responses. */
export type ChatMessageView = PersistedChatMessageView | PendingChatMessageView;

interface ActiveChat {
	chatCatalogId: string;
	refId: string;
	messages: ChatMessageView[];
}

/** States for the chat session's message-sending and response-generation workflow. */
export const GenerationState = {
	Idle: 'idle',
	Sending: 'sending',
	Generating: 'generating'
};
/** The current send or response-generation state of a chat session. */
export type GenerationState = (typeof GenerationState)[keyof typeof GenerationState];

/** Indicates that response generation failed and the partial response could not be saved. */
export class ChatGenerationAndPersistenceError extends AppError {
	readonly kind = 'chat_generation_and_persistence';
	readonly generationCause: unknown;
	readonly persistenceCause: unknown;

	/** Creates an error retaining both failures.
	 *
	 * @param generationCause - The failure that ended response generation.
	 * @param persistenceCause - The failure that prevented saving the response.
	 */
	constructor(generationCause: unknown, persistenceCause: unknown) {
		super(
			`Response generation failed: ${failureMessage(generationCause)}. Saving the partial response also failed: ${failureMessage(persistenceCause)}`,
			{ cause: persistenceCause }
		);
		this.generationCause = generationCause;
		this.persistenceCause = persistenceCause;
	}
}

const NO_GENERATION_FAILURE = Symbol('no generation failure');
const DEFAULT_MESSAGES_PER_PAGE = 20;

/** Owns the active chat view and coordinates persistence with streamed response generation. */
export class ChatSession {
	/** Current state of the session's send or response-generation workflow. */
	generationState = $state(GenerationState.Idle);

	private readonly _resolveChatService: () => Promise<ChatService>;
	private readonly _resolveLlmService: () => Promise<LlmService>;
	private _activeChatState: LoadStateType<ActiveChat | null> = $state({
		state: LoadState.NotLoaded
	});
	private _chatLoadPromise: Promise<void> | undefined;
	private _abortController: AbortController | null = null;
	/** Invalidates asynchronous results from older chat loads, switches, or generations. */
	private _activeChatRevision = 0;

	/** Creates a chat session backed by lazily resolved chat and LLM services.
	 *
	 * @param resolveChatService - Resolves the persistence service for chat history operations.
	 * @param resolveLlmService - Resolves the service that generates streamed responses.
	 */
	constructor(
		resolveChatService: () => Promise<ChatService>,
		resolveLlmService: () => Promise<LlmService>
	) {
		this._resolveChatService = resolveChatService;
		this._resolveLlmService = resolveLlmService;
	}

	/** Clears the active selection; the next sent message creates a new persisted chat.	 */
	newChat(): void {
		if (this.generationState !== GenerationState.Idle) return;

		this._activeChatRevision += 1;
		this._chatLoadPromise = undefined;
		this.stopGeneration();
		this._activeChatState = { state: LoadState.Loaded, data: null };
	}

	/** Loads the most recently updated chat and its default-ref history.
	 *
	 * @returns A promise that resolves after the active chat is loaded.
	 * @throws {AppError|DOMException|import('valibot').ValiError} when chat data cannot be read.
	 */
	loadMostRecentChat(): Promise<void> {
		if (this._activeChatState.state === LoadState.Loading && this._chatLoadPromise !== undefined) {
			return this._chatLoadPromise;
		}

		const revision = ++this._activeChatRevision;
		this._activeChatState.state = LoadState.Loading;
		this.stopGeneration();

		const loadPromise = this._loadMostRecentChat(revision)
			.catch((cause: unknown) => {
				if (revision === this._activeChatRevision)
					this._activeChatState = { state: LoadState.Error, error: cause };
				throw cause;
			})
			.finally(() => {
				if (revision === this._activeChatRevision) this._chatLoadPromise = undefined;
			});
		this._chatLoadPromise = loadPromise;
		return loadPromise;
	}

	/** Reports whether the active chat state is currently loading. */
	get isLoading(): boolean {
		return this._activeChatState.state === LoadState.Loading;
	}

	/** Retrieves and applies the latest chat only while its load revision remains current. */
	private async _loadMostRecentChat(revision: number): Promise<void> {
		const chatService = await this._resolveChatService();
		const [recentChat] = await chatService.getRecentChats({ page: 1, perPage: 1 });
		if (revision !== this._activeChatRevision) return;
		if (recentChat === undefined) {
			this._activeChatState = loaded<ActiveChat | null>(null);
			return;
		}

		const { catalog, ref } = await chatService.getChatById(recentChat.id);
		if (revision !== this._activeChatRevision) return;
		if (ref === null) {
			this._activeChatState = loaded<ActiveChat | null>(null);
			return;
		}

		const history =
			ref.targetCommitId === null
				? []
				: await chatService.getMessageHistory(ref.targetCommitId, DEFAULT_MESSAGES_PER_PAGE);
		if (revision !== this._activeChatRevision) return;

		this._activeChatState = loaded<ActiveChat | null>({
			chatCatalogId: catalog.id,
			refId: ref.id,
			messages: [...history].reverse().map(toPersistedMessageView)
		});
	}

	/** Returns the active chat's stable chronological messages with commit IDs for message actions.
	 *
	 * Transient or unsaved assistant responses have a `null` commit ID.
	 *
	 * @returns The active chat's reactive message array, or an empty array when no chat is active.
	 */
	get messages(): ChatMessageView[] {
		const state = this._activeChatState;
		return state.state === LoadState.Loaded ? (state.data?.messages ?? []) : [];
	}

	/** Aborts the active response stream while retaining and persisting any received partial text.
	 *
	 * @returns Nothing.
	 */
	stopGeneration(): void {
		this._abortController?.abort();
	}

	/** Persists a user message while preventing overlapping sends or response generation.
	 *
	 * @param content - The user's message text.
	 * @returns Whether the message was persisted and its originating chat remained current.
	 * @throws {AppError|DOMException|import('valibot').ValiError} when chat creation or message persistence fails.
	 */
	async sendMessage(content: string): Promise<boolean> {
		const trimmedContent = content.trim();
		if (
			!trimmedContent ||
			this._activeChatState.state === LoadState.Loading ||
			this._activeChatState.state === LoadState.Error ||
			this.generationState !== GenerationState.Idle
		)
			return false;

		this.generationState = GenerationState.Sending;
		try {
			const revision = ++this._activeChatRevision;
			const activeChat = await this._ensureActiveChat(revision);
			if (activeChat === undefined) return false;
			if (!this._isCurrentChat(activeChat, revision)) return false;

			const persistedMessage = await this._persistMessage(activeChat, {
				sender: 'user',
				content: trimmedContent
			});
			if (!this._isCurrentChat(activeChat, revision)) return false;
			this._appendPersistedMessage(activeChat, persistedMessage);
			return true;
		} finally {
			this.generationState = GenerationState.Idle;
		}
	}

	/** Regenerates the final assistant message, or generates a new response when the history has no replaceable assistant tail.
	 *
	 * @returns Resolves after generation and persistence complete, or when no loaded chat is available or generation is already active.
	 * @throws {AppError|DOMException|import('valibot').ValiError} when generation or persistence fails.
	 */
	async regenerateResponse(): Promise<void> {
		if (this.generationState !== GenerationState.Idle) return;

		const activeChatState = this._activeChatState;
		if (activeChatState.state !== 'loaded' || activeChatState.data === null) return;
		const activeChat = activeChatState.data;

		const replacement = getLastAssistantMessage(activeChat.messages);
		if (replacement === undefined) return await this._generateResponse(activeChat);
		const { message: replaceMessage, index: replaceIndex } = replacement;

		const revision = ++this._activeChatRevision;
		await this._generateAndPersist(getMessagesForRequest(activeChat.messages, replaceIndex), {
			onFirstChunk: () => setDraftMessageAtIndex(activeChat, replaceIndex, replaceMessage.viewId),
			onPersist: async (generatedMessage) => {
				const chatService = await this._resolveChatService();
				return await chatService.replaceMessage(
					activeChat.chatCatalogId,
					activeChat.refId,
					replaceMessage.commitId,
					toChatMessage(generatedMessage)
				);
			},
			afterPersist: (persistedMessage) => {
				if (!this._isCurrentChat(activeChat, revision)) return;
				this._appendPersistedMessage(activeChat, persistedMessage, replaceIndex);
			},
			onPersistFailure: (pendingMessage) =>
				this._restorePendingMessage(activeChat, pendingMessage, replaceMessage)
		});
	}

	/** Generates and persists a new assistant response for the loaded active chat.
	 *
	 * @returns Resolves after generation and persistence complete, or when no loaded chat is available or generation is already active.
	 * @throws {AppError|DOMException|import('valibot').ValiError} when generation or persistence fails.
	 */
	async generateResponse(): Promise<void> {
		if (this.generationState !== GenerationState.Idle) return;

		const activeChatState = this._activeChatState;
		if (activeChatState.state !== 'loaded' || activeChatState.data === null) return;

		const activeChat = activeChatState.data;

		await this._generateResponse(activeChat);
	}

	/** Generates and persists a new assistant message using append semantics. */
	private async _generateResponse(activeChat: ActiveChat) {
		const revision = ++this._activeChatRevision;
		const pendingIndex = activeChat.messages.length;

		await this._generateAndPersist(getMessagesForRequest(activeChat.messages), {
			onFirstChunk: () => setDraftMessageAtIndex(activeChat, pendingIndex, `pending:${revision}`),
			onPersist: async (generatedMessage) => {
				const chatService = await this._resolveChatService();
				return await chatService.addMessage(
					activeChat.chatCatalogId,
					activeChat.refId,
					toChatMessage(generatedMessage)
				);
			},
			afterPersist: (persistedMessage) => {
				if (!this._isCurrentChat(activeChat, revision)) return;
				this._appendPersistedMessage(activeChat, persistedMessage, pendingIndex);
			}
		});
	}

	/** Coordinates streaming, partial-response persistence, reconciliation, and generation-state cleanup. */
	private async _generateAndPersist(
		requestMessages: ChatMessage[],
		options: {
			onFirstChunk: () => PendingChatMessageView;
			onPersist: (generatedMessage: PendingChatMessageView) => Promise<ChatHistoryEntry>;
			afterPersist: (persistedMessage: ChatHistoryEntry) => void;
			onPersistFailure?: (pendingMessage: PendingChatMessageView) => void;
		}
	) {
		try {
			this.generationState = GenerationState.Generating;
			let generationFailure: unknown = NO_GENERATION_FAILURE;

			let pendingMessage: PendingChatMessageView | undefined;
			try {
				await this._handleGeneration(requestMessages, () => {
					const message = options.onFirstChunk();
					pendingMessage = message;
					return message;
				});
			} catch (cause: unknown) {
				generationFailure = cause;
			}

			if (pendingMessage === undefined) {
				if (generationFailure !== NO_GENERATION_FAILURE) throw generationFailure;
				return undefined;
			}

			let persistedMessage: ChatHistoryEntry;
			try {
				persistedMessage = await options.onPersist(pendingMessage);
			} catch (persistenceFailure: unknown) {
				if (options.onPersistFailure) {
					options.onPersistFailure(pendingMessage);
				}
				if (generationFailure !== NO_GENERATION_FAILURE) {
					throw new ChatGenerationAndPersistenceError(generationFailure, persistenceFailure);
				}

				throw persistenceFailure;
			}

			options.afterPersist(persistedMessage);

			if (generationFailure !== NO_GENERATION_FAILURE) throw generationFailure;
		} finally {
			this.generationState = GenerationState.Idle;
		}
	}

	/** Streams response chunks into the transient message and suppresses expected cancellation. */
	private async _handleGeneration(
		requestMessages: ChatMessage[],
		onFirstChunk: () => PendingChatMessageView
	) {
		const abortController = new AbortController();
		this._abortController = abortController;

		try {
			const llmService = await this._resolveLlmService();

			let pendingMessage: PendingChatMessageView | undefined = undefined;
			for await (const chunk of llmService.generateResponse(
				requestMessages,
				abortController.signal
			)) {
				if (chunk.content === undefined || chunk.content === '') continue;

				if (!pendingMessage) {
					pendingMessage = onFirstChunk();
				}

				pendingMessage.content += chunk.content;
			}
		} catch (cause: unknown) {
			if (!(abortController.signal.aborted && cause instanceof OpenAiAbortError)) {
				throw cause;
			}
		} finally {
			if (this._abortController === abortController) this._abortController = null;
		}
	}

	/** Persists a message to the supplied chat and returns its committed history entry. */
	private async _persistMessage(
		activeChat: ActiveChat,
		message: ChatMessage
	): Promise<ChatHistoryEntry> {
		const chatService = await this._resolveChatService();
		return await chatService.addMessage(activeChat.chatCatalogId, activeChat.refId, message);
	}

	/** Appends a committed message or replaces the transient row at the supplied index. */
	private _appendPersistedMessage(
		activeChat: ActiveChat,
		message: ChatHistoryEntry,
		replaceIndex: number = -1
	) {
		const persistedMessage = toPersistedMessageView(message);
		const replacedMessage = activeChat.messages[replaceIndex];
		if (replaceIndex >= 0 && replacedMessage !== undefined) {
			activeChat.messages[replaceIndex] = {
				...persistedMessage,
				viewId: replacedMessage.viewId
			};
		} else {
			activeChat.messages.push(persistedMessage);
		}
	}

	/** Restores the replaced entry, or removes a new transient message that cannot be saved. */
	private _restorePendingMessage(
		activeChat: ActiveChat,
		pendingMessage: PendingChatMessageView,
		replaceMessage: PersistedChatMessageView | undefined
	): void {
		const pendingIndex = activeChat.messages.findIndex(
			(message) => message.viewId === pendingMessage.viewId
		);
		if (pendingIndex < 0) return;

		if (replaceMessage === undefined) {
			activeChat.messages.splice(pendingIndex, 1);
		} else {
			activeChat.messages[pendingIndex] = replaceMessage;
		}
	}

	/** Checks that an asynchronous operation still targets the selected chat session. */
	private _isCurrentChat(activeChat: ActiveChat, revision: number): boolean {
		const state = this._activeChatState;
		return (
			state.state === 'loaded' &&
			state.data?.chatCatalogId === activeChat.chatCatalogId &&
			state.data?.refId === activeChat.refId &&
			this._activeChatRevision === revision
		);
	}

	/** Lazily creates a chat for the first sent message. */
	private async _ensureActiveChat(revision: number): Promise<ActiveChat | undefined> {
		if (revision !== this._activeChatRevision) return undefined;
		const state = this._activeChatState;
		if (state.state === LoadState.Loading || state.state === LoadState.Error) return undefined;
		if (state.state === LoadState.Loaded && state.data !== null) return state.data;

		const chatService = await this._resolveChatService();
		if (revision !== this._activeChatRevision) return undefined;
		const createdChat = await chatService.createChat();
		if (revision !== this._activeChatRevision) return undefined;

		const activeChat: ActiveChat = {
			chatCatalogId: createdChat.catalog.id,
			refId: createdChat.ref.id,
			messages: []
		};
		this._activeChatState = { state: LoadState.Loaded, data: activeChat };
		const currentState = this._activeChatState;
		return currentState.state === 'loaded' ? (currentState.data ?? undefined) : undefined;
	}
}

/** Converts a committed history entry into the session's display model. */
function toPersistedMessageView(entry: ChatHistoryEntry): PersistedChatMessageView {
	return {
		...entry.message,
		commitId: entry.commitId,
		viewId: `commit:${entry.commitId}`
	};
}

/** Inserts a transient assistant message at a history index and returns its reactive view. */
function setDraftMessageAtIndex(
	activeChat: ActiveChat,
	index: number,
	viewId: string
): PendingChatMessageView {
	const pendingDraft: PendingChatMessageView = {
		sender: 'assistant',
		content: '',
		commitId: null,
		viewId: viewId
	};

	activeChat.messages[index] = pendingDraft;
	const pendingMessage = activeChat.messages[index];
	return pendingMessage;
}

/** Builds the committed history prefix used for an LLM request. */
function getMessagesForRequest(
	messageViews: ChatMessageView[],
	replaceIndex: number = -1
): ChatMessage[] {
	return messageViews
		.slice(0, replaceIndex < 0 ? messageViews.length : replaceIndex)
		.filter(isPersistedMessage)
		.map(toChatMessage);
}

/** Returns the final persisted assistant message and its index when the chat history ends with one. */
function getLastAssistantMessage(
	messageViews: ChatMessageView[]
): { message: PersistedChatMessageView; index: number } | undefined {
	const index = messageViews.length - 1;
	const message = messageViews[index];

	if (message === undefined || message.commitId === null || message.sender !== 'assistant')
		return undefined;

	return { message, index };
}

/** Removes commit metadata before passing history to the LLM or persistence service. */
function toChatMessage(message: ChatMessageView): ChatMessage {
	return { sender: message.sender, content: message.content };
}

/** Identifies entries that are safe to include as committed history. */
function isPersistedMessage(message: ChatMessageView): message is PersistedChatMessageView {
	return message.commitId !== null;
}

/** Returns a concise description suitable for a combined error message. */
function failureMessage(cause: unknown): string {
	return cause instanceof Error
		? cause.message
		: typeof cause === 'string'
			? cause
			: 'Unknown failure';
}
