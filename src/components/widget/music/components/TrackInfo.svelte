<script lang="ts">
import Icon from "@iconify/svelte";
import I18nKey from "../../../../i18n/i18nKey";
import { i18n } from "../../../../i18n/translation";
import type { Song } from "../../../types/music";

interface Props {
	currentSong: Song;
	currentTime: number;
	duration: number;
	volume: number;
	isMuted: boolean;
	onToggleMute: () => void;
	onSetVolume: (v: number) => void;
}

const {
	currentSong,
	currentTime,
	duration,
	volume,
	isMuted,
	onToggleMute,
	onSetVolume,
}: Props = $props();

const timeLabel = $derived(
	`${Math.floor(currentTime / 60)}:${String(Math.floor(currentTime % 60)).padStart(2, "0")}`,
);
const durLabel = $derived(
	`${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, "0")}`,
);
const volumePercent = $derived(
	isMuted ? 0 : Math.max(0, Math.min(100, volume * 100)),
);

let isDragging = false;

function handleVolumePointer(event: PointerEvent) {
	const el = event.currentTarget as HTMLElement;
	if (!el) return;
	isDragging = true;
	const rect = el.getBoundingClientRect();
	const pct = (event.clientX - rect.left) / rect.width;
	onSetVolume(Math.max(0, Math.min(1, pct)));
	el.setPointerCapture(event.pointerId);
}

function handleVolumeMove(event: PointerEvent) {
	if (!isDragging) return;
	handleVolumePointer(event);
}

function handleVolumeEnd() {
	isDragging = false;
}

function handleVolumeKey(event: KeyboardEvent) {
	if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
		event.preventDefault();
		onSetVolume(Math.max(0, volume - 0.05));
	} else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
		event.preventDefault();
		onSetVolume(Math.min(1, volume + 0.05));
	} else if (event.key === "Enter") {
		onToggleMute();
	}
}
</script>

<div class="flex flex-col min-w-0 flex-1 overflow-hidden">
	<p class="title-text truncate">{currentSong.title}</p>
	<p class="artist-text truncate">{currentSong.artist}</p>
	<div class="meta-row">
		<span class="time-text">{timeLabel} / {durLabel}</span>
		<div class="volume-wrap">
			<button
				type="button"
				class="vol-btn"
				onclick={onToggleMute}
				aria-label={isMuted ? i18n(I18nKey.musicBoxUnmute) : i18n(I18nKey.musicBoxMute)}
			>
				<Icon
					icon={isMuted || volume === 0
						? "material-symbols:volume-off-rounded"
						: "material-symbols:volume-up-rounded"}
					class="text-base"
				/>
			</button>
			<div
				class="vol-slider"
				onpointerdown={handleVolumePointer}
				onpointermove={handleVolumeMove}
				onpointerup={handleVolumeEnd}
				onpointercancel={handleVolumeEnd}
				onkeydown={handleVolumeKey}
				role="slider"
				tabindex="0"
				aria-label={i18n(I18nKey.musicBoxVolume)}
				aria-valuemin="0"
				aria-valuemax="100"
				aria-valuenow={volumePercent}
			>
				<div class="vol-fill" style={`width: ${volumePercent}%`}></div>
			</div>
		</div>
	</div>
</div>

<style>
	.title-text {
		font-weight: 600;
		font-size: 0.875rem;
		color: var(--content-main);
		line-height: 1.2;
		margin-bottom: 0.1rem;
	}

	.artist-text {
		font-size: 0.7rem;
		color: var(--content-meta);
		margin-bottom: 0.35rem;
		display: block;
	}

	.meta-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		min-width: 0;
	}

	.time-text {
		font-size: 10px;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		color: var(--content-meta);
		white-space: nowrap;
		flex-shrink: 0;
	}

	.volume-wrap {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		margin-left: auto;
	}

	.vol-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.4rem;
		height: 1.4rem;
		color: var(--content-meta);
		transition: color 150ms ease;
		border-radius: 0.25rem;
	}

	.vol-btn:hover {
		color: var(--primary);
	}

	.vol-slider {
		position: relative;
		width: 3.5rem;
		height: 0.25rem;
		border-radius: 9999px;
		background: color-mix(in srgb, var(--btn-regular-bg) 80%, var(--content-meta) 20%);
		overflow: hidden;
		cursor: pointer;
		flex-shrink: 0;
		transition: height 150ms ease;
	}

	.vol-slider:hover,
	.vol-slider:focus-visible {
		height: 0.375rem;
	}

	.vol-fill {
		height: 100%;
		background: var(--primary);
		border-radius: inherit;
		transition: width 100ms linear;
	}

	.vol-slider:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 2px;
	}

</style>
