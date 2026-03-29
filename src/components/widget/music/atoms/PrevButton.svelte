<script lang="ts">
	import Icon from "@iconify/svelte";

	interface Props {
		onclick: () => void;
		disabled?: boolean;
	}

	const { onclick, disabled = false }: Props = $props();
</script>

<button class="btn-plain w-9 h-9 rounded-lg" aria-label="上一首" {onclick} {disabled}>
	<Icon icon="material-symbols:skip-previous" class="text-xl" />
</button>
