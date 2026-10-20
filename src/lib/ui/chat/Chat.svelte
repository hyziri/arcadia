<script lang="ts">
	import { onMount } from 'svelte';

	import { appState, ChatSession, getToastContext } from '#lib/state';

	import ChatControls from './ChatControls.svelte';
	import ChatHistory from './ChatHistory.svelte';

	const toastContext = getToastContext();
	let chatSession = new ChatSession(
		() => appState.getChatService(),
		() => appState.getLlmService()
	);

	async function runChatAction<T>(action: () => Promise<T>): Promise<T | undefined> {
		return action().catch((cause: unknown) => {
			toastContext.showToast({
				kind: 'error',
				message: cause instanceof Error ? cause.message : 'Chat operation failed.'
			});
			return undefined;
		});
	}

	onMount(() => {
		runChatAction(() => chatSession.loadMostRecentChat());
	});
</script>

<div class="flex h-full w-full flex-1 flex-col gap-2 p-2">
	<ChatHistory messages={chatSession.messages} />
	<ChatControls
		isLoading={chatSession.isLoading}
		chatState={chatSession.chatState}
		onNewChat={() => chatSession.newChat()}
		onSendMessage={(content) =>
			runChatAction(async () => {
				const persisted = await chatSession.sendMessage(content);
				if (!persisted) return false;

				const generationPromise = chatSession.generateResponse();
				void runChatAction(() => generationPromise);
				return true;
			}).then((persisted) => persisted ?? false)}
		onRegenerateMessage={() => runChatAction(() => chatSession.regenerateResponse())}
		onStopGeneration={() => chatSession.stopGeneration()}
	/>
</div>
