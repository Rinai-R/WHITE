import type {
	ExpressiveCodeConfig,
	LicenseConfig,
	NavBarConfig,
	ProfileConfig,
	SiteConfig,
} from "./types/config";
import { LinkPreset } from "./types/config";

export const siteConfig: SiteConfig = {
	title: "Rinai 的私人花园",
	subtitle: "博客",
	keywords: ["Rinai", "博客", "技术", "生活"],
	lang: "zh_CN",
	translate: {
		enable: true,
		service: "client.edge",
		defaultLanguage: "zh-CN",
		autoDiscriminate: true,
		ignoreClasses: ["ignore"],
		ignoreTags: ["script", "style", "code", "pre"],
	},
	themeColor: {
		hue: 250,
		fixed: false,
	},
	defaultTheme: "system",
	wallpaper: {
		mode: "banner",
		src: {
			desktop: ["assets/images/mono1.png"],
			mobile: ["assets/images/mono1.png"],
		},
		position: "center",
		carousel: {
			enable: false,
			interval: 6,
		},
		banner: {
			homeText: {
				enable: true,
				title: "Rinai 的私人花园",
				subtitle: ["记录日常", "分享创造"],
				typewriter: {
					enable: true,
					speed: 110,
					deleteSpeed: 55,
					pauseTime: 2400,
				},
			},
			credit: {
				enable: false,
				text: "",
				url: "https://blog.g-rinai.cn/",
			},
			navbar: {
				transparentMode: "semifull",
			},
		},
		fullscreen: {
			zIndex: -1,
			opacity: 0.85,
			blur: 1.5,
			navbar: {
				transparentMode: "semi",
			},
		},
	},
	toc: {
		enable: true,
		depth: 2,
	},
	generateOgImages: false,
	favicon: [
		{
			src: "/favicon/favicon.png",
		},
	],
	showLastModified: true,
};

export const navBarConfig: NavBarConfig = {
	links: [
		LinkPreset.Home,
		LinkPreset.Notes,
		LinkPreset.Archive,
		LinkPreset.About,
		LinkPreset.Friends,
		{
			name: "GitHub",
			url: "https://github.com/Rinai-R",
			external: true,
		},
	],
};

export const profileConfig: ProfileConfig = {
	avatar: "assets/images/avatar1.png",
	name: "Rinai",
	bio: "只是一个计算机爱好者",
	links: [
		{
			name: "GitHub",
			icon: "fa6-brands:github",
			url: "https://github.com/Rinai-R",
		},
		{
			name: "Mail",
			icon: "material-symbols:alternate-email",
			url: "mailto:whrinai@outlook.com",
		},
	],
};

export const licenseConfig: LicenseConfig = {
	enable: true,
	name: "CC BY-NC-SA 4.0",
	url: "https://creativecommons.org/licenses/by-nc-sa/4.0/",
};

export const expressiveCodeConfig: ExpressiveCodeConfig = {
	theme: "github-dark",
};
