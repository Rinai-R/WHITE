import type { RepeatMode, Song } from "../types/music";
import { musicPlayerConfig } from "../config";
import musicPlaylist from "../_data/music.json";
import { getAssetPath } from "../utils/asset-path";

export const STORAGE_KEY_VOLUME = "music-player-volume";
export const SKIP_ERROR_DELAY = 1000;

export const DEFAULT_SONG: Song = {
	id: 0,
	title: "未播放",
	artist: "—",
	cover: "/favicon/favicon.png",
	url: "",
	duration: 0,
};

export interface MusicPlayerState {
	currentSong: Song;
	playlist: Song[];
	currentIndex: number;
	isPlaying: boolean;
	isLoading: boolean;
	currentTime: number;
	duration: number;
	volume: number;
	isMuted: boolean;
	isShuffled: boolean;
	isRepeating: RepeatMode;
	showPlaylist: boolean;
	errorMessage: string;
	showError: boolean;
	autoplayFailed: boolean;
}

class MusicPlayerStore {
	private audio: HTMLAudioElement | null = null;
	private state: MusicPlayerState;
	private isInitialized = false;
	private isInitializing = false;
	private listeners = new Set<(state: MusicPlayerState) => void>();

	constructor() {
		this.state = this.createInitialState();
	}

	private createInitialState(): MusicPlayerState {
		return {
			currentSong: { ...DEFAULT_SONG },
			playlist: [],
			currentIndex: 0,
			isPlaying: false,
			isLoading: false,
			currentTime: 0,
			duration: 0,
			volume: 0.7,
			isMuted: false,
			isShuffled: false,
			isRepeating: 0,
			showPlaylist: false,
			errorMessage: "",
			showError: false,
			autoplayFailed: false,
		};
	}

	private createSnapshot(): MusicPlayerState {
		return {
			...this.state,
			currentSong: { ...this.state.currentSong },
			playlist: this.state.playlist.map((s) => ({ ...s })),
		};
	}

	getState(): MusicPlayerState {
		return this.createSnapshot();
	}

	subscribe(listener: (state: MusicPlayerState) => void): () => void {
		this.listeners.add(listener);
		listener(this.createSnapshot());
		return () => this.listeners.delete(listener);
	}

	async initialize(): Promise<void> {
		if (typeof window === "undefined" || this.isInitialized || this.isInitializing) return;
		this.isInitializing = true;
		try {
			if (!musicPlayerConfig.enable) return;
			this.isInitialized = true;

			this.audio = new Audio();
			this.setupAudioListeners();
			this.loadVolumeFromStorage();
			this.registerInteractionHandler();
			this.loadLocalPlaylist();
		} finally {
			this.isInitializing = false;
		}
	}

	private setupAudioListeners(): void {
		if (!this.audio) return;
		this.audio.volume = this.state.volume;
		this.audio.muted = this.state.isMuted;

		this.audio.addEventListener("play", () => {
			this.state.isPlaying = true;
			this.broadcastState();
		});
		this.audio.addEventListener("pause", () => {
			this.state.isPlaying = false;
			this.broadcastState();
		});
		this.audio.addEventListener("timeupdate", () => {
			if (this.audio) {
				this.state.currentTime = this.audio.currentTime;
				this.broadcastState();
			}
		});
		this.audio.addEventListener("ended", () => {
			if (this.state.isRepeating === 1) {
				if (this.audio) {
					this.audio.currentTime = 0;
					this.audio.play().catch(() => {});
				}
			} else {
				this.next(true);
			}
		});
		this.audio.addEventListener("error", (event) => {
			const mediaError = (event.target as HTMLAudioElement)?.error;
			console.error("[MusicPlayer] Audio load failed:", mediaError?.message ?? "unknown error");
			this.state.isLoading = false;
			this.state.errorMessage = "加载失败，跳过下一首";
			this.state.showError = true;
			if (this.state.playlist.length > 1) {
				setTimeout(() => this.next(true), SKIP_ERROR_DELAY);
			}
			setTimeout(() => {
				this.state.showError = false;
				this.broadcastState();
			}, 3000);
			this.broadcastState();
		});
		this.audio.addEventListener("loadeddata", () => {
			this.state.isLoading = false;
			if (this.audio?.duration && this.audio.duration > 1) {
				this.state.duration = Math.floor(this.audio.duration);
				this.state.currentSong = {
					...this.state.currentSong,
					duration: this.state.duration,
				};
			}
			if (this.state.isPlaying) {
				this.audio?.play().catch(() => {
					this.state.autoplayFailed = true;
					this.state.isPlaying = false;
				});
			}
			this.broadcastState();
		});
		this.audio.addEventListener("loadstart", () => {
			this.state.isLoading = true;
			this.broadcastState();
		});
	}

