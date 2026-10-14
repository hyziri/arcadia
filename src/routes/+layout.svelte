<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';

	import { Dialog, Header, Settings, Toast as ToastComponent } from '#lib/ui';
	import favicon from '#lib/assets/favicon.svg';
	import {
		setDialogContext,
		setToastContext,
		type DialogController,
		type Toast,
		type ToastController
	} from '#lib/state';

	import type { LayoutProps } from './$types';
	import './layout.css';

	type DialogContent = { type: 'settings' };
	type DialogState = { status: 'closed' } | { status: 'open' | 'closing'; content: DialogContent };

	interface ToastTimer {
		timeoutId: number;
		startedAt: number;
		remaining: number;
		paused: boolean;
	}

	const toastTimers = new SvelteMap<string, ToastTimer>();

	let { children }: LayoutProps = $props();
	let toasts = $state<Toast[]>([]);
	let dialogState = $state<DialogState>({ status: 'closed' });

	const showToast = (toast: Omit<Toast, 'id'>): void => {
		const id = crypto.randomUUID();
		const duration = toast.duration ?? 4000;

		toasts.push({ ...toast, id });

		if (toast.duration !== 0) {
			const timer: ToastTimer = {
				timeoutId: window.setTimeout(() => dismissToast(id), duration),
				startedAt: Date.now(),
				remaining: duration,
				paused: false
			};

			toastTimers.set(id, timer);
		}
	};

	const pauseToast = (toastId: string): void => {
		const timer = toastTimers.get(toastId);

		if (!timer || timer.paused) return;

		window.clearTimeout(timer.timeoutId);
		timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.startedAt));
		timer.paused = true;
	};

	const resumeToast = (toastId: string): void => {
		const timer = toastTimers.get(toastId);

		if (!timer || !timer.paused) return;

		timer.startedAt = Date.now();
		timer.timeoutId = window.setTimeout(() => dismissToast(toastId), timer.remaining);
		timer.paused = false;
	};

	const dismissToast = (toastId: string): void => {
		const timer = toastTimers.get(toastId);
		if (timer) window.clearTimeout(timer.timeoutId);
		toastTimers.delete(toastId);
		toasts = toasts.filter((toast) => toast.id !== toastId);
	};

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
	const toastController: ToastController = { showToast, dismissToast };

	setDialogContext(dialogController);
	setToastContext(toastController);
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

	<ToastComponent {toasts} {dismissToast} {pauseToast} {resumeToast} />
</div>
