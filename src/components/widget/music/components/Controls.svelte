<script lang="ts">
import Icon from "@iconify/svelte";
import type { RepeatMode } from "../../../../types/music";
import NextButton from "../atoms/NextButton.svelte";
import PlayButton from "../atoms/PlayButton.svelte";
import PrevButton from "../atoms/PrevButton.svelte";

interface Props {
	isPlaying: boolean;
	isLoading: boolean;
	isShuffled: boolean;
	repeatMode: RepeatMode;
	onToggleMode: () => void;
	onPrev: () => void;
	onNext: () => void;
	onTogglePlay: () => void;
	onTogglePlaylist: () => void;
}

const {
	isPlaying,
	isLoading,
	isShuffled,
	repeatMode,
	onToggleMode,
	onPrev,
	onNext,
	onTogglePlay,
	onTogglePlaylist,
}: Props = $props();

const repeatIcon = $derived(
	isShuffled
		? "material-symbols:shuffle-rounded"
		: repeatMode === 1
			? "material-symbols:repeat-one-rounded"
			: "material-symbols:repeat-rounded",
);

const modeActive = $derived(isShuffled || repeatMode > 0);
</script>

<div class="controls-row">
	<button
		class="icon-btn"
		class:active-mode={modeActive}
		onclick={onToggleMode}
		aria-label="播放模式"
	>
		<Icon icon={repeatIcon} class="text-xl" />
	</button>
	<PrevButton onclick={onPrev} />
	<PlayButton {isPlaying} {isLoading} onclick={onTogglePlay} />
	<NextButton onclick={onNext} />
	<button class="icon-btn list-btn" onclick={onTogglePlaylist} aria-label="播放列表">
		<Icon icon="material-symbols:queue-music-rounded" class="text-xl" />
	</button>
</div>

<style>
	.controls-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.25rem;
		margin-top: 0.6rem;
		padding-inline: 0.1rem;
	}

	.icon-btn {
		width: 2rem;
		height: 2rem;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--content-meta);
		transition: color 150ms ease, transform 150ms ease;
		flex-shrink: 0;
	}

	.icon-btn:hover {
		color: var(--primary);
	}

	.icon-btn:active {
		transform: scale(0.94);
	}

	.active-mode {
		color: var(--primary);
	}

	.controls-row :global(button) {
		flex-shrink: 0;
	}
</style>
