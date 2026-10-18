/** Orchestrates chat catalog and version-controlled message workflows.
 *
 * Chat repositories hold immutable message commits and refs; catalog rows provide the chat listing
 * and track the current default-ref head. Multi-store mutations run in owned transactions, while
 * commit hashing is prepared before opening the write transaction.
 */

import {
	type ChatCatalog,
	type ChatMessage,
	type Pagination,
	type Ref,
	type Repo,
	type ChatHistoryEntry
} from '#lib/model';
import { withTransaction, type ArcadiaTransaction, type Database } from '#lib/db';
import { ChatCatalogRepo } from '#lib/data';
import { getLogger } from '#lib/logger';
import { AppError } from '#lib/error.ts';

import type { VersionControlService } from './version-control';

const DEFAULT_CHAT_BRANCH_NAME = 'main';
const log = getLogger('service/chat');

/** Indicates that a required chat catalog does not exist. */
export class ChatCatalogNotFoundError extends AppError {
	readonly kind = 'chat_catalog_not_found';
	readonly chatCatalogId: string;

	/** Creates an error identifying the missing chat catalog. */
	constructor(chatCatalogId: string) {
		super('Failed to find requested chat catalog');
		this.chatCatalogId = chatCatalogId;
	}
}

/** Indicates that a repository does not belong to the addressed chat catalog. */
export class ChatRepoOwnershipError extends AppError {
	readonly kind = 'chat_repo_ownership_invalid';
	readonly chatCatalogId: string;
	readonly repoId: string;

	/** Creates an error describing the catalog and unexpected repository. */
	constructor(chatCatalogId: string, repoId: string) {
		super('Repository does not belong to chat');
		this.chatCatalogId = chatCatalogId;
		this.repoId = repoId;
	}
}

/** Indicates that a ref moved while a message commit was being prepared. */
export class RefTargetChangedError extends AppError {
	readonly kind = 'ref_target_changed';
	readonly refId: string;
	readonly expectedTargetCommitId: string | null;
	readonly actualTargetCommitId: string | null;

	/** Creates an error describing the expected and observed ref targets. */
	constructor(
		refId: string,
		expectedTargetCommitId: string | null,
		actualTargetCommitId: string | null
	) {
		super('Ref target commit has changed after commit was prepared');
		this.refId = refId;
		this.expectedTargetCommitId = expectedTargetCommitId;
		this.actualTargetCommitId = actualTargetCommitId;
	}
}

/** Indicates that a chat was rebound to another repository during an operation. */
export class ChatRepoChangedError extends AppError {
	readonly kind = 'chat_repo_changed';
	readonly chatCatalogId: string;
	readonly expectedRepoId: string;
	readonly actualRepoId: string;

	/** Creates an error describing the previous and current repository IDs. */
	constructor(chatCatalogId: string, expectedRepoId: string, actualRepoId: string) {
		super('Chat repository has changed after commit was prepared');
		this.chatCatalogId = chatCatalogId;
		this.expectedRepoId = expectedRepoId;
		this.actualRepoId = actualRepoId;
	}
}

/** Coordinates chat catalog operations with version-controlled repositories and history. */
export class ChatService {
	private readonly _db: Database;
	private readonly _versionControlService: VersionControlService;
	private readonly _chatCatalogRepo: ChatCatalogRepo;

	/** Creates a chat service backed by the shared database and version-control service.
	 *
	 * @param db - The application database.
	 * @param versionControlService - The service that manages chat repositories, refs, and commits.
	 */
	constructor(db: Database, versionControlService: VersionControlService) {
		this._db = db;
		this._versionControlService = versionControlService;
		this._chatCatalogRepo = new ChatCatalogRepo(db);
	}

	/** Creates a chat with an empty default branch.
	 *
	 * @returns The new catalog entry, repository, and default ref.
	 * @throws {AppError|import('valibot').ValiError|DOMException} when validation or persistence fails.
	 */
	async createChat(): Promise<{ catalog: ChatCatalog; repo: Repo; ref: Ref }> {
		log.trace('create chat enter');

		return await withTransaction(
			this._db,
			['chatCatalog', 'repos', 'refs', 'commits'],
			'readwrite',
			undefined,
			async (tx) => {
				const initialRepo = await this._versionControlService.createRepository('chat', tx);
				const defaultRef = await this._versionControlService.createRef(
					initialRepo.id,
					DEFAULT_CHAT_BRANCH_NAME,
					undefined,
					tx
				);
				const { repo, ref } = await this._versionControlService.setRepoDefaultRef(
					initialRepo.id,
					defaultRef.id,
					tx
				);
				const catalog = await this._chatCatalogRepo.create(initialRepo.id, undefined, tx);

				return { catalog, repo, ref };
			}
		);
	}

