<script lang="ts">
	import { CircleStop, Send } from '@lucide/svelte';

	interface Props {
		isGenerating: boolean;
		onSendMessage: (message: string) => void;
		onStopGeneration: () => void;
	}

	let { isGenerating, onSendMessage, onStopGeneration }: Props = $props();

	let message = $state('');

	let textarea: HTMLTextAreaElement;

	/** Trims and sends the message if it contains non-whitespace text, then clears the input. */
	function sendMessage() {
		const trimmedMessage = message.trim();
		if (!trimmedMessage) return;

		onSendMessage(trimmedMessage);
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
		void message;
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
	{#if isGenerating}
		<button class="btn btn-square btn-ghost" onclick={onStopGeneration}>
			<CircleStop size={24} />
		</button>
	{:else}
		<button class="btn btn-square btn-ghost" onclick={sendMessage}>
			<Send size={24} />
		</button>
	{/if}
</div>
