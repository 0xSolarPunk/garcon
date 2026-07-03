import { SvelteMap } from 'svelte/reactivity';
import type { ChatViewMessage } from '$shared/chat-view';
import { getChatMessages } from '$lib/api/chats.js';
import { ChatTranscriptCache } from './chat-transcript-cache.svelte';

const PREVIEW_LIMIT = 50;

export interface SplitPanePreviewEntry {
	chatId: string;
	generationId: string | null;
	lastSeq: number;
	messages: ChatViewMessage[];
	isLoading: boolean;
	isStale: boolean;
	error: string | null;
}

export interface SplitPanePreviewCursor {
	chatId: string;
	generationId: string;
	lastSeq: number;
}

function emptyEntry(chatId: string): SplitPanePreviewEntry {
	return {
		chatId,
		generationId: null,
		lastSeq: 0,
		messages: [],
		isLoading: false,
		isStale: false,
		error: null,
	};
}

export class SplitPanePreviewStore {
	#entries = new SvelteMap<string, SplitPanePreviewEntry>();
	#loadEpochs = new Map<string, number>();
	#inFlightLoads = new Map<string, Promise<void>>();
	#transcriptCache: ChatTranscriptCache;

	constructor(transcriptCache = new ChatTranscriptCache({ limit: PREVIEW_LIMIT })) {
		this.#transcriptCache = transcriptCache;
	}

	entry(chatId: string): SplitPanePreviewEntry {
		return this.#entries.get(chatId) ?? emptyEntry(chatId);
	}

	cursor(chatId: string): SplitPanePreviewCursor | null {
		const entry = this.#entries.get(chatId);
		if (!entry?.generationId || entry.lastSeq <= 0) return null;
		return { chatId, generationId: entry.generationId, lastSeq: entry.lastSeq };
	}

	restore(chatId: string): void {
		if (!chatId) return;
		const restored = this.#transcriptCache.get(chatId);
		if (!restored) return;
		const messages = restored.messages.slice(-PREVIEW_LIMIT);
		this.#entries.set(chatId, {
			chatId,
			generationId: restored.generationId,
			lastSeq: restored.lastSeq,
			messages,
			isLoading: false,
			isStale: restored.stale,
			error: null,
		});
	}

	async ensureLoaded(chatId: string): Promise<void> {
		if (!chatId) return;
		const current = this.entry(chatId);
		if (current.messages.length > 0 && !current.isStale) return;
		if (current.isLoading) {
			await this.#inFlightLoads.get(chatId);
			return;
		}
		await this.loadSnapshot(chatId);
	}

	async loadSnapshot(chatId: string): Promise<void> {
		if (!chatId) return;
		const inFlight = this.#inFlightLoads.get(chatId);
		if (inFlight) return inFlight;

		const epoch = (this.#loadEpochs.get(chatId) ?? 0) + 1;
		this.#loadEpochs.set(chatId, epoch);
		this.#entries.set(chatId, { ...this.entry(chatId), isLoading: true, error: null });
		let resolveLoad!: () => void;
		let rejectLoad!: (error: unknown) => void;
		const load = new Promise<void>((resolve, reject) => {
			resolveLoad = resolve;
			rejectLoad = reject;
		});
		this.#inFlightLoads.set(chatId, load);
		void this.#loadSnapshot(chatId, epoch).then(resolveLoad, rejectLoad);
		return load;
	}

	async #loadSnapshot(chatId: string, epoch: number): Promise<void> {
		try {
			const page = await getChatMessages({ chatId, limit: PREVIEW_LIMIT });
			if (this.#loadEpochs.get(chatId) !== epoch) return;
			this.#transcriptCache.replaceFromPage(chatId, page);
			this.restore(chatId);
		} catch (error) {
			if (this.#loadEpochs.get(chatId) !== epoch) return;
			this.#entries.set(chatId, {
				...this.entry(chatId),
				isLoading: false,
				error: error instanceof Error ? error.message : 'Failed to load chat preview',
			});
		} finally {
			if (this.#loadEpochs.get(chatId) === epoch) {
				this.#inFlightLoads.delete(chatId);
			}
		}
	}

	replaceSnapshot(
		chatId: string,
		generationId: string,
		messages: ChatViewMessage[],
		lastSeq: number,
	): void {
		this.#transcriptCache.replace(chatId, generationId, messages, lastSeq);
		this.restore(chatId);
	}

	applyMessages(
		chatId: string,
		generationId: string,
		messages: ChatViewMessage[],
		serverLastSeq?: number,
	): boolean {
		const result = this.#transcriptCache.applyMessages(
			chatId,
			generationId,
			messages,
			serverLastSeq,
		);
		if (result.status !== 'applied') {
			this.markStale(chatId);
			return false;
		}
		this.restore(chatId);
		return true;
	}

	markStale(chatId: string): void {
		if (!chatId) return;
		this.#loadEpochs.set(chatId, (this.#loadEpochs.get(chatId) ?? 0) + 1);
		this.#inFlightLoads.delete(chatId);
		this.#transcriptCache.markStale(chatId);
		this.#entries.set(chatId, { ...this.entry(chatId), isLoading: false, isStale: true });
	}

	remove(chatId: string): void {
		if (!chatId) return;
		this.#entries.delete(chatId);
		this.#transcriptCache.remove(chatId);
		this.#loadEpochs.delete(chatId);
		this.#inFlightLoads.delete(chatId);
	}
}
