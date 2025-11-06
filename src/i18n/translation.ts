import { siteConfig } from "../config";
import type I18nKey from "./i18nKey";
import { en } from "./languages/en";
import { es } from "./languages/es";
import { id } from "./languages/id";
import { ja } from "./languages/ja";
import { ko } from "./languages/ko";
import { th } from "./languages/th";
import { tr } from "./languages/tr";
import { vi } from "./languages/vi";
import { zh_CN } from "./languages/zh_CN";
import { zh_TW } from "./languages/zh_TW";

export type Translation = {
	[K in I18nKey]: string;
};

const defaultTranslation = en;

const map: { [key: string]: Translation } = {
	es: es,
	en: en,
	en_us: en,
	en_gb: en,
	en_au: en,
	fr: en,
	de: en,
	ru: en,
	ar: en,
	zh_cn: zh_CN,
	zh_tw: zh_TW,
	zh: zh_CN,
	ja: ja,
	ja_jp: ja,
	ko: ko,
	ko_kr: ko,
	th: th,
	th_th: th,
	vi: vi,
	vi_vn: vi,
	id: id,
	tr: tr,
	tr_tr: tr,
};

const LOCAL_STORAGE_KEY = "site-language";
export const LANGUAGE_CHANGE_EVENT = "site-language-change";

let runtimeLanguage: string = siteConfig.lang || "en";

if (typeof window !== "undefined") {
	try {
		const stored = window.localStorage?.getItem(LOCAL_STORAGE_KEY);
		if (stored) {
			runtimeLanguage = stored;
		}
		const normalized = runtimeLanguage.replace("_", "-");
		window.document.documentElement.setAttribute("lang", normalized);
	} catch {
		// ignore storage errors
	}
}

export function getTranslation(lang: string): Translation {
	return map[lang.toLowerCase()] || defaultTranslation;
}

export function applyTranslationsToDom(
	scope?: Document | Element | null,
): void {
	if (typeof window === "undefined" || typeof document === "undefined") {
		return;
	}
	const target: Document | Element = scope ?? document;
	const translations = getTranslation(runtimeLanguage);
	target.querySelectorAll<HTMLElement>("[data-i18n-key]").forEach((element) => {
		const keyAttr = element.getAttribute("data-i18n-key") as I18nKey | null;
		if (!keyAttr) {
			return;
		}
		const translation = translations[keyAttr];
		if (typeof translation === "undefined") {
			return;
		}
		const attrName = element.getAttribute("data-i18n-attr");
		if (attrName) {
			element.setAttribute(attrName, translation);
		} else {
			element.textContent = translation;
		}
	});
}

export function getCurrentLanguage(): string {
	return runtimeLanguage;
}

export function setCurrentLanguage(lang: string): void {
	runtimeLanguage = lang;
	if (typeof window !== "undefined") {
		try {
			window.localStorage?.setItem(LOCAL_STORAGE_KEY, lang);
		} catch {
			// ignore storage errors
		}
		const normalized = lang.replace("_", "-");
		window.document.documentElement.setAttribute("lang", normalized);
		applyTranslationsToDom();
		window.dispatchEvent(
			new CustomEvent(LANGUAGE_CHANGE_EVENT, { detail: lang }),
		);
	}
}

if (typeof window !== "undefined") {
	const apply = () => applyTranslationsToDom();
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", apply, { once: true });
	} else {
		apply();
	}
}

export function i18n(key: I18nKey): string {
	return getTranslation(runtimeLanguage)[key];
}
