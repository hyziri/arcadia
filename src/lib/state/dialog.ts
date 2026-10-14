/** Defines the typed context API for layout-owned dialog state. */

import { createContext } from 'svelte';

/** Commands exposed to descendants by the layout that owns dialog state. */
export interface DialogController {
	openSettingsDialog(): void;
	closeDialog(): void;
}

/** Typed getter and setter for the layout-scoped dialog controller. */
export const [getDialogContext, setDialogContext] = createContext<DialogController>();
