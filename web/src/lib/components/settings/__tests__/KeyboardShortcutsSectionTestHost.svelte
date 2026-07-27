<script lang="ts">
	import { onDestroy } from 'svelte';
	import { setLocalSettings } from '$lib/context';
	import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte';
	import KeyboardShortcutsSection from '../KeyboardShortcutsSection.svelte';

	const localSettings = createLocalSettingsStore();
	setLocalSettings(localSettings);
	onDestroy(() => localSettings.destroy());
</script>

<KeyboardShortcutsSection />
