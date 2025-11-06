import type {
	DARK_MODE,
	LIGHT_MODE,
	SYSTEM_MODE,
	WALLPAPER_BANNER,
	WALLPAPER_FULLSCREEN,
	WALLPAPER_NONE,
} from "@constants/constants";
import type I18nKey from "@i18n/i18nKey";

export type SiteConfig = {
	title: string;
	subtitle?: string;
	keywords?: string[];
	lang:
		| "en"
		| "zh"
		| "zh_CN"
		| "zh_TW"
		| "ja"
		| "ko"
		| "es"
		| "th"
		| "vi"
		| "tr"
		| "id"
		| "fr"
		| "de"
		| "ru"
		| "ar";
	translate?: {
		enable: boolean;
		service?: string;
		defaultLanguage?: string;
		showSelectTag?: boolean;
		autoDiscriminate?: boolean;
		ignoreClasses?: string[];
		ignoreTags?: string[];
	};
	themeColor: {
		hue: number;
		fixed: boolean;
	};
	defaultTheme: typeof SYSTEM_MODE | typeof LIGHT_MODE | typeof DARK_MODE;
	wallpaper: {
		mode:
			| typeof WALLPAPER_FULLSCREEN
			| typeof WALLPAPER_BANNER
			| typeof WALLPAPER_NONE;
		src:
			| string
			| string[]
			| {
					desktop?: string | string[];
					mobile?: string | string[];
			  };
		position?: "top" | "center" | "bottom";
		carousel?: {
			enable: boolean;
			interval: number;
		};
		imageApi?: {
			enable: boolean;
			url: string;
		};
		banner?: {
			homeText?: {
				enable: boolean;
				title?: string;
				subtitle?: string | string[];
				typewriter?: {
					enable: boolean;
					speed: number;
					deleteSpeed: number;
					pauseTime: number;
				};
			};
			credit?: {
				enable: boolean;
				text: string;
				url?: string;
			};
			navbar?: {
				transparentMode?: "semi" | "full" | "semifull";
			};
		};
		fullscreen?: {
			zIndex?: number;
			opacity?: number;
			blur?: number;
			navbar?: {
				transparentMode?: "semi" | "full" | "semifull";
			};
		};
	};
	toc: {
		enable: boolean;
		depth: 1 | 2 | 3;
	};
	generateOgImages?: boolean;
	favicon: Favicon[];
	showLastModified?: boolean;
};

export type Favicon = {
	src: string;
	theme?: "light" | "dark";
	sizes?: string;
};

export enum LinkPreset {
	Home = 0,
	Archive = 1,
	Notes = 2,
	About = 3,
	Friends = 4,
}

export type NavBarLink = {
	name: string;
	url: string;
	external?: boolean;
	icon?: string;
	i18nKey?: I18nKey;
	children?: NavBarLink[];
};

export type NavBarConfig = {
	links: (NavBarLink | LinkPreset)[];
};

export type ProfileConfig = {
	avatar?: string;
	name: string;
	bio?: string;
	location?: string;
	links: {
		name: string;
		url: string;
		icon: string;
	}[];
};

export type LicenseConfig = {
	enable: boolean;
	name: string;
	url: string;
};

export type LIGHT_DARK_MODE =
	| typeof LIGHT_MODE
	| typeof DARK_MODE
	| typeof SYSTEM_MODE;

export type WALLPAPER_MODE =
	| typeof WALLPAPER_FULLSCREEN
	| typeof WALLPAPER_BANNER
	| typeof WALLPAPER_NONE;

export type BlogPostData = {
	body: string;
	title: string;
	published: Date;
	description: string;
	tags: string[];
	draft?: boolean;
	image?: string;
	category?: string;
	prevTitle?: string;
	prevSlug?: string;
	nextTitle?: string;
	nextSlug?: string;
};

export type ExpressiveCodeConfig = {
	theme: string;
};
