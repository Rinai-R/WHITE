<script lang="ts">
	interface Props {
		cover: string;
		isPlaying: boolean;
		isLoading: boolean;
	}

	const { cover, isPlaying, isLoading }: Props = $props();

	function getAssetPath(path: string): string {
		if (!path) return "/favicon/favicon.png";
		if (path.startsWith("http://") || path.startsWith("https://")) return path;
		if (path.startsWith("/")) return path;
		return `/${path}`;
	}
</script>

<div class="cover-container">
	<img
		src={getAssetPath(cover)}
		alt="封面"
		loading="eager"
		class="cover-img"
		class:spinning={isPlaying && !isLoading}
		class:loading-pulse={isLoading}
	/>
</div>

<style>
	.cover-container {
		width: 4rem;
		height: 4rem;
		border-radius: 9999px;
		overflow: hidden;
		flex-shrink: 0;
		background: var(--btn-regular-bg);
	}

	.cover-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		animation: spin-cover 8s linear infinite;
		animation-play-state: paused;
		transform-origin: center;
	}

	.cover-img.spinning {
		animation-play-state: running;
	}

	.cover-img.loading-pulse {
		animation: none;
		opacity: 0.6;
	}

	@keyframes spin-cover {
		from { transform: rotate(0deg); }
		to { transform: rotate(360deg); }
	}
</style>