	/** Forks a chat by copying its refs into a new repository while sharing immutable commits.
	 *
	 * @param chatCatalogId - The catalog entry identifying the source chat.
	 * @returns The new catalog entry and forked repository.
	 * @throws {AppError|import('valibot').ValiError|DOMException} when the source or linked data is invalid or persistence fails.
	 */
	async forkChat(chatCatalogId: string): Promise<[ChatCatalog, Repo]> {
		log.trace('fork chat enter', { chatCatalogId });

		return await withTransaction(
			this._db,
			['chatCatalog', 'repos', 'refs', 'commits'],
			'readwrite',
			undefined,
			async (tx) => {
				const catalog = await this._requireCatalog(chatCatalogId, tx);
				const forkedRepo = await this._versionControlService.forkRepository(catalog.chatRepoId, tx);
				const newCatalog = await this._chatCatalogRepo.create(
					forkedRepo.repository.id,
					catalog.lastMessageCommitId,
					tx
				);

				return [newCatalog, forkedRepo.repository];
			}
		);
	}

	/** Gets a page of chats ordered by most recent catalog update.
	 *
	 * @param pagination - The one-based page and page size.
	 * @returns The validated catalog entries for the requested page.
	 * @throws {AppError|import('valibot').ValiError|DOMException} when pagination is invalid or a catalog read fails.
	 */
	async getRecentChats(pagination: Pagination): Promise<ChatCatalog[]> {
		const { page, perPage } = pagination;
		log.trace('get recent chats enter', { page, perPage });

		return await this._chatCatalogRepo.getRecent(pagination);
	}

	/** Sets a chat repository's default ref and synchronizes the catalog's latest-message pointer.
	 *
	 * @param chatCatalogId - The catalog entry identifying the chat.
	 * @param refId - The ref to make the repository default.
	 * @returns The updated repository.
	 * @throws {AppError|import('valibot').ValiError|DOMException} when the catalog, ref, or persistence operation fails.
	 */
	async setDefaultBranch(chatCatalogId: string, refId: string): Promise<Repo> {
		log.trace('set default branch enter', { chatCatalogId });

		return await withTransaction(
			this._db,
			['chatCatalog', 'repos', 'refs'],
			'readwrite',
			undefined,
			async (tx) => {
				const catalog = await this._requireCatalog(chatCatalogId, tx);
				const { repo, ref } = await this._versionControlService.setRepoDefaultRef(
					catalog.chatRepoId,
					refId,
					tx
				);
				if (ref.targetCommitId !== catalog.lastMessageCommitId) {
					await this._chatCatalogRepo.update(
						catalog.chatRepoId,
						chatCatalogId,
						ref.targetCommitId,
						tx
					);
				}

				return repo;
			}
		);
	}

	/** Deletes a chat catalog and its repository, queuing unreachable commits for collection.
	 *
	 * @param chatCatalogId - The catalog entry identifying the chat to delete.
	 * @returns A promise that resolves when the deletion transaction completes.
	 * @throws {AppError|import('valibot').ValiError|DOMException} when the catalog is missing or persistence fails.
	 */
	async deleteChat(chatCatalogId: string): Promise<void> {
		log.trace('delete chat enter', { chatCatalogId });

		return withTransaction(
			this._db,
			['chatCatalog', 'repos', 'refs', 'garbageJobs', 'garbageJobItems'],
			'readwrite',
			undefined,
			async (tx) => {
				const catalog = await this._requireCatalog(chatCatalogId, tx);

				await this._chatCatalogRepo.delete(catalog.chatRepoId, chatCatalogId, tx);
				await this._versionControlService.deleteRepository(catalog.chatRepoId, tx);
			}
		);
	}

