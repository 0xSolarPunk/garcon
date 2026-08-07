import type { ChatImage } from '$shared/chat-types';
import type { PendingUserInput } from '$shared/pending-user-input';
import {
	MAX_CHAT_ATTACHMENT_COUNT,
	MAX_CHAT_ATTACHMENT_FILE_BYTES,
	MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
	MAX_CHAT_VIDEO_ATTACHMENT_FILE_BYTES,
	isVideoAttachmentMimeType,
} from '@garcon/common/attachments';
import { mimeTypeForChatAttachment } from '$lib/chat/composer/image-attachment.svelte.js';

export function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function prepareChatImages(files: readonly File[]): Promise<ChatImage[]> {
	assertAttachmentLimits(files);
	const attachments: ChatImage[] = [];
	for (const file of files) attachments.push(await fileToChatImage(file));
	return attachments;
}

function assertAttachmentLimits(files: readonly File[]): void {
	if (files.length > MAX_CHAT_ATTACHMENT_COUNT) {
		throw new Error(`Maximum ${MAX_CHAT_ATTACHMENT_COUNT} files allowed`);
	}
	const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
	if (totalBytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) {
		throw new Error('Total upload too large. Maximum combined size is 25MB.');
	}
	for (const file of files) {
		const mimeType = mimeTypeForChatAttachment(file);
		const maxBytes = isVideoAttachmentMimeType(mimeType)
			? MAX_CHAT_VIDEO_ATTACHMENT_FILE_BYTES
			: MAX_CHAT_ATTACHMENT_FILE_BYTES;
		if (file.size > maxBytes) {
			throw new Error(`File too large. Maximum file size is ${maxBytes / (1024 * 1024)}MB.`);
		}
	}
}

export function pendingUserInput(
	chatId: string,
	content: string,
	images: ChatImage[],
	clientRequestId: string,
	clientMessageId: string,
): PendingUserInput {
	return {
		chatId,
		clientRequestId,
		clientMessageId,
		content,
		createdAt: new Date().toISOString(),
		deliveryStatus: 'submitting',
		...(images.length > 0 ? { images } : {}),
	};
}

async function fileToChatImage(file: File): Promise<ChatImage> {
	const data = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result === 'string') {
				resolve(reader.result);
			} else {
				reject(new Error('Failed to read attachment data URL'));
			}
		};
		reader.onerror = () => reject(reader.error ?? new Error('Failed to read attachment'));
		reader.onabort = () => reject(new Error('Attachment read aborted'));
		reader.readAsDataURL(file);
	});
	return { data, name: file.name, mimeType: mimeTypeForChatAttachment(file) };
}
