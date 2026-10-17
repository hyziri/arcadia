import {
	type ChatCatalog,
	type ChatMessage,
	type Pagination,
	type Ref,
	type Repo,
	type ChatHistoryEntry
} from '#lib/model';
import { type Database } from '#lib/db';
import { ChatCatalogRepo, throwCommitNotFoundError, throwRefNotFoundError } from '#lib/data';
import { getLogger } from '#lib/logger';
import { AppError } from '#lib/error.ts';

import type { VersionControlService } from './version-control';

const DEFAULT_CHAT_BRANCH_NAME = 'main';
const log = getLogger('service/chat');

export class ChatCatalogNotFoundError extends AppError {
	readonly kind = 'chat_catalog_not_found';
	readonly chatCatalogId: string;

	constructor(chatCatalogId: string) {
		super('Failed to find requested chat catalog');
		this.chatCatalogId = chatCatalogId;
	}
}

export class ChatRepoOwnershipError extends AppError {
	readonly kind = 'chat_repo_ownership_invalid';
	readonly chatCatalogId: string;
	readonly repoId: string;

	constructor(chatCatalogId: string, repoId: string) {
		super('Repository does not belong to chat');
		this.chatCatalogId = chatCatalogId;
		this.repoId = repoId;
	}
}

export class RefTargetChangedError extends AppError {
	readonly kind = 'ref_target_changed';
	readonly refId: string;
	readonly expectedTargetCommitId: string | null;
	readonly actualTargetCommitId: string | null;

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

export class ChatRepoChangedError extends AppError {
	readonly kind = 'chat_repo_changed';
	readonly chatCatalogId: string;
	readonly expectedRepoId: string;
	readonly actualRepoId: string;

	constructor(chatCatalogId: string, expectedRepoId: string, actualRepoId: string) {
		super('Chat repository has changed after commit was prepared');
		this.chatCatalogId = chatCatalogId;
		this.expectedRepoId = expectedRepoId;
		this.actualRepoId = actualRepoId;
	}
}

export class ChatService {
	private readonly _db: Database;
	private readonly _versionControlService: VersionControlService;
	private readonly _chatCatalogRepo: ChatCatalogRepo;

	constructor(db: Database, versionControlService: VersionControlService) {
		this._db = db;
		this._versionControlService = versionControlService;
		this._chatCatalogRepo = new ChatCatalogRepo(db);
	}

	// Creates a new chat
	async createChat(): Promise<[ChatCatalog, Repo, Ref]> {
		log.trace('create chat enter');

		const tx = this._db.transaction(['chatCatalog', 'repos', 'refs', 'commits'], 'readwrite');

		const initialRepo = await this._versionControlService.createRepository('chat', tx);
		const defaultRef = await this._versionControlService.createRef(
			initialRepo.id,
			DEFAULT_CHAT_BRANCH_NAME,
			undefined,
			tx
		);
		const repo = await this._versionControlService.setRepoDefaultRef(initialRepo.id, defaultRef.id);
		const catalog = await this._chatCatalogRepo.create(initialRepo.id, undefined, tx);

		tx.commit();

		return [catalog, repo, defaultRef];
	}

	// Copies a chat
	async forkChat(chatCatalogId: string): Promise<[ChatCatalog, Repo] | undefined> {
		log.trace('fork chat enter', { chatCatalogId });

		// Review: try catch block start point?
		const tx = this._db.transaction(['chatCatalog', 'repos', 'refs'], 'readwrite');

		const catalog = await this._chatCatalogRepo.getByCatalogId(chatCatalogId, tx);
		if (catalog === undefined) throwChatCatalogNotFoundError(chatCatalogId);

		const forkedRepo = await this._versionControlService.forkRepository(catalog.chatRepoId, tx);
		// Review: Add repo.copy method to retain createdAt & lastUpdated values?
		const newCatalog = await this._chatCatalogRepo.create(
			forkedRepo.repository.id,
			catalog.lastMessageCommitId,
			tx
		);

		tx.commit();

		return [newCatalog, forkedRepo.repository];
	}

