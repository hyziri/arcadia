/** Defines validated payload and metadata schemas for version-controlled data.
 *
 * Repositories group commits, refs point to commit heads, and tagged commit payloads allow
 * the version-control layer to support multiple domain-specific data shapes.
 */

import * as v from 'valibot';

import { ChatMessageSchema } from '../chat';

/** Validates the sender roles supported by chat messages. */
export const ChatMessageSenderSchema = v.picklist(['user', 'assistant']);

/** Validates the tagged chat-message payload stored in a commit. */
export const ChatCommitDataSchema = v.strictObject({
	type: v.literal('chat-message'),
	message: ChatMessageSchema
});

/** Validates the supported repository data kinds. */
export const RepoKindSchema = v.picklist(['chat']);

/** Validates repository identity and creation metadata. */
export const RepoSchema = v.strictObject({
	id: v.string(),
	kind: RepoKindSchema,
	defaultRefId: v.nullable(v.string()),
	createdAt: v.number()
});

/** Validates a named reference to a commit within a repository. */
export const RefSchema = v.strictObject({
	id: v.string(),
	repoId: v.string(),
	name: v.string(),
	targetCommitId: v.nullable(v.string()),
	updatedAt: v.number(),
	createdAt: v.number()
});

/** Validates a repository-scoped link that makes a globally shared alternate visible. */
export const RepoAlternateSchema = v.strictObject({
	repoId: v.string(),
	alternateOfCommitId: v.string(),
	alternateCommitId: v.string()
});

/** Validates the supported tagged payload variants stored in commits. */
export const CommitDataSchema = v.variant('type', [ChatCommitDataSchema]);

/** Validates globally shared commit identity, parent ancestry, and payload. */
export const CommitSchema = v.strictObject({
	id: v.string(),
	parentCommitId: v.nullable(v.string()),
	data: CommitDataSchema,
	createdAt: v.number()
});

/** Sender role represented by a chat message. */
export type ChatMessageSender = v.InferOutput<typeof ChatMessageSenderSchema>;

/** Chat message payload stored by the version-control layer. */
export type ChatMessageData = v.InferOutput<typeof ChatMessageSchema>;

/** Tagged chat-message commit payload. */
export type ChatCommitData = v.InferOutput<typeof ChatCommitDataSchema>;

/** Kind of data grouped by a repository. */
export type RepoKind = v.InferOutput<typeof RepoKindSchema>;

/** Version-control repository metadata. */
export type Repo = v.InferOutput<typeof RepoSchema>;

/** Named repository reference to a commit. */
export type Ref = v.InferOutput<typeof RefSchema>;

/** Repository membership for an alternate commit. */
export type RepoAlternate = v.InferOutput<typeof RepoAlternateSchema>;

/** Union of supported commit payloads. */
export type CommitData = v.InferOutput<typeof CommitDataSchema>;

/** Version-control commit with its payload and ancestry links. */
export type Commit = v.InferOutput<typeof CommitSchema>;
