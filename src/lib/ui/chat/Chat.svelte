<script lang="ts">
	import { type ChatMessage } from '#lib/model';

	import ChatControls from './ChatControls.svelte';
	import ChatHistory from './ChatHistory.svelte';

	let messages: ChatMessage[] = $state([]);

	/** Adds a user message to the conversation history. */
	function handleSend(content: string) {
		messages.push({
			sender: 'User',
			content
		});
	}
</script>

<div class="flex h-full w-full flex-1 flex-col gap-2 p-2">
	<ChatHistory {messages} />
	<ChatControls onSend={handleSend} />
</div>
