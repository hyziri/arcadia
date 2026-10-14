<script lang="ts">
	import { Settings } from '@lucide/svelte';
	import { getContext } from 'svelte';

	import { DIALOG_CONTEXT, type DialogController } from '#lib/state';

	const dialogController = getContext<DialogController>(DIALOG_CONTEXT);
</script>

<div class="navbar">
	<div class="navbar-start"></div>
	<div class="navbar-end">
		<button
			type="button"
			class="btn btn-square btn-ghost"
			aria-label="Open settings"
			onclick={dialogController.openSettingsDialog}
		>
			<Settings size={24} />
		</button>
	</div>
</div>
