<script lang="ts">
	import type { ChatMessage } from '#lib/model';

	import { default as ChatMessageView } from './ChatMessage.svelte';

	interface Props {
		messages: ChatMessage[];
	}

	let { messages }: Props = $props();
</script>

<div class="flex flex-1 flex-col gap-2 overflow-y-auto">
	{#each messages as message (message)}
		<ChatMessageView {message} />
	{/each}
</div>
