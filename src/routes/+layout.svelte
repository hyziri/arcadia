<script lang="ts">
	import favicon from '#lib/assets/favicon.svg';

	import type { LayoutProps } from './$types';
	import './layout.css';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<main class="h-screen w-screen">
	<div class="mx-auto h-full w-full max-w-7xl">
		{@render children()}
	</div>
</main>
