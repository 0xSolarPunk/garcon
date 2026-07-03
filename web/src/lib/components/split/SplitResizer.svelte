<script lang="ts">
	import { cn } from '$lib/utils/cn';
	import type { SplitDirection } from '$lib/stores/split-layout.svelte';
	import * as m from '$lib/paraglide/messages.js';

	interface SplitResizerProps {
		direction: SplitDirection;
		ratio: number;
		onResizeStart: () => void;
		onResize: (delta: number) => void;
		onReset: () => void;
	}

	let { direction, ratio, onResizeStart, onResize, onReset }: SplitResizerProps = $props();

	let isDragging = $state(false);

	const isHorizontal = $derived(direction === 'horizontal');
	const ratioPercent = $derived(Math.round(Math.min(0.85, Math.max(0.15, ratio)) * 100));

	function handlePointerDown(e: PointerEvent) {
		e.preventDefault();
		e.stopPropagation();
		isDragging = true;
		onResizeStart();
		const startPos = isHorizontal ? e.clientX : e.clientY;
		const target = e.currentTarget as HTMLElement;
		target.setPointerCapture?.(e.pointerId);

		// Prevent text selection during drag.
		document.body.style.userSelect = 'none';
		document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';

		function handlePointerMove(ev: PointerEvent) {
			ev.preventDefault();
			const currentPos = isHorizontal ? ev.clientX : ev.clientY;
			onResize(currentPos - startPos);
		}

		function handlePointerUp(ev: PointerEvent) {
			isDragging = false;
			document.body.style.userSelect = '';
			document.body.style.cursor = '';
			document.removeEventListener('pointermove', handlePointerMove);
			document.removeEventListener('pointerup', handlePointerUp);
			document.removeEventListener('pointercancel', handlePointerUp);
			if (target.hasPointerCapture?.(ev.pointerId)) {
				target.releasePointerCapture(ev.pointerId);
			}
		}

		document.addEventListener('pointermove', handlePointerMove);
		document.addEventListener('pointerup', handlePointerUp);
		document.addEventListener('pointercancel', handlePointerUp);
	}

	// Each key press is an independent start+move pair so held keys
	// re-measure the container between steps.
	function handleKeyDown(e: KeyboardEvent) {
		const decreaseKey = isHorizontal ? 'ArrowLeft' : 'ArrowUp';
		const increaseKey = isHorizontal ? 'ArrowRight' : 'ArrowDown';
		if (e.key !== decreaseKey && e.key !== increaseKey) return;
		e.preventDefault();
		onResizeStart();
		onResize(e.key === increaseKey ? 24 : -24);
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -- WAI-ARIA window splitter: a focusable separator resized via arrow keys -->
<div
	class={cn(
		'relative flex-shrink-0 group select-none touch-none z-10',
		isHorizontal ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize',
	)}
	onpointerdown={handlePointerDown}
	ondblclick={onReset}
	onkeydown={handleKeyDown}
	role="separator"
	aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
	aria-label={m.layout_resize_panes()}
	aria-valuemin="15"
	aria-valuemax="85"
	aria-valuenow={ratioPercent}
	tabindex="0"
>
	<!-- Wide invisible hit area for easy grabbing -->
	<div
		class={cn('absolute z-10', isHorizontal ? 'inset-y-0 -left-5 w-11' : 'inset-x-0 -top-5 h-11')}
	></div>
	<!-- Track background -->
	<div
		class={cn(
			'absolute rounded-full transition-all duration-150',
			isHorizontal ? 'inset-y-0 left-0 right-0' : 'inset-x-0 top-0 bottom-0',
			isDragging ? 'bg-primary/30' : 'bg-transparent group-hover:bg-primary/10',
		)}
	></div>
	<!-- Center grip dots (visible on hover/drag) -->
	<div
		class={cn(
			'absolute transition-opacity duration-150 flex items-center justify-center',
			isHorizontal ? 'inset-y-0 left-0 right-0' : 'inset-x-0 top-0 bottom-0',
			isDragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
		)}
	>
		<div class={cn('flex gap-0.5', isHorizontal ? 'flex-col' : 'flex-row')}>
			{#each [0, 1, 2] as _}
				<div class="w-0.5 h-0.5 rounded-full bg-primary/50"></div>
			{/each}
		</div>
	</div>
</div>
