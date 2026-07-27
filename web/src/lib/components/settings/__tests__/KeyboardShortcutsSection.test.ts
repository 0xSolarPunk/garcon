import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it } from 'vitest';
import { LOCAL_STORAGE_KEYS } from '$lib/utils/local-persistence';
import KeyboardShortcutsSectionTestHost from './KeyboardShortcutsSectionTestHost.svelte';

describe('KeyboardShortcutsSection', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('auto-unassigns the previous command and reports the reassignment', async () => {
		render(KeyboardShortcutsSectionTestHost);
		const newChat = screen.getByRole('group', { name: 'New chat' });
		const changeNewChat = within(newChat).getByRole('button', {
			name: 'Change shortcut for New chat',
		});

		await fireEvent.click(changeNewChat);
		await fireEvent.keyDown(changeNewChat, { key: 'd', ctrlKey: true });

		expect(screen.getByRole('status').textContent).toContain(
			'Ctrl+D was removed from Delete selected chat',
		);
		expect(
			within(screen.getByRole('group', { name: 'Delete selected chat' })).getByText('Unassigned'),
		).toBeTruthy();
		expect(
			JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEYS.localSettings) ?? '{}').globalShortcuts,
		).toMatchObject({
			'new-chat': { key: 'd', ctrl: true },
			'delete-chat': null,
		});
	});

	it('removes and resets a system shortcut', async () => {
		render(KeyboardShortcutsSectionTestHost);
		const deleteChat = screen.getByRole('group', { name: 'Delete selected chat' });

		await fireEvent.click(within(deleteChat).getByRole('button', { name: 'Remove' }));
		expect(within(deleteChat).getByText('Unassigned')).toBeTruthy();

		await fireEvent.click(within(deleteChat).getByRole('button', { name: 'Reset' }));
		expect(within(deleteChat).getByText('System default')).toBeTruthy();
		expect(
			within(deleteChat).getByRole('button', {
				name: 'Change shortcut for Delete selected chat',
			}).textContent,
		).toContain('Ctrl');
	});
});
