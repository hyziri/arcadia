/** Defines the validated catalog row and message shape used by chat workflows. */

import * as v from 'valibot';

/** Validates a chat catalog row, rejecting fields outside the persisted catalog shape. */
export const ChatCatalogSchema = v.strictObject({
	id: v.string(),
	chatRepoId: v.string(),
	lastMessageCommitId: v.string(),
	createdAt: v.number(),
	updatedAt: v.number()
});

/**
 * Represents a message exchanged in a chat conversation.
 */
export interface ChatMessage {
	/** The role of the message sender. */
	sender: 'user' | 'assistant';
	/** The text content of the message. */
	content: string;
}

/** Validated chat catalog row shape inferred from {@link ChatCatalogSchema}. */
export type ChatCatalog = v.InferOutput<typeof ChatCatalogSchema>;
