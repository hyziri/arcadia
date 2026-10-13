<script lang="ts">
	import { ChatSession } from '#lib/state/chat.svelte.ts';
	import { LlmProvider } from '#lib/state/llm.svelte.ts';

	import ChatControls from './ChatControls.svelte';
	import ChatHistory from './ChatHistory.svelte';

	const llmProvider = new LlmProvider();
	const chatSession = new ChatSession(llmProvider);

	/** Adds a user message to the conversation history. */
	function handleSendMessage(content: string) {
		chatSession.sendMessage(content);
	}

	/** Regenerates the most recent assistant response. */
	function handleRegenerateMessage() {
		chatSession.regenerateLastMessage();
	}

	/** Stops the current response generation. */
	function handleStopGeneration() {
		chatSession.stopGeneration();
	}
</script>

<div class="flex h-full w-full flex-1 flex-col gap-2 p-2">
	<ChatHistory messages={chatSession.messages} />
	<ChatControls
		isGenerating={chatSession.isGenerating}
		onSendMessage={handleSendMessage}
		onRegenerateMessage={handleRegenerateMessage}
		onStopGeneration={handleStopGeneration}
	/>
</div>