	// Get recent, paginated chats
	async getRecentChats(pagination: Pagination): Promise<ChatCatalog[]> {
		const { page, perPage } = pagination;
		log.trace('get recent chats enter', { page, perPage });

		return await this._chatCatalogRepo.getRecent(pagination);
	}

	// Set chat's default branch
	// Review: operate off chat repo ID or chat catalog ID?
	async setDefaultBranch(chatCatalogId: string, refId: string): Promise<Repo> {
		log.trace('set default branch enter', { chatCatalogId });

		const tx = this._db.transaction(['chatCatalog', 'repos', 'refs'], 'readwrite');

		const catalog = await this._chatCatalogRepo.getByCatalogId(chatCatalogId, tx);
		if (catalog === undefined) return throwChatCatalogNotFoundError(chatCatalogId);
		const repo = await this._versionControlService.setRepoDefaultRef(chatCatalogId, refId, tx);
		if (repo === undefined) return throwChatRepoOwnershipError(chatCatalogId, catalog.chatRepoId);

		tx.commit();

		return repo;
	}

	// Deletes a chat, all its refs, and triggers garbage collection for unreachable commits
	async deleteChat(chatCatalogId: string): Promise<void> {
		log.trace('delete chat enter', { chatCatalogId });

		const tx = this._db.transaction(
			['chatCatalog', 'repos', 'refs', 'garbageJobs', 'garbageJobItems'],
			'readwrite'
		);

		const catalog = await this._chatCatalogRepo.getByCatalogId(chatCatalogId, tx);
		if (catalog === undefined) throwChatCatalogNotFoundError(chatCatalogId);

		// Review: This returns void but deleteRepo returns boolean? Which is best practice?
		await this._chatCatalogRepo.delete(catalog.chatRepoId, chatCatalogId);
		await this._versionControlService.deleteRepository(catalog.chatRepoId);

		tx.commit();

		// Review: return type?
	}

	// Add a new message to chat & target ref
	async addMessage(
		chatCatalogId: string,
		refId: string,
		message: ChatMessage,
		alternateOfCommitId?: string
	): Promise<[Ref, ChatHistoryEntry]> {
		console.log('Add message enter', { chatCatalogId, refId });

		const readTx = this._db.transaction(['chatCatalog', 'refs'], 'readonly');

		const catalog = await this._chatCatalogRepo.getByCatalogId(chatCatalogId, readTx);
		if (catalog === undefined) throwChatCatalogNotFoundError(chatCatalogId);
		const ref = await this._versionControlService.getRef(catalog.chatRepoId, refId, readTx);
		if (ref === undefined) throwRefNotFoundError(log, refId);

		readTx.commit();

		const preparedCommit = await this._versionControlService.prepareCommit({
			parentCommitId: ref.targetCommitId ?? null,
			alternateOfCommitId: alternateOfCommitId ?? null,
			data: {
				type: 'chat-message',
				message
			}
		});

		const writeTx = this._db.transaction(['chatCatalog', 'refs', 'commits'], 'readwrite');
		const currentCatalog = await this._chatCatalogRepo.getByCatalogId(chatCatalogId, writeTx);
		if (currentCatalog === undefined) throw throwChatCatalogNotFoundError(chatCatalogId);
		if (currentCatalog.chatRepoId !== catalog.chatRepoId)
			throwChatRepoChangedError(chatCatalogId, catalog.chatRepoId, currentCatalog.chatRepoId);
		const currentRef = await this._versionControlService.getRef(
			currentCatalog.chatRepoId,
			refId,
			writeTx
		);
		if (currentRef === undefined) throwRefNotFoundError(log, refId);
		if (currentRef.targetCommitId !== ref.targetCommitId)
			throwRefTargetChangedError(chatCatalogId, ref.targetCommitId, currentRef?.targetCommitId);

		const repo = await this._versionControlService.getRepository(currentCatalog.chatRepoId);

		const commit = await this._versionControlService.createCommit(preparedCommit, writeTx);
		const updatedRef = await this._versionControlService.updateRef(
			currentCatalog.chatRepoId,
			refId,
			undefined,
			commit.id,
			writeTx
		);

		if (repo?.defaultRefId === updatedRef.id) {
			await this._chatCatalogRepo.update(catalog.chatRepoId, chatCatalogId, commit.id);
		}

		writeTx.commit();

		return [
			updatedRef,
			{
				commitId: commit.id,
				message: commit.data.message
			}
		];
	}

