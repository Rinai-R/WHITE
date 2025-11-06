<script lang="ts">
import Icon from "@iconify/svelte";
import { onDestroy, onMount } from "svelte";
import {
	getCurrentLanguage,
	LANGUAGE_CHANGE_EVENT,
	setCurrentLanguage,
} from "@/i18n/translation";

type LanguageOption = {
	code: string;
	name: string;
	label: string;
};

const LANGUAGE_OPTIONS: LanguageOption[] = [
	{ code: "zh_CN", name: "Simplified Chinese", label: "CN" },
	{ code: "zh_TW", name: "Traditional Chinese", label: "TW" },
	{ code: "en", name: "English", label: "EN" },
	{ code: "ja", name: "Japanese", label: "JA" },
	{ code: "ko", name: "Korean", label: "KO" },
	{ code: "th", name: "Thai", label: "TH" },
	{ code: "vi", name: "Vietnamese", label: "VI" },
	{ code: "tr", name: "Turkish", label: "TR" },
	{ code: "es", name: "Spanish", label: "ES" },
	{ code: "id", name: "Indonesian", label: "ID" },
];

let isOpen = false;
let translatePanel: HTMLElement;
let currentLanguage = getCurrentLanguage();

function togglePanel() {
	isOpen = !isOpen;
	translatePanel?.classList.toggle("float-panel-closed", !isOpen);
}

function selectLanguage(code: string) {
	if (code === currentLanguage) {
		isOpen = false;
		translatePanel?.classList.add("float-panel-closed");
		return;
	}

	setCurrentLanguage(code);
	currentLanguage = code;
	isOpen = false;
	translatePanel?.classList.add("float-panel-closed");
}

function handleClickOutside(event: MouseEvent) {
	if (!isOpen || !translatePanel) return;
	const target = event.target as HTMLElement;
	if (
		!translatePanel.contains(target) &&
		!target.closest("#translate-switch")
	) {
		isOpen = false;
		translatePanel.classList.add("float-panel-closed");
	}
}

const handleLanguageChange: EventListener = (event) => {
	const detail = (event as CustomEvent<string>).detail;
	if (typeof detail === "string") {
		currentLanguage = detail;
	}
};

onMount(() => {
	document.addEventListener("click", handleClickOutside);
	currentLanguage = getCurrentLanguage();
	window.addEventListener(LANGUAGE_CHANGE_EVENT, handleLanguageChange);
});

onDestroy(() => {
	document.removeEventListener("click", handleClickOutside);
	window.removeEventListener(LANGUAGE_CHANGE_EVENT, handleLanguageChange);
});
</script>

<div class="relative">
	<button
		aria-label="Language Selection"
		class="btn-plain scale-animation rounded-lg h-11 w-11 active:scale-90"
		id="translate-switch"
		on:click={togglePanel}
	>
		<Icon icon="material-symbols:translate" class="text-[1.25rem] transition" />
	</button>

	<div
		bind:this={translatePanel}
		id="translate-panel"
		class="float-panel-closed absolute top-[3.5rem] right-0 z-50 w-64 rounded-[var(--radius-large)] border border-[var(--line-divider)] bg-[var(--float-panel-bg)] p-4 shadow-lg"
	>
		<div class="mb-3 text-sm font-medium text-[var(--primary)]">
			Select Language
		</div>
		<div class="grid max-h-64 grid-cols-1 gap-2 overflow-y-auto">
			{#each LANGUAGE_OPTIONS as lang}
				<button
					class="btn-plain flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors"
					class:current-theme-btn={currentLanguage === lang.code}
					on:click={() => selectLanguage(lang.code)}
				>
					<span class="language-label">{lang.label}</span>
					<span class="text-sm transition">{lang.name}</span>
				</button>
			{/each}
		</div>
	</div>
</div>

<style>
.float-panel-closed {
	opacity: 0;
	pointer-events: none;
	transform: translateY(-10px);
	transition: all 0.2s ease-out;
}

#translate-panel:not(.float-panel-closed) {
	opacity: 1;
	pointer-events: auto;
	transform: translateY(0);
}

.language-label {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	min-width: 2rem;
	padding-inline: 0.5rem;
	padding-block: 0.25rem;
	border-radius: 9999px;
	font-size: 0.75rem;
	font-weight: 600;
	background-color: var(--btn-regular-bg);
	color: var(--btn-content);
	transition: background-color 0.2s ease, color 0.2s ease;
}

button.current-theme-btn .language-label {
	background-color: var(--btn-plain-bg-hover);
	color: var(--primary);
}

.overflow-y-auto::-webkit-scrollbar {
	width: 4px;
}

.overflow-y-auto::-webkit-scrollbar-track {
	background: transparent;
}

.overflow-y-auto::-webkit-scrollbar-thumb {
	background: var(--scrollbar-bg);
	border-radius: 2px;
}

.overflow-y-auto::-webkit-scrollbar-thumb:hover {
	background: var(--scrollbar-bg-hover);
}
</style>
