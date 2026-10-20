<script lang="ts">
	import type { ChatMessageView } from '#lib/state';

	interface Props {
		message: ChatMessageView;
	}

	let { message }: Props = $props();
</script>

<div class="w-full">
	<span class="font-bold">{message.sender}</span>
	<span>{message.content}</span>
</div>
