export interface Song {
	id: number;
	title: string;
	artist: string;
	cover: string;
	url: string;
	duration: number;
}

export type PlayerMode = "local" | "meting";

export type RepeatMode = 0 | 1 | 2;

export interface MusicPlayerConfig {
	enable: boolean;
	mode: PlayerMode;
	playlist?: Song[];
	meting_api?: string;
	id?: string;
	server?: string;
	type?: string;
}
