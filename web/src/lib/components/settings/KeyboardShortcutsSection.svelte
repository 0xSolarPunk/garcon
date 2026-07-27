<script lang="ts">
	import { getLocalSettings } from '$lib/context';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages.js';
	import { GLOBAL_SHORTCUTS, SLASH_COMMANDS } from './keyboard-shortcut-entries.js';
	import {
		assignGlobalShortcut,
		disableGlobalShortcut,
		formatGlobalShortcut,
		getEffectiveGlobalShortcut,
		globalShortcutBindingFromEvent,
		isSafeGlobalShortcutBinding,
		resetGlobalShortcut,
		type GlobalShortcutBinding,
		type GlobalShortcutId,
	} from '$lib/workspace/global-shortcuts.js';

	const ls = getLocalSettings();
	const sendMessageKeys = $derived(ls.sendByShiftEnter ? ['Shift', 'Enter'] : ['Enter']);
	const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
	let recordingId = $state<GlobalShortcutId | null>(null);
	let feedback = $state<string | null>(null);

	function shortcutLabel(id: GlobalShortcutId): string {
		return GLOBAL_SHORTCUTS.find((entry) => entry.id === id)?.label() ?? id;
	}

	function startRecording(id: GlobalShortcutId): void {
		recordingId = id;
		feedback = null;
	}

	function reportAssignment(
		binding: GlobalShortcutBinding,
		unassignedId: GlobalShortcutId | null,
	): void {
		feedback = unassignedId
			? m.settings_shortcut_conflict_reassigned({
					shortcut: formatGlobalShortcut(binding, isMac).join('+'),
					command: shortcutLabel(unassignedId),
				})
			: null;
	}

	function handleBindingKeydown(event: KeyboardEvent, id: GlobalShortcutId): void {
		if (recordingId !== id) return;
		event.preventDefault();
		event.stopPropagation();
		if (event.key === 'Escape') {
			recordingId = null;
			return;
		}

		const binding = globalShortcutBindingFromEvent(event);
		if (!binding) return;
		if (!isSafeGlobalShortcutBinding(binding)) {
			feedback = m.settings_shortcut_modifier_required();
			return;
		}

		const result = assignGlobalShortcut(ls.globalShortcuts, id, binding);
		ls.set('globalShortcuts', result.overrides);
		recordingId = null;
		reportAssignment(binding, result.unassignedId);
	}

	function removeShortcut(id: GlobalShortcutId): void {
		ls.set('globalShortcuts', disableGlobalShortcut(ls.globalShortcuts, id));
		recordingId = null;
		feedback = null;
	}

	function resetShortcut(id: GlobalShortcutId): void {
		const result = resetGlobalShortcut(ls.globalShortcuts, id);
		ls.set('globalShortcuts', result.overrides);
		recordingId = null;
		const binding = getEffectiveGlobalShortcut(id, result.overrides);
		if (binding) reportAssignment(binding, result.unassignedId);
	}
</script>

{#snippet keyCombo(keys: string[])}
	<span class="flex items-center gap-1">
		{#each keys as key, index (index)}
			{#if index > 0}
				<span class="text-xs text-muted-foreground">+</span>
			{/if}
			<kbd
				class="px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground bg-muted rounded border border-border"
			>
				{key}
			</kbd>
		{/each}
	</span>
{/snippet}

{#snippet shortcutRow(label: string, keys: string[])}
	<div class="flex items-center justify-between gap-4 py-2">
		<div class="text-sm font-medium text-foreground">{label}</div>
		{@render keyCombo(keys)}
	</div>
{/snippet}

<div class="space-y-6">
	<section class="space-y-2">
		<h3 class="text-sm font-semibold text-foreground">
			{m.settings_shortcuts_group_global()}
		</h3>
		<p class="text-xs text-muted-foreground">{m.settings_shortcuts_edit_hint()}</p>
		{#if feedback}
			<div
				class="rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground"
				role="status"
			>
				{feedback}
			</div>
		{/if}
		<div class="divide-y divide-border rounded-lg border border-border bg-muted/50">
			{#each GLOBAL_SHORTCUTS as entry (entry.id)}
				{@const binding = getEffectiveGlobalShortcut(entry.id, ls.globalShortcuts)}
				{@const hasOverride = Object.hasOwn(ls.globalShortcuts, entry.id)}
				<div
					class="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
					role="group"
					aria-label={entry.label()}
				>
					<div class="min-w-0">
						<div class="text-sm font-medium text-foreground">{entry.label()}</div>
						<div class="mt-0.5 text-xs text-muted-foreground">
							{#if binding === null}
								{m.settings_shortcut_disabled()}
							{:else if hasOverride}
								{m.settings_shortcut_custom()}
							{:else}
								{m.settings_shortcut_system_default()}
							{/if}
						</div>
					</div>
					<div class="flex flex-wrap items-center gap-2">
						<Button
							variant={recordingId === entry.id ? 'default' : 'outline'}
							size="sm"
							class="min-w-28 font-mono"
							onclick={() => startRecording(entry.id)}
							onkeydown={(event) => handleBindingKeydown(event, entry.id)}
							aria-label={m.settings_shortcut_change_aria({ command: entry.label() })}
						>
							{#if recordingId === entry.id}
								{m.settings_shortcut_press_keys()}
							{:else if binding}
								{@render keyCombo(formatGlobalShortcut(binding, isMac))}
							{:else}
								{m.settings_shortcut_unassigned()}
							{/if}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							disabled={binding === null}
							onclick={() => removeShortcut(entry.id)}
						>
							{m.settings_shortcut_remove()}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							disabled={!hasOverride}
							onclick={() => resetShortcut(entry.id)}
						>
							{m.settings_shortcut_reset()}
						</Button>
					</div>
				</div>
			{/each}
		</div>
	</section>

	<section class="space-y-2">
		<h3 class="text-sm font-semibold text-foreground">
			{m.settings_shortcuts_group_composer()}
		</h3>
		<div class="bg-muted/50 border border-border rounded-lg px-4 py-1">
			{@render shortcutRow(m.settings_shortcut_send_message(), sendMessageKeys)}
		</div>
	</section>

	<section class="space-y-2">
		<h3 class="text-sm font-semibold text-foreground">
			{m.settings_shortcuts_group_slash_commands()}
		</h3>
		<div class="bg-muted/50 border border-border rounded-lg px-4 py-1">
			{#each SLASH_COMMANDS as entry (entry.command)}
				<div
					class="flex flex-col items-start gap-1.5 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
				>
					<div class="text-sm text-muted-foreground">{entry.description()}</div>
					<code
						class="max-w-full whitespace-nowrap px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground bg-muted rounded border border-border"
					>
						{entry.command}
					</code>
				</div>
			{/each}
		</div>
	</section>
</div>
