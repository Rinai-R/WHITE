<script lang="ts">
	import { onDestroy, onMount } from "svelte";
	import type { MusicPlayerState } from "../../../stores/musicPlayerStore";
	import { musicPlayerStore } from "../../../stores/musicPlayerStore";
	import CoverImage from "./atoms/CoverImage.svelte";
	import Controls from "./components/Controls.svelte";
	import Playlist from "./components/Playlist.svelte";
	import Progress from "./components/Progress.svelte";
	import TrackInfo from "./components/TrackInfo.svelte";

	let state: MusicPlayerState = $state(musicPlayerStore.getState());

	function handleStateUpdate(event: Event) {
		const custom = event as CustomEvent<MusicPlayerState>;
		if (custom.detail) state = custom.detail;
	}

	onMount(async () => {
		window.addEventListener("music-player:state", handleStateUpdate);
		await musicPlayerStore.initialize();
	});

	onDestroy(() => {
		if (typeof window !== "undefined") {
			window.removeEventListener("music-player:state", handleStateUpdate);
		}
	});
</script>

<div class="music-widget">
	<div class="top-row">
		<CoverImage
			cover={state.currentSong.cover}
			isPlaying={state.isPlaying}
			isLoading={state.isLoading}
		/>
		<TrackInfo
			currentSong={state.currentSong}
			currentTime={state.currentTime}
			duration={state.duration}
			volume={state.volume}
			isMuted={state.isMuted}
			onToggleMute={() => musicPlayerStore.toggleMute()}
			onSetVolume={(v) => musicPlayerStore.setVolume(v)}
		/>
	</div>

	<Progress
		currentTime={state.currentTime}
		duration={state.duration}
		onSeek={(t) => musicPlayerStore.seek(t)}
	/>

	<Controls
		isPlaying={state.isPlaying}
		isLoading={state.isLoading}
		isShuffled={state.isShuffled}
		repeatMode={state.isRepeating}
		onToggleMode={() => musicPlayerStore.toggleMode()}
		onPrev={() => musicPlayerStore.prev()}
		onNext={() => musicPlayerStore.next()}
		onTogglePlay={() => musicPlayerStore.toggle()}
		onTogglePlaylist={() => musicPlayerStore.togglePlaylist()}
	/>

	<Playlist
		playlist={state.playlist}
		currentIndex={state.currentIndex}
		isPlaying={state.isPlaying}
		show={state.showPlaylist}
		onClose={() => musicPlayerStore.togglePlaylist()}
		onPlaySong={(i) => musicPlayerStore.playIndex(i)}
	/>

	{#if state.showError}
		<div class="error-toast">
			{state.errorMessage}
		</div>
	{/if}
</div>

<style>
	.music-widget {
		width: 100%;
	}

	.top-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 0.25rem;
	}

	.error-toast {
		margin-top: 0.5rem;
		padding: 0.4rem 0.75rem;
		border-radius: 0.5rem;
		background: color-mix(in srgb, var(--btn-regular-bg) 90%, red 10%);
		color: var(--content-meta);
		font-size: 0.75rem;
		text-align: center;
	}

	:global(.dark) .error-toast {
		color: var(--content-main);
	}
</style>