	private loadVolumeFromStorage(): void {
		if (typeof localStorage === "undefined") return;
		const saved = localStorage.getItem(STORAGE_KEY_VOLUME);
		if (saved) {
			const v = parseFloat(saved);
			if (!isNaN(v) && v >= 0 && v <= 1) {
				this.state.volume = v;
				this.state.isMuted = v === 0;
				if (this.audio) {
					this.audio.volume = v;
					this.audio.muted = this.state.isMuted;
				}
			}
		}
	}

	private registerInteractionHandler(): void {
		const handler = () => {
			if (this.state.autoplayFailed && this.audio) {
				this.audio.play().then(() => {
					this.state.autoplayFailed = false;
				}).catch(() => {});
			}
		};
		document.addEventListener("click", handler, { once: true });
		document.addEventListener("keydown", handler, { once: true });
	}

	private loadLocalPlaylist(): void {
		// 从 src/_data/music.json 加载歌单
		const playlist = musicPlaylist as Song[];
		this.state.playlist = [...playlist];
		if (playlist.length > 0) {
			this.loadSong(playlist[0], false);
		}
	}

	private loadSong(song: Song, autoPlay = true): void {
		if (!song) return;
		this.state.currentSong = { ...song };
		this.state.isLoading = !!song.url;
		if (autoPlay) this.state.isPlaying = true;
		if (this.audio) {
			this.audio.src = getAssetPath(song.url);
			this.audio.load();
			if (autoPlay) {
				this.audio.play().catch(() => {
					this.state.autoplayFailed = true;
					this.state.isPlaying = false;
					this.broadcastState();
				});
			}
		}
		this.broadcastState();
	}

	toggle(): void {
		if (!this.audio || !this.state.currentSong.url) return;
		if (this.state.isPlaying) {
			this.audio.pause();
		} else {
			this.audio.play().catch(() => {});
		}
	}

	next(autoPlay = true): void {
		if (this.state.playlist.length <= 1) return;
		let newIndex: number;
		if (this.state.isShuffled) {
			do {
				newIndex = Math.floor(Math.random() * this.state.playlist.length);
			} while (newIndex === this.state.currentIndex && this.state.playlist.length > 1);
		} else {
			newIndex = this.state.currentIndex < this.state.playlist.length - 1
				? this.state.currentIndex + 1 : 0;
		}
		this.state.currentIndex = newIndex;
		this.loadSong(this.state.playlist[newIndex], autoPlay);
	}

	prev(): void {
		if (this.state.playlist.length <= 1) return;
		const newIndex = this.state.currentIndex > 0
			? this.state.currentIndex - 1 : this.state.playlist.length - 1;
		this.state.currentIndex = newIndex;
		this.loadSong(this.state.playlist[newIndex], true);
	}

	playIndex(index: number): void {
		if (index < 0 || index >= this.state.playlist.length) return;
		this.state.currentIndex = index;
		this.loadSong(this.state.playlist[index], true);
	}

	seek(time: number): void {
		if (!this.audio) return;
		if (time >= 0 && time <= this.state.duration) {
			this.audio.currentTime = time;
			this.state.currentTime = time;
			this.broadcastState();
		}
	}

	setVolume(volume: number): void {
		const v = Math.max(0, Math.min(1, volume));
		this.state.volume = v;
		this.state.isMuted = v === 0;
		if (this.audio) {
			this.audio.volume = v;
			this.audio.muted = this.state.isMuted;
		}
		if (typeof localStorage !== "undefined") {
			localStorage.setItem(STORAGE_KEY_VOLUME, String(v));
		}
		this.broadcastState();
	}

	toggleMute(): void {
		this.state.isMuted = !this.state.isMuted;
		if (this.audio) this.audio.muted = this.state.isMuted;
		this.broadcastState();
	}

	toggleShuffle(): void {
		this.state.isShuffled = !this.state.isShuffled;
		if (this.state.isShuffled) this.state.isRepeating = 0;
		this.broadcastState();
	}

	toggleRepeat(): void {
		this.state.isRepeating = ((this.state.isRepeating + 1) % 3) as RepeatMode;
		if (this.state.isRepeating !== 0) this.state.isShuffled = false;
		this.broadcastState();
	}

	toggleMode(): void {
		if (this.state.isShuffled) {
			this.toggleShuffle();
			return;
		}
		if (this.state.isRepeating === 2) {
			this.toggleRepeat();
			this.toggleShuffle();
			return;
		}
		this.toggleRepeat();
	}

	togglePlaylist(): void {
		this.state.showPlaylist = !this.state.showPlaylist;
		this.broadcastState();
	}

	private broadcastState(): void {
		const snapshot = this.createSnapshot();
		for (const listener of this.listeners) {
			listener(snapshot);
		}
		if (typeof window !== "undefined") {
			window.dispatchEvent(new CustomEvent("music-player:state", { detail: snapshot }));
		}
	}

	destroy(): void {
		if (this.audio) {
			this.audio.pause();
			this.audio.src = "";
			this.audio = null;
		}
		this.listeners.clear();
		this.isInitialized = false;
		this.isInitializing = false;
	}
}

export const musicPlayerStore = new MusicPlayerStore();
