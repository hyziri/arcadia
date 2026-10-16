<script lang="ts">
	import { onMount } from 'svelte';

	import { appState, ChatSession, getToastContext } from '#lib/state';

	import ChatControls from './ChatControls.svelte';
	import ChatHistory from './ChatHistory.svelte';

	const toastContext = getToastContext();
	let chatSession = $state<ChatSession | null>(null);
	let initializationError = $state<string | null>(null);

	function runChatAction(action: (session: ChatSession) => Promise<void>): void {
		const session = chatSession;
		if (session === null) return;

		void action(session).then(() => {
			if (session.generationError !== null) {
				toastContext.showToast({ kind: 'error', message: session.generationError });
			}
		});
	}

	/** Loads the browser-backed service and aborts generation on unmount. */
	onMount(() => {
		let isUnmounted = false;

		void appState
			.getLlmService()
			.then((service) => {
				if (!isUnmounted) chatSession = new ChatSession(service);
			})
			.catch((cause: unknown) => {
				if (!isUnmounted) {
					initializationError =
						cause instanceof Error ? cause.message : 'Unable to initialize chat.';

					toastContext.showToast({ kind: 'error', message: initializationError });
				}
			});

		return () => {
			isUnmounted = true;
			chatSession?.stopGeneration();
		};
	});
</script>

{#if chatSession !== null}
	<div class="flex h-full w-full flex-1 flex-col gap-2 p-2">
		<ChatHistory messages={chatSession.messages} />
		<ChatControls
			isGenerating={chatSession.isGenerating}
			onNewChat={() => {
				void chatSession?.newChat();
			}}
			onSendMessage={(content) => runChatAction((session) => session.sendMessage(content))}
			onRegenerateMessage={() => runChatAction((session) => session.regenerateLastMessage())}
			onStopGeneration={() => chatSession?.stopGeneration()}
		/>
	</div>
{:else if initializationError !== null}
	<div class="flex h-full w-full flex-1 items-center justify-center">
		<p role="alert">{initializationError}</p>
	</div>
{:else}
	<div class="flex h-full w-full flex-1 items-center justify-center">
		<div class="flex flex-col items-center justify-center gap-2">
			<span class="loading loading-md loading-spinner"></span>
			<p>Loading chat…</p>
		</div>
	</div>
{/if}
