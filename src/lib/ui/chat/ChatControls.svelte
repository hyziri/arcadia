<script lang="ts">
	import { Send } from '@lucide/svelte';
</script>

<div class="flex w-full items-center justify-center gap-2 p-2">
	<textarea class="textarea h-10 min-h-0 w-full resize-none"></textarea>
	<button class="btn btn-square btn-ghost">
		<Send size={24} />
	</button>
</div>
