<script lang="ts">
import Icon from "@iconify/svelte";
import I18nKey from "../../../../i18n/i18nKey";
import { i18n } from "../../../../i18n/translation";
import type { Song } from "../../../../types/music";
import { getAssetPath } from "../../../../utils/asset-path";

interface Props {
	playlist: Song[];
	currentIndex: number;
	isPlaying: boolean;
	show: boolean;
	onClose: () => void;
	onPlaySong: (index: number) => void;
}

const { playlist, currentIndex, isPlaying, show, onClose, onPlaySong }: Props =
	$props();
</script>

<div class="playlist-drawer" class:open={show}>
	<div class="playlist-inner">
		<div class="playlist-shell">
			<div class="playlist-list" role="listbox" aria-label={i18n(I18nKey.musicBoxPlaylist)}>
				{#each playlist as song, index}
					<div
						class="track-item"
						class:is-current={index === currentIndex}
						onclick={() => onPlaySong(index)}
						onkeydown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								onPlaySong(index);
							}
						}}
						role="option"
						tabindex="0"
						aria-selected={index === currentIndex}
						aria-label={`${i18n(I18nKey.musicBoxPlay)} ${song.title}`}
					>
						<div class="track-cover">
							<img src={getAssetPath(song.cover, "/favicon/favicon.png")} alt={song.title} loading="lazy" />
						</div>
						<div class="track-info">
							<div class="track-title" class:active={index === currentIndex}>{song.title}</div>
							<div class="track-artist">{song.artist}</div>
						</div>
						{#if index === currentIndex && isPlaying}
							<Icon
								icon="material-symbols:graphic-eq-rounded"
								style="color: var(--primary); font-size: 1rem; flex-shrink: 0;"
							/>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	</div>
</div>

<style>
	.playlist-drawer {
		display: grid;
		grid-template-rows: 0fr;
		opacity: 0;
		transition:
			grid-template-rows 300ms cubic-bezier(0.4, 0, 0.2, 1),
			opacity 300ms cubic-bezier(0.4, 0, 0.2, 1);
	}

	.playlist-drawer.open {
		grid-template-rows: 1fr;
		opacity: 1;
	}

	.playlist-inner {
		overflow: hidden;
		min-height: 0;
	}

	.playlist-shell {
		margin-top: 0.5rem;
		padding-top: 0.5rem;
		border-top: 1px solid color-mix(in srgb, var(--content-meta) 12%, transparent 88%);
	}

	.playlist-list {
		overflow-y: auto;
		max-height: 11rem;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		scrollbar-width: none;
		-ms-overflow-style: none;
		padding-bottom: 0.2rem;
	}

	.playlist-list::-webkit-scrollbar {
		display: none;
	}

	.track-item {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.4rem 0.5rem;
		border-radius: 0.6rem;
		cursor: pointer;
		transition: background-color 160ms ease;
	}

	.track-item:hover {
		background: color-mix(in srgb, var(--btn-plain-bg-hover) 75%, transparent 25%);
	}

	.track-item.is-current {
		background: color-mix(in srgb, var(--btn-plain-bg) 80%, transparent 20%);
	}

	.track-cover {
		width: 2rem;
		height: 2rem;
		border-radius: 0.4rem;
		overflow: hidden;
		flex-shrink: 0;
		background: var(--btn-regular-bg);
	}

	.track-cover img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.track-info {
		flex: 1;
		min-width: 0;
	}

	.track-title {
		font-size: 0.7rem;
		font-weight: 600;
		color: var(--content-main);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.track-title.active {
		color: var(--primary);
	}

	.track-artist {
		font-size: 10px;
		color: var(--content-meta);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
