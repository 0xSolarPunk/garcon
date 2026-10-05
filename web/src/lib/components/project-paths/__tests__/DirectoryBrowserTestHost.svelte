<script lang="ts">
	import { untrack, type ComponentProps } from 'svelte';
	import { setExecutors, setTransientLayers } from '$lib/context';
	import { ExecutorsStore } from '$lib/executors/executors-store.svelte';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';
	import DirectoryBrowser from '$lib/components/project-paths/DirectoryBrowser.svelte';
	let { executors = new ExecutorsStore(), ...props }: ComponentProps<typeof DirectoryBrowser> & { executors?: ExecutorsStore } = $props();
	setExecutors(untrack(() => executors));
	const executorId = $derived(props.executorId);
	const executorContextKey = $derived(props.executorContextKey);
	setTransientLayers(new TransientLayerRegistry(new WorkspaceInteractionGate()));
</script>

<DirectoryBrowser {...props} {executorId} {executorContextKey} />
