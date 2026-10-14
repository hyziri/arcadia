<script lang="ts">
	import { X } from '@lucide/svelte';

	import { type Toast, type ToastKind } from '#lib/state';

	interface Props {
		toasts: Toast[];
		dismissToast: (toastId: string) => void;
		pauseToast: (toastId: string) => void;
		resumeToast: (toastId: string) => void;
	}

	let { toasts, dismissToast, pauseToast, resumeToast }: Props = $props();

	const alertClass: Record<ToastKind, string> = {
		success: 'alert-success',
		error: 'alert-error',
		info: 'alert-info',
		warning: 'alert-warning'
	};
</script>

<div
	data-toast
	class="toast toast-center toast-top z-50 mt-16 w-full max-w-md px-4"
	aria-live="polite"
>
	{#each toasts as toast (toast.id)}
		<div
			class={`alert ${alertClass[toast.kind]} flex justify-between shadow-lg`}
			role={toast.kind === 'error' ? 'alert' : 'status'}
			onmouseenter={() => pauseToast(toast.id)}
			onmouseleave={() => resumeToast(toast.id)}
			onfocusin={() => pauseToast(toast.id)}
			onfocusout={() => resumeToast(toast.id)}
		>
			<span>{toast.message}</span>

			<button
				class="btn btn-square btn-ghost text-inherit btn-sm
				hover:bg-current/10
				focus:bg-transparent
				focus-visible:bg-current/10
				focus-visible:ring-2"
				type="button"
				aria-label="Dismiss notification"
				onclick={() => dismissToast(toast.id)}
			>
				<X size={16} aria-hidden="true" />
			</button>
		</div>
	{/each}
</div>