	/** Adds a message to a ref, atomically persisting the commit and advancing the ref.
	 *
	 * Commit content is prepared before the write transaction; that transaction rechecks the catalog
	 * and ref so a concurrent move cannot append against a stale parent.
	 *
	 * @param chatCatalogId - The catalog entry identifying the chat.
	 * @param refId - The ref to advance.
	 * @param message - The validated chat message to append.
	 * @param alternateOfCommitId - Optional commit whose message this is an alternate for.
	 * @returns The updated ref and the created history entry.
	 * @throws {AppError|import('valibot').ValiError|DOMException} when validation, concurrency checks, or persistence fails.
	 */
	async addMessage(
		chatCatalogId: string,
		refId: string,
		message: ChatMessage,
		alternateOfCommitId?: string
	): Promise<[Ref, ChatHistoryEntry]> {
		log.trace('Add message enter', { chatCatalogId, refId });

		const { catalog, ref } = await withTransaction(
			this._db,
			['chatCatalog', 'repos', 'refs', 'commits'],
			'readonly',
			undefined,
			async (tx) => {
				const catalog = await this._requireCatalog(chatCatalogId, tx);
				const ref = await this._versionControlService.requireRef(catalog.chatRepoId, refId, tx);

				return { catalog, ref };
			}
		);

		const preparedCommit = await this._versionControlService.prepareCommit({
			parentCommitId: ref.targetCommitId ?? null,
			alternateOfCommitId: alternateOfCommitId ?? null,
			data: {
				type: 'chat-message',
				message
			}
		});

		return withTransaction(
			this._db,
			['chatCatalog', 'repos', 'refs', 'commits', 'garbageJobItems', 'garbageJobs'],
			'readwrite',
			undefined,
			async (tx) => {
				const currentCatalog = await this._requireCatalog(chatCatalogId, tx);
				if (currentCatalog.chatRepoId !== catalog.chatRepoId)
					throwChatRepoChangedError(chatCatalogId, catalog.chatRepoId, currentCatalog.chatRepoId);
				const currentRef = await this._versionControlService.requireRef(
					currentCatalog.chatRepoId,
					refId,
					tx
				);
				if (currentRef.targetCommitId !== ref.targetCommitId)
					throwRefTargetChangedError(refId, ref.targetCommitId, currentRef?.targetCommitId);

				const repo = await this._versionControlService.requireRepository(
					currentCatalog.chatRepoId,
					tx
				);
				const commit = await this._versionControlService.createCommit(preparedCommit, tx);
				const updatedRef = await this._versionControlService.updateRef(
					currentCatalog.chatRepoId,
					refId,
					undefined,
					commit.id,
					tx
				);

				if (repo.defaultRefId === updatedRef.id) {
					await this._chatCatalogRepo.update(catalog.chatRepoId, chatCatalogId, commit.id, tx);
				}

				return [
					updatedRef,
					{
						commitId: commit.id,
						message: commit.data.message
					}
				];
			}
		);
	}

	/** Gets a message and its ancestors, beginning with the supplied commit.
	 *
	 * @param firstCommitId - The first commit to include in the returned history page.
	 * @param count - The maximum number of commits to return.
	 * @returns History entries in newest-to-oldest parent-chain order.
	 * @throws {AppError|DOMException} when the start commit, ancestry, or persisted data is invalid.
	 */
	async getMessageHistory(firstCommitId: string, count: number): Promise<ChatHistoryEntry[]> {
		log.trace('get message history enter', { firstCommitId });

		const commits = await this._versionControlService.getCommitParentChain(firstCommitId, count);

		return commits.map((commit) => ({
			commitId: commit.id,
			message: commit.data.message
		}));
	}

	/** Gets globally shared alternate commits for a message commit.
	 *
	 * @param commitId - The commit used as the alternate target.
	 * @returns The alternate history entries.
	 * @throws {AppError|DOMException} when the target or persisted commit data is invalid.
	 */
	async getMessageAlternates(commitId: string): Promise<ChatHistoryEntry[]> {
		const commits = await this._versionControlService.getAllCommitsByAlternate(commitId);

		return commits.map((commit) => ({
			commitId: commit.id,
			message: commit.data.message
		}));
	}

	/** Truncates a ref's visible history at the selected message and later commits.
	 *
	 * The ref moves to the selected commit's parent; immutable commits are only collected if they
	 * become unreachable from every repository root.
	 *
	 * @param chatCatalogId - The catalog entry identifying the chat.
	 * @param refId - The ref whose visible history should be truncated.
	 * @param messageCommitId - The first message commit to remove from this ref's visible history.
	 * @returns The updated ref.
	 * @throws {AppError|import('valibot').ValiError|DOMException} when the catalog, commit, ref, validation, or persistence operation fails.
	 */
	async deleteMessagesFrom(
		chatCatalogId: string,
		refId: string,
		messageCommitId: string
	): Promise<Ref> {
		log.trace('rewind message enter', { chatCatalogId, refId });

		return withTransaction(
			this._db,
			['chatCatalog', 'repos', 'refs', 'commits', 'garbageJobs', 'garbageJobItems'],
			'readwrite',
			undefined,
			async (tx) => {
				const catalog = await this._requireCatalog(chatCatalogId, tx);
				const repo = await this._versionControlService.requireRepository(catalog.chatRepoId, tx);
				const commit = await this._versionControlService.requireCommitOnRefHistory(
					catalog.chatRepoId,
					refId,
					messageCommitId,
					tx
				);

				const ref = await this._versionControlService.updateRef(
					catalog.chatRepoId,
					refId,
					undefined,
					commit.parentCommitId,
					tx
				);

				if (refId === repo.defaultRefId) {
					await this._chatCatalogRepo.update(
						catalog.chatRepoId,
						catalog.id,
						commit.parentCommitId,
						tx
					);
				}

				return ref;
			}
		);
	}

