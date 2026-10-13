<script lang="ts">
	import { ChatSession } from '#lib/state/chat.svelte.ts';
	import { LlmProvider } from '#lib/state/llm.svelte.ts';

	import ChatControls from './ChatControls.svelte';
	import ChatHistory from './ChatHistory.svelte';

	const llmProvider = new LlmProvider();
	const chatSession = new ChatSession(llmProvider);
</script>

<div class="flex h-full w-full flex-1 flex-col gap-2 p-2">
	<ChatHistory messages={chatSession.messages} />
	<ChatControls
		isGenerating={chatSession.isGenerating}
		onNewChat={() => chatSession.newChat()}
		onSendMessage={(content) => chatSession.sendMessage(content)}
		onRegenerateMessage={() => chatSession.regenerateLastMessage()}
		onStopGeneration={() => chatSession.stopGeneration()}
	/>
</div>
