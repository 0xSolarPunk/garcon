<script lang="ts">
	import type { SplitDirection } from '$lib/stores/split-layout.svelte';

	interface Props {
		direction: SplitDirection;
		ratio: number;
	}

	let { direction, ratio }: Props = $props();
</script>

<div data-testid="split-resizer-stub" data-direction={direction} data-ratio={ratio}></div>
