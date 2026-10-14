<script lang="ts">
	import { setContext } from 'svelte';

	import { Dialog, Header, Settings } from '#lib/ui';
	import favicon from '#lib/assets/favicon.svg';
	import { DIALOG_CONTEXT, type DialogController } from '#lib/state';

	import type { LayoutProps } from './$types';
	import './layout.css';

	type DialogContent = { type: 'settings' };
	type DialogState = { status: 'closed' } | { status: 'open' | 'closing'; content: DialogContent };

	let { children }: LayoutProps = $props();
	let dialogState = $state<DialogState>({ status: 'closed' });

	/** Opens the settings dialog requested by a descendant. */
	function openSettingsDialog() {
		dialogState = { status: 'open', content: { type: 'settings' } };
	}

	/** Starts closure while retaining the selected content through the exit transition. */
	function dismissDialog() {
		if (dialogState.status === 'open') {
			dialogState = { status: 'closing', content: dialogState.content };
		}
	}

	/** Clears the selected dialog after its exit transition completes. */
	function handleDialogCloseComplete() {
		if (dialogState.status === 'closing') dialogState = { status: 'closed' };
	}

	const dialogController: DialogController = {
		openSettingsDialog,
		closeDialog: dismissDialog
	};
	setContext(DIALOG_CONTEXT, dialogController);
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<div class="h-screen">
	<Header />
	<main class="h-[calc(100dvh-64px)]">
		<div class="mx-auto h-full w-full max-w-7xl">
			{@render children()}
		</div>
	</main>

	{#if dialogState.status !== 'closed'}
		<Dialog
			open={dialogState.status === 'open'}
			title="Settings"
			size="wide"
			onDismiss={dismissDialog}
			onCloseComplete={handleDialogCloseComplete}
		>
			{#if dialogState.content.type === 'settings'}
				<Settings />
			{/if}
		</Dialog>
	{/if}
</div>
