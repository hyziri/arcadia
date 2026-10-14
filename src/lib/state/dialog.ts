/** Defines the layout-scoped API for opening and dismissing dialogs. */
export const DIALOG_CONTEXT = Symbol('dialog-context');

/** Commands exposed to descendants by the layout that owns dialog state. */
export interface DialogController {
	openSettingsDialog(): void;
	closeDialog(): void;
}