	async getMessageHistory(firstCommitId: string, count: number): Promise<ChatHistoryEntry[]> {
		log.trace('get message history enter', { firstCommitId });

		const commits = await this._versionControlService.getCommitParentChain(firstCommitId, count);

		return commits.map((commit) => ({
			commitId: commit.id,
			message: commit.data.message
		}));
	}

	// Get alternate commits for message id
	async getMessageAlternates(commitId: string): Promise<ChatHistoryEntry[]> {
		const commits = await this._versionControlService.getAllCommitsByAlternate(commitId);

		return commits.map((commit) => ({
			commitId: commit.id,
			message: commit.data.message
		}));
	}

	// Rewinds message history to target commit and triggers garbage collection for unreachable commits
	async rewindMessage(chatCatalogId: string, refId: string, messageCommitId: string): Promise<Ref> {
		log.trace('rewind message enter', { chatCatalogId, refId });

		const tx = this._db.transaction(
			['chatCatalog', 'repos', 'refs', 'commits', 'garbageJobs', 'garbageJobItems'],
			'readwrite'
		);

		const catalog = await this._chatCatalogRepo.getByCatalogId(chatCatalogId, tx);
		if (catalog === undefined) throwChatCatalogNotFoundError(chatCatalogId);
		const updatedRef = await this._versionControlService.updateRef(
			catalog.chatRepoId,
			refId,
			undefined,
			messageCommitId,
			tx
		);

		tx.commit();

		return updatedRef;
	}

	// Creates a new branch for the chat at target commit
	async createBranch(chatCatalogId: string, messageCommitId: string) {
		log.trace('create branch enter', { chatCatalogId, messageCommitId });

		const tx = this._db.transaction(['chatCatalog', 'repos', 'refs', 'commits'], 'readwrite');
		const catalog = await this._chatCatalogRepo.getByCatalogId(chatCatalogId, tx);
		if (catalog === undefined) throwChatCatalogNotFoundError(chatCatalogId);
		const commit = await this._versionControlService.getCommit(messageCommitId);
		// Review: Throw not found error instead?
		if (commit === undefined) throwCommitNotFoundError(log, messageCommitId);

		// TODO: created at formatting?
		const name = `${commit.data.message.sender}@${commit.createdAt}`;

		const ref = await this._versionControlService.createRef(
			catalog.chatRepoId,
			name,
			messageCommitId,
			tx
		);

		tx.commit();

		return ref;
	}

	// Delete branch for chat and triggers garbage collection for unreachable commits
	async deleteBranch(chatCatalogId: string, refId: string) {
		log.trace('delete branch enter', { chatCatalogId, refId });

		const tx = this._db.transaction(
			['chatCatalog', 'refs', 'repos', 'refs', 'garbageJobs', 'garbageJobItems'],
			'readwrite'
		);
		const catalog = await this._chatCatalogRepo.getByCatalogId(chatCatalogId, tx);
		if (catalog === undefined) throwChatCatalogNotFoundError(chatCatalogId);
		await this._versionControlService.deleteRef(catalog.chatRepoId, refId);
	}
}

/** Logs and throws when a required chat catalog is missing. */
function throwChatCatalogNotFoundError(chatCatalogId: string): never {
	const error = new ChatCatalogNotFoundError(chatCatalogId);
	log.error('chat catalog not found', { err: error, chatCatalogId });
	throw error;
}

/** Logs and throws when a repository is known not to belong to a chat. */
function throwChatRepoOwnershipError(chatCatalogId: string, repoId: string): never {
	const error = new ChatRepoOwnershipError(chatCatalogId, repoId);
	log.error('chat repository ownership mismatch', { err: error, chatCatalogId, repoId });
	throw error;
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
