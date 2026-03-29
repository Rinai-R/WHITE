<script lang="ts">
	interface Props {
		currentTime: number;
		duration: number;
		onSeek: (time: number) => void;
	}

	const { currentTime, duration, onSeek }: Props = $props();

	const progressPct = $derived(
		duration > 0 ? Math.max(0, Math.min(100, (currentTime / duration) * 100)) : 0
	);

	function handleClick(event: MouseEvent) {
		const el = event.currentTarget as HTMLElement;
		if (!el || duration <= 0) return;
		const rect = el.getBoundingClientRect();
		const pct = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
		onSeek(pct * duration);
	}
</script>

<div class="progress-wrap">
	<div
		class="progress-bar"
		onclick={handleClick}
		onkeydown={(e) => {
			if (e.key === "ArrowLeft") {
				e.preventDefault();
				onSeek(Math.max(0, currentTime - 5));
			} else if (e.key === "ArrowRight") {
				e.preventDefault();
				onSeek(Math.min(duration, currentTime + 5));
			}
		}}
		role="slider"
		tabindex="0"
		aria-label="播放进度"
		aria-valuemin="0"
		aria-valuemax="100"
		aria-valuenow={progressPct}
	>
		<div class="progress-fill" style={`width: ${progressPct}%`}></div>
	</div>
</div>

<style>
	.progress-wrap {
		margin-top: 0.2rem;
		margin-bottom: 0.1rem;
	}

	.progress-bar {
		position: relative;
		width: 100%;
		height: 0.3rem;
		border-radius: 9999px;
		background: color-mix(in srgb, var(--btn-regular-bg) 80%, var(--content-meta) 20%);
		overflow: hidden;
		cursor: pointer;
	}

	.progress-fill {
		height: 100%;
		border-radius: inherit;
		background: var(--primary);
		transition: width 100ms linear;
		min-width: 0;
	}

	.progress-bar:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 2px;
	}
</style>
