/** Defines the validated catalog row and message shape used by chat workflows. */

import * as v from 'valibot';

/** Validates a chat catalog row, rejecting fields outside the persisted catalog shape. */
export const ChatCatalogSchema = v.strictObject({
	id: v.string(),
	chatRepoId: v.string(),
	lastMessageCommitId: v.optional(v.string()),
	createdAt: v.number(),
	updatedAt: v.number()
});

export const ChatMessageSenderSchema = v.picklist(['user', 'assistant']);

/**
 * Represents a message exchanged in a chat conversation.
 */
export const ChatMessageSchema = v.strictObject({
	/** The role of the message sender. */
	sender: ChatMessageSenderSchema,
	/** The text content of the message. */
	content: v.pipe(v.string(), v.minLength(1))
});

export type ChatMessageSender = v.InferOutput<typeof ChatMessageSenderSchema>;
export type ChatMessage = v.InferOutput<typeof ChatMessageSchema>;
/** Validated chat catalog row shape inferred from {@link ChatCatalogSchema}. */
export type ChatCatalog = v.InferOutput<typeof ChatCatalogSchema>;

export interface ChatHistoryEntry {
	commitId: string;
	message: ChatMessage;
}
