<script lang="ts">
	import { appState, ChatSession, getToastContext } from '#lib/state';

	import ChatControls from './ChatControls.svelte';
	import ChatHistory from './ChatHistory.svelte';

	const toastContext = getToastContext();
	let chatSession = new ChatSession(() => appState.getLlmService());

	function runChatAction(action: () => Promise<void>): void {
		void action().then(() => {
			if (chatSession.generationError !== null) {
				toastContext.showToast({ kind: 'error', message: chatSession.generationError });
			}
		});
	}
</script>

<div class="flex h-full w-full flex-1 flex-col gap-2 p-2">
	<ChatHistory messages={chatSession.messages} />
	<ChatControls
		isGenerating={chatSession.isGenerating}
		onNewChat={() => chatSession.newChat()}
		onSendMessage={(content) => runChatAction(() => chatSession.sendMessage(content))}
		onRegenerateMessage={() => runChatAction(() => chatSession.regenerateLastMessage())}
		onStopGeneration={() => chatSession.stopGeneration()}
	/>
</div>
