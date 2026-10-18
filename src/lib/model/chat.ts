/** Defines the validated catalog row and message shape used by chat workflows. */

import * as v from 'valibot';

/** Validates a chat catalog row, rejecting fields outside the persisted catalog shape. */
export const ChatCatalogSchema = v.strictObject({
	id: v.string(),
	chatRepoId: v.string(),
	lastMessageCommitId: v.nullable(v.string()),
	createdAt: v.number(),
	updatedAt: v.number()
});

/** Validates the sender roles supported by chat messages. */
export const ChatMessageSenderSchema = v.picklist(['user', 'assistant']);

/** Validates the sender and non-empty text content of a chat message. */
export const ChatMessageSchema = v.strictObject({
	/** The role of the message sender. */
	sender: ChatMessageSenderSchema,
	/** The text content of the message. */
	content: v.pipe(v.string(), v.minLength(1))
});

/** Sender role represented by a chat message. */
export type ChatMessageSender = v.InferOutput<typeof ChatMessageSenderSchema>;
/** Validated chat message payload inferred from {@link ChatMessageSchema}. */
export type ChatMessage = v.InferOutput<typeof ChatMessageSchema>;
/** Validated chat catalog row shape inferred from {@link ChatCatalogSchema}. */
export type ChatCatalog = v.InferOutput<typeof ChatCatalogSchema>;

/** Couples a message payload with the immutable commit identifying its history occurrence. */
export interface ChatHistoryEntry {
	/** Content-addressed commit ID for this message's occurrence in history. */
	commitId: string;
	/** Validated chat-message payload stored in the commit. */
	message: ChatMessage;
}
