<script lang="ts">
	import { X } from '@lucide/svelte';
	import type { Snippet } from 'svelte';

	interface Props {
		open: boolean;
		title: string;
		size?: 'default' | 'wide';
		onDismiss: () => void;
		onCloseComplete: () => void;
		children: Snippet;
	}

	let { open, title, size = 'default', onDismiss, onCloseComplete, children }: Props = $props();
	let dialogElement: HTMLDialogElement | undefined;
	let dialogBoxElement: HTMLDivElement | undefined;
	let closeGeneration = 0;

	/** Starts native closure while keeping the host content mounted until it completes. */
	function requestClose() {
		if (dialogElement?.open) dialogElement.close();
	}

	/** Keeps Escape dismissal controlled by the layout's dialog state. */
	function handleCancel(event: Event) {
		event.preventDefault();
		requestClose();
	}

	/** Closes the dialog only when the click lands on the backdrop. */
	function handleBackdropClick(event: MouseEvent) {
		if (event.target === dialogElement) requestClose();
	}

	/** Synchronizes the open state immediately and waits before releasing the content. */
	function handleClose() {
		onDismiss();
		const generation = ++closeGeneration;
		const closingAnimations = [
			...(dialogElement?.getAnimations() ?? []),
			...(dialogBoxElement?.getAnimations() ?? [])
		];

		void Promise.allSettled(closingAnimations.map((animation) => animation.finished)).then(() => {
			if (generation === closeGeneration && !dialogElement?.open) onCloseComplete();
		});
	}

	$effect(() => {
		if (!dialogElement) return;

		if (open && !dialogElement.open) {
			closeGeneration += 1;
			dialogElement.showModal();
		} else if (!open && dialogElement.open) {
			dialogElement.close();
		}
	});
</script>

<dialog
	bind:this={dialogElement}
	class="modal"
	aria-labelledby="dialog-title"
	oncancel={handleCancel}
	onclick={handleBackdropClick}
	onclose={handleClose}
>
	<div
		bind:this={dialogBoxElement}
		class="relative modal-box max-h-screen w-11/12 overflow-y-auto {size === 'wide'
			? 'max-w-5xl'
			: 'max-w-lg'}"
	>
		<div class="mb-4 flex items-center justify-between gap-4">
			<h2 id="dialog-title" class="text-lg font-semibold">{title}</h2>
			<button
				type="button"
				class="btn btn-circle btn-ghost btn-sm"
				aria-label="Close dialog"
				onclick={requestClose}
			>
				<X size={18} aria-hidden="true" />
			</button>
		</div>
		{@render children()}
	</div>
</dialog>
