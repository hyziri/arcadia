<script lang="ts">
	import { Plug } from '@lucide/svelte';

	import LlmSettings from './LlmSettings.svelte';

	type SettingsView = 'llm';

	let activeView: SettingsView = $state('llm');
</script>

<div class="flex">
	<nav class="w-64 border-r border-base-content/15 pr-4">
		<button
			class="btn w-full justify-start gap-2 btn-ghost"
			class:btn-active={activeView === 'llm'}
			aria-current={activeView === 'llm' ? 'page' : undefined}
			onclick={() => (activeView = 'llm')}
		>
			<Plug />
			<span>LLM</span>
		</button>
	</nav>
	<div class="min-w-0 flex-1 pl-4">
		{#if activeView}
			<LlmSettings />
		{/if}
	</div>
</div>