	/** Creates a new branch at a commit in the source ref's history.
	 *
	 * @param chatCatalogId - The catalog entry identifying the chat.
	 * @param sourceRefId - The ref whose history contains the selected commit.
	 * @param messageCommitId - The commit to use as the new branch head.
	 * @returns The created ref.
	 * @throws {AppError|import('valibot').ValiError|DOMException} when the catalog, source ref, commit history, or persistence operation is invalid.
	 */
	async createBranch(chatCatalogId: string, sourceRefId: string, messageCommitId: string) {
		log.trace('create branch enter', { chatCatalogId, sourceRefId, messageCommitId });

		return withTransaction(
			this._db,
			['chatCatalog', 'repos', 'refs', 'commits'],
			'readwrite',
			undefined,
			async (tx) => {
				const catalog = await this._requireCatalog(chatCatalogId, tx);
				const commit = await this._versionControlService.requireCommitOnRefHistory(
					catalog.chatRepoId,
					sourceRefId,
					messageCommitId,
					tx
				);

				const name = `${commit.data.message.sender}@${new Date(commit.createdAt).toISOString()}`;
				return await this._versionControlService.createRef(
					catalog.chatRepoId,
					name,
					messageCommitId,
					tx
				);
			}
		);
	}

	/** Deletes a branch if it exists and queues its unreachable target for collection.
	 *
	 * Deleting the default branch clears the catalog's latest-message pointer. A missing ref is a no-op.
	 *
	 * @param chatCatalogId - The catalog entry identifying the chat.
	 * @param refId - The ref to delete.
	 * @returns A promise that resolves when the deletion transaction completes.
	 * @throws {AppError|DOMException} when the catalog or persistence operation fails.
	 */
	async deleteBranch(chatCatalogId: string, refId: string): Promise<void> {
		log.trace('delete branch enter', { chatCatalogId, refId });

		return await withTransaction(
			this._db,

			['chatCatalog', 'refs', 'repos', 'garbageJobs', 'garbageJobItems'],
			'readwrite',

			undefined,
			async (tx) => {
				const catalog = await this._requireCatalog(chatCatalogId, tx);
				const repo = await this._versionControlService.requireRepository(catalog.chatRepoId, tx);
				const ref = await this._versionControlService.getRef(catalog.chatRepoId, refId, tx);
				if (ref === undefined) return;

				await this._versionControlService.deleteRef(catalog.chatRepoId, refId, tx);
				if (repo.defaultRefId === ref.id) {
					await this._chatCatalogRepo.update(catalog.chatRepoId, catalog.id, null, tx);
				}
			}
		);
	}

	/** Resolves a required catalog within the supplied workflow transaction. */
	private async _requireCatalog(
		chatCatalogId: string,
		tx?: ArcadiaTransaction
	): Promise<ChatCatalog> {
		return await this._chatCatalogRepo.requireCatalog(chatCatalogId, tx);
	}
}

/** Logs and throws when a ref changed after a commit was prepared. */
function throwRefTargetChangedError(
	refId: string,
	expectedTargetCommitId: string | null,
	actualTargetCommitId: string | null
): never {
	const expectedTarget = expectedTargetCommitId ?? null;
	const actualTarget = actualTargetCommitId ?? null;
	const error = new RefTargetChangedError(refId, expectedTarget, actualTarget);

	log.error('ref target changed after commit was prepared', {
		err: error,
		refId,
		expectedTargetCommitId: expectedTarget,
		actualTargetCommitId: actualTarget
	});

	throw error;
}

/** Logs and throws when a chat is rebound to another repository during an operation. */
function throwChatRepoChangedError(
	chatCatalogId: string,
	expectedRepoId: string,
	actualRepoId: string
) {
	const error = new ChatRepoChangedError(chatCatalogId, expectedRepoId, actualRepoId);

	log.error('Chat repository has changed after commit was prepared', {
		err: error,
		chatCatalogId,
		expectedRepoId,
		actualRepoId
	});

	throw error;
}
