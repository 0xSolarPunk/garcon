<script lang="ts">
	import { untrack, type ComponentProps } from 'svelte';
	import { setExecutors, setTransientLayers } from '$lib/context';
	import type { ExecutorsStore } from '$lib/executors/executors-store.svelte';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte';
	import DirectoryBrowser from '$lib/components/project-paths/DirectoryBrowser.svelte';
	import { setExecutorsTestContext } from '$lib/executors/__tests__/executors-test-context';
	import { localExecutor, remoteExecutor } from '$lib/executors/__tests__/fixtures';
	let {
		executors,
		localDirectoryCreation = true,
		...props
	}: ComponentProps<typeof DirectoryBrowser> & {
		executors?: ExecutorsStore;
		localDirectoryCreation?: boolean;
	} = $props();
	const providedExecutors = untrack(() => executors);
	if (providedExecutors) {
		setExecutors(providedExecutors);
	} else {
		setExecutorsTestContext([
			{
				...localExecutor,
				machineServices: {
					...localExecutor.machineServices,
					directoryCreation: untrack(() => localDirectoryCreation),
				},
			},
			{ ...remoteExecutor, machineServices: { ...localExecutor.machineServices } },
		]);
	}
	const executorId = $derived(props.executorId);
	const executorContextKey = $derived(props.executorContextKey);
	setTransientLayers(new TransientLayerRegistry(new WorkspaceInteractionGate()));
</script>

<DirectoryBrowser {...props} {executorId} {executorContextKey} />
