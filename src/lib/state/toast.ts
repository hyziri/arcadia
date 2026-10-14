/** Defines the typed context and notification models for layout-owned toasts. */

import { createContext } from 'svelte';

/** Visual category used to select toast styling and accessibility roles. */
export type ToastKind = 'success' | 'error' | 'info' | 'warning';

/** Notification data held by the layout while a toast is active. */
export interface Toast {
	id: string;
	kind: ToastKind;
	message: string;
	duration?: number;
}

/** Commands exposed to descendants by the layout that owns toast state. */
export interface ToastController {
	showToast: (toast: Omit<Toast, 'id'>) => void;
	dismissToast: (toastId: string) => void;
}

/** Typed getter and setter for the layout-scoped toast controller. */
export const [getToastContext, setToastContext] = createContext<ToastController>();
