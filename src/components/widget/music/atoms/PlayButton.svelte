<script lang="ts">
import Icon from "@iconify/svelte";
import I18nKey from "../../../../i18n/i18nKey";
import { i18n } from "../../../../i18n/translation";

interface Props {
	isPlaying: boolean;
	isLoading: boolean;
	onclick: () => void;
}

const { isPlaying, isLoading, onclick }: Props = $props();
</script>

<button
	class="btn-regular w-11 h-11 rounded-full"
	class:opacity-50={isLoading}
	disabled={isLoading}
	aria-label={isPlaying ? i18n(I18nKey.musicBoxPause) : i18n(I18nKey.musicBoxPlay)}
	{onclick}
>
	{#if isLoading}
		<Icon icon="eos-icons:loading" class="text-xl" />
	{:else if isPlaying}
		<Icon icon="material-symbols:pause" class="text-xl" />
	{:else}
		<Icon icon="material-symbols:play-arrow" class="text-xl" />
	{/if}
</button>
