<script lang="ts">
	import type { ChatMessage } from '#lib/model';

	interface Props {
		message: ChatMessage;
	}

	let { message }: Props = $props();
</script>

<div class="w-full">
	<span class="font-bold">{message.sender}</span>
	<span>{message.content}</span>
</div>
