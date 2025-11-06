import I18nKey from "@i18n/i18nKey";
import { i18n } from "@i18n/translation";
import { LinkPreset, type NavBarLink } from "@/types/config";

export const LinkPresets: { [key in LinkPreset]: NavBarLink } = {
	[LinkPreset.Home]: {
		name: i18n(I18nKey.home),
		url: "/",
		i18nKey: I18nKey.home,
	},
	[LinkPreset.Archive]: {
		name: i18n(I18nKey.archive),
		url: "/archive/",
		i18nKey: I18nKey.archive,
	},
	[LinkPreset.Notes]: {
		name: i18n(I18nKey.notes),
		url: "/notes/",
		i18nKey: I18nKey.notes,
	},
	[LinkPreset.About]: {
		name: i18n(I18nKey.about),
		url: "/about/",
		i18nKey: I18nKey.about,
	},
	[LinkPreset.Friends]: {
		name: i18n(I18nKey.friends),
		url: "/friends/",
		i18nKey: I18nKey.friends,
	},
};
