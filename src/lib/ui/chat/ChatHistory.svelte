<script lang="ts">
	import type { ChatMessageView } from '#lib/state';

	import ChatMessageComponent from './ChatMessage.svelte';

	interface Props {
		messages: ChatMessageView[];
	}

	let { messages }: Props = $props();
</script>

<div class="flex flex-1 flex-col gap-2 overflow-y-auto">
	{#each messages as message (message.viewId)}
		<ChatMessageComponent {message} />
	{/each}
</div>
