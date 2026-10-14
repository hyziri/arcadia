<script lang="ts">
	import { Settings } from '@lucide/svelte';

	import { getDialogContext } from '#lib/state';

	const dialogController = getDialogContext();
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
