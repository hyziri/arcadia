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

export const ChatState = {
	Idle: 'idle',
	Sending: 'sending',
	Generating: 'generating'
};
export type ChatState = (typeof ChatState)[keyof typeof ChatState];

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
	chatState = $state(ChatState.Idle);

	private readonly _resolveChatService: () => Promise<ChatService>;
	private readonly _resolveLlmService: () => Promise<LlmService>;
	private _activeChatState: LoadStateType<ActiveChat | null> = $state({
		state: LoadState.NotLoaded
	});
	/** Invalidates asynchronous results from older chat loads, switches, or generations. */
	private _activeChatRevision = 0;
	private _chatLoadPromise: Promise<void> | undefined;
	private _abortController: AbortController | null = null;

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
		if (this.chatState !== ChatState.Idle) return;

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
	 * @returns Whether the user message was persisted.
	 */
	async sendMessage(content: string): Promise<boolean> {
		const trimmedContent = content.trim();
		if (
			!trimmedContent ||
			this._activeChatState.state === LoadState.Loading ||
			this._activeChatState.state === LoadState.Error ||
			this.chatState !== ChatState.Idle
		)
			return false;

		this.chatState = ChatState.Sending;
		try {
			return await this._addMessage({ sender: 'user', content: trimmedContent });
		} finally {
			this.chatState = ChatState.Idle;
		}
	}

	/** Generates and persists an assistant response for the active chat, if one is available.
	 *
	 * @returns Resolves when generation finishes or is ignored because no chat is active, sending, or already generating.
	 * @throws {AppError|DOMException} when generation or persistence fails.
	 */
	async generateResponse(): Promise<void> {
		if (this.chatState !== ChatState.Idle) return;
		return this._generateAssistantResponse(undefined);
	}

	/** Replaces the final assistant response, or responds to the full history when the tail is a user message.
	 *
	 * @returns Resolves when generation finishes or is ignored because no chat is active, sending, or already generating.
	 * @throws {AppError|DOMException} when generation or persistence fails.
	 */
	async regenerateResponse(): Promise<void> {
		const state = this._activeChatState;
		if (
			state.state === LoadState.Loading ||
			state.state === LoadState.Error ||
			this.chatState !== ChatState.Idle
		)
			return;

		if (state.state === LoadState.NotLoaded || state.data === null) {
			const revision = ++this._activeChatRevision;

			const chatService = await this._resolveChatService();
			const activeChat = await this._ensureActiveChat(chatService, revision);
			if (activeChat === undefined || !this._isCurrentChat(activeChat, revision)) return;

			return this._generateAssistantResponse();
		}

		const lastMessage = state.data.messages.at(-1);
		const replaceMessage =
			lastMessage !== undefined &&
			lastMessage.commitId !== null &&
			lastMessage.sender === 'assistant'
				? lastMessage
				: undefined;

		return this._generateAssistantResponse(replaceMessage);
	}

	/** Ensures a chat exists, persists a message, and appends its committed history entry. */
	private async _addMessage(message: ChatMessage): Promise<boolean> {
		const revision = ++this._activeChatRevision;

		const chatService = await this._resolveChatService();
		const activeChat = await this._ensureActiveChat(chatService, revision);
		if (activeChat === undefined || !this._isCurrentChat(activeChat, revision)) return false;

		const entry = await chatService.addMessage(activeChat.chatCatalogId, activeChat.refId, message);
		if (!this._isCurrentChat(activeChat, revision)) return false;

		activeChat.messages.push(toPersistedMessageView(entry));
		return true;
	}

	/** Owns one response's cancellation, streaming, and persistence lifecycle. */
	private async _generateAssistantResponse(
		replaceMessage?: PersistedChatMessageView
	): Promise<void> {
		if (this.chatState !== ChatState.Idle) return;

		this.chatState = ChatState.Generating;
		const revision = ++this._activeChatRevision;

		const abortController = new AbortController();
		this._abortController = abortController;

		try {
			const activeChatState = this._activeChatState;
			if (activeChatState.state !== 'loaded' || activeChatState.data === null) return;
			const activeChat = activeChatState.data;

			const replaceIndex =
				replaceMessage === undefined
					? -1
					: activeChat.messages.findIndex(
							(message) => message.commitId === replaceMessage.commitId
						);
			if (replaceMessage !== undefined && replaceIndex < 0) return;

			const requestMessages = activeChat.messages
				.slice(0, replaceIndex < 0 ? activeChat.messages.length : replaceIndex)
				.filter(isPersistedMessage)
				.map(toChatMessage);
			const pendingDraft: PendingChatMessageView = {
				sender: 'assistant',
				content: '',
				commitId: null,
				viewId: `pending:${revision}`
			};
			const pendingIndex = replaceIndex < 0 ? activeChat.messages.length : replaceIndex;
			if (replaceIndex < 0) {
				activeChat.messages.push(pendingDraft);
			} else {
				activeChat.messages[pendingIndex] = pendingDraft;
			}
			const pendingMessage = activeChat.messages[pendingIndex];
			if (pendingMessage === undefined || pendingMessage.commitId !== null) return;

			let generationFailure: unknown = NO_GENERATION_FAILURE;
			try {
				await this._appendResponseChunks(requestMessages, pendingMessage, abortController.signal);
			} catch (cause: unknown) {
				if (!(abortController.signal.aborted && cause instanceof OpenAiAbortError)) {
					generationFailure = cause;
				}
			}

			try {
				await this._persistPendingMessage(activeChat, pendingMessage, revision, replaceMessage);
			} catch (persistenceFailure: unknown) {
				if (generationFailure !== NO_GENERATION_FAILURE) {
					throw new ChatGenerationAndPersistenceError(generationFailure, persistenceFailure);
				}
				throw persistenceFailure;
			}

			if (generationFailure !== NO_GENERATION_FAILURE && revision === this._activeChatRevision) {
				throw generationFailure;
			}
		} catch (cause: unknown) {
			const expectedCancellation =
				abortController.signal.aborted && cause instanceof OpenAiAbortError;
			if (!expectedCancellation && revision === this._activeChatRevision) throw cause;
		} finally {
			if (this._abortController === abortController) this._abortController = null;
			this.chatState = ChatState.Idle;
		}
	}

	/** Persists a non-empty response only while its originating chat remains active. */
	private async _persistPendingMessage(
		activeChat: ActiveChat,
		pendingMessage: PendingChatMessageView,
		revision: number,
		replaceMessage: PersistedChatMessageView | undefined
	): Promise<void> {
		if (!this._isCurrentChat(activeChat, revision) || pendingMessage.content.length === 0) {
			this._restorePendingMessage(activeChat, pendingMessage, replaceMessage);
			return;
		}

		try {
			const chatService = await this._resolveChatService();
			if (!this._isCurrentChat(activeChat, revision)) {
				this._restorePendingMessage(activeChat, pendingMessage, replaceMessage);
				return;
			}

			const entry =
				replaceMessage === undefined
					? await chatService.addMessage(
							activeChat.chatCatalogId,
							activeChat.refId,
							toChatMessage(pendingMessage)
						)
					: await chatService.replaceMessage(
							activeChat.chatCatalogId,
							activeChat.refId,
							replaceMessage.commitId,
							toChatMessage(pendingMessage)
						);
			if (!this._isCurrentChat(activeChat, revision)) return;

			this._reconcilePersistedMessage(activeChat, pendingMessage, entry);
		} catch (cause: unknown) {
			if (replaceMessage !== undefined) {
				this._restorePendingMessage(activeChat, pendingMessage, replaceMessage);
			}
			if (revision === this._activeChatRevision) {
				throw cause;
			}
		}
	}

	/** Replaces the pending message in place with its persisted history entry. */
	private _reconcilePersistedMessage(
		activeChat: ActiveChat,
		pendingMessage: PendingChatMessageView,
		entry: ChatHistoryEntry
	): void {
		const pendingIndex = activeChat.messages.findIndex(
			(message) => message.viewId === pendingMessage.viewId
		);
		if (pendingIndex >= 0) activeChat.messages[pendingIndex] = toPersistedMessageView(entry);
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

	/** Streams response chunks into a session-only message proxy. */
	private async _appendResponseChunks(
		requestMessages: ChatMessage[],
		pendingMessage: PendingChatMessageView,
		abortSignal: AbortSignal
	): Promise<void> {
		const llmService = await this._resolveLlmService();
		for await (const chunk of llmService.generateResponse(requestMessages, abortSignal)) {
			if (chunk.content === undefined || chunk.content === '') continue;
			pendingMessage.content += chunk.content;
		}
	}

	/** Lazily creates a chat for the first sent message. */
	private async _ensureActiveChat(
		chatService: ChatService,
		revision: number
	): Promise<ActiveChat | undefined> {
		if (revision !== this._activeChatRevision) return undefined;
		const state = this._activeChatState;
		if (state.state === LoadState.Loading || state.state === LoadState.Error) return undefined;
		if (state.state === LoadState.Loaded && state.data !== null) return state.data;

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
