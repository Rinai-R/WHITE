<script lang="ts">
import Icon from "@iconify/svelte";
import I18nKey from "../../../../i18n/i18nKey";
import { i18n } from "../../../../i18n/translation";

interface Props {
	onclick: () => void;
	disabled?: boolean;
}

const { onclick, disabled = false }: Props = $props();
</script>

<button class="btn-plain w-9 h-9 rounded-lg" aria-label={i18n(I18nKey.musicBoxNext)} {onclick} {disabled}>
	<Icon icon="material-symbols:skip-next" class="text-xl" />
</button>
