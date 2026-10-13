<script lang="ts">
	import { CircleStop, Menu, RotateCcw, Send } from '@lucide/svelte';

	interface Props {
		isGenerating: boolean;
		onSendMessage: (message: string) => void;
		onRegenerateMessage: () => void;
		onStopGeneration: () => void;
	}

	let { isGenerating, onSendMessage, onRegenerateMessage, onStopGeneration }: Props = $props();

	let message = $state('');
	let isActionMenuOpen = $state(false);

	let textarea: HTMLTextAreaElement;
	let actionMenuContainer: HTMLDivElement;
	let actionMenuTrigger: HTMLButtonElement;

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

	/** Invokes the regenerate action after closing the menu. */
	function regenerateMessage() {
		closeActionMenu(true);
		onRegenerateMessage();
	}

	/** Closes the action menu and optionally returns focus to its trigger. */
	function closeActionMenu(restoreFocus = false) {
		isActionMenuOpen = false;
		if (restoreFocus) actionMenuTrigger.focus();
	}

	/** Closes the action menu when a click occurs outside its trigger and panel. */
	function handleWindowClick(event: MouseEvent) {
		if (!(event.target instanceof Node) || !actionMenuContainer.contains(event.target)) {
			closeActionMenu();
		}
	}

	/** Closes the action menu on Escape and returns focus to its trigger. */
	function handleWindowKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || !isActionMenuOpen) return;

		closeActionMenu(true);
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

<svelte:window onclick={handleWindowClick} onkeydown={handleWindowKeydown} />

<div class="flex w-full items-center justify-center gap-2">
	<div bind:this={actionMenuContainer} class="relative">
		<button
			bind:this={actionMenuTrigger}
			class="btn btn-square btn-ghost"
			type="button"
			aria-label="Chat actions"
			aria-expanded={isActionMenuOpen}
			aria-controls="chat-actions-menu"
			onclick={() => (isActionMenuOpen = !isActionMenuOpen)}
		>
			<Menu size={24} />
		</button>
		{#if isActionMenuOpen}
			<div
				id="chat-actions-menu"
				class="absolute bottom-full left-0 z-10 mb-2 w-44 rounded-box border border-base-300 bg-base-100 p-2 shadow-lg"
			>
				<button
					class="btn w-full justify-start gap-2 btn-ghost"
					type="button"
					disabled={isGenerating}
					onclick={regenerateMessage}
				>
					<RotateCcw size={18} />
					<span>Regenerate</span>
				</button>
			</div>
		{/if}
	</div>
	<textarea
		bind:this={textarea}
		bind:value={message}
		class="textarea h-10 max-h-[40dvh] min-h-0 w-full resize-none overflow-y-auto"
		onkeydown={handleKeydown}></textarea>
	{#if isGenerating}
		<button
			class="btn btn-square btn-ghost"
			type="button"
			aria-label="Stop generation"
			onclick={onStopGeneration}
		>
			<CircleStop size={24} />
		</button>
	{:else}
		<button
			class="btn btn-square btn-ghost"
			type="button"
			aria-label="Send message"
			onclick={sendMessage}
		>
			<Send size={24} />
		</button>
	{/if}
</div>
