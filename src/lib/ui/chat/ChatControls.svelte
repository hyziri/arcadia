<script lang="ts">
	import { Send } from '@lucide/svelte';

	interface Props {
		onSend: (message: string) => void;
	}

	let { onSend }: Props = $props();

	let message = $state('');

	let textarea: HTMLTextAreaElement;

	function sendMessage() {
		const trimmedMessage = message.trim();
		if (!trimmedMessage) return;

		onSend(trimmedMessage);
		message = '';
	}

	/** Adjusts the textarea height to fit its current content without a scrollbar. */
	function resizeTextarea() {
		textarea.style.height = '0px';
		textarea.style.height = `${textarea.scrollHeight}px`;
	}

	/** Sends on Enter while preserving the browser newline behavior for Shift+Enter. */
	function handleKeydown(event: KeyboardEvent) {
		if (event.isComposing || event.key !== 'Enter' || event.shiftKey) return;

		event.preventDefault();
		sendMessage();
	}

	$effect(() => {
		message;
		if (!textarea) return;

		resizeTextarea();
	});
</script>

<div class="flex w-full items-center justify-center gap-2">
	<textarea
		bind:this={textarea}
		bind:value={message}
		class="textarea h-10 max-h-[40dvh] min-h-0 w-full resize-none overflow-y-auto"
		onkeydown={handleKeydown}></textarea>
	<button class="btn btn-square btn-ghost" onclick={sendMessage}>
		<Send size={24} />
	</button>
</div>
