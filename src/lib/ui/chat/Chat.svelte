<script lang="ts">
	import { type ChatMessage } from '#lib/model';
	import ChatControls from './ChatControls.svelte';
	import ChatHistory from './ChatHistory.svelte';

	let messages: ChatMessage[] = $state([]);
</script>

<div class="flex h-full w-full flex-1 flex-col">
	<ChatHistory {messages} />
	<ChatControls />
</div>
