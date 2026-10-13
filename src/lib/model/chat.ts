/**
 * Represents a message exchanged in a chat conversation.
 */
export interface ChatMessage {
	/** The role of the message sender. */
	sender: 'user' | 'assistant';
	/** The text content of the message. */
	content: string;
}
