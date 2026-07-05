import { IpcEvents } from '@common/IpcEvents.enum';
import { isPlaceholderQueueTitle } from '@common/youtubeQueueUtils';
import {
	getKaraokeState,
	updateQueueItemMetadata,
} from './youtubeKaraokeQueue';

type ResolvedVideoMetadata = {
	videoId: string;
	title: string;
	thumbnailUrl: string;
};

let pendingVideoIds = new Set<string>();
let resolveTimer: ReturnType<typeof setTimeout> | null = null;

export function getVideoIdsNeedingTitleResolution(): string[] {
	const ids = new Set<string>();
	for (const item of getKaraokeState().queue) {
		if (isPlaceholderQueueTitle(item.title, item.videoId)) {
			ids.add(item.videoId);
		}
	}
	return [...ids];
}

export function scheduleQueueTitleResolution(videoIds: string[]): void {
	for (const videoId of videoIds) {
		if (videoId) {
			pendingVideoIds.add(videoId);
		}
	}
	if (resolveTimer) {
		return;
	}
	resolveTimer = setTimeout(() => {
		resolveTimer = null;
		const ids = [...pendingVideoIds];
		pendingVideoIds = new Set();
		void resolveQueueItemTitles(ids);
	}, 80);
}

export async function resolveQueueItemTitles(videoIds: string[]): Promise<void> {
	const idsToResolve = [
		...new Set(
			videoIds.filter((videoId) => {
				const item = getKaraokeState().queue.find((queueItem) => queueItem.videoId === videoId);
				return item && isPlaceholderQueueTitle(item.title, item.videoId);
			}),
		),
	];
	if (idsToResolve.length === 0) {
		return;
	}

	const result = (await window.electron.ipcRenderer.invoke(
		IpcEvents.YOUTUBE_DJ_RESOLVE_VIDEO_TITLES,
		idsToResolve,
	)) as { videos?: ResolvedVideoMetadata[] };

	for (const video of result?.videos ?? []) {
		if (!video.title?.trim()) {
			continue;
		}
		updateQueueItemMetadata(video.videoId, video.title, video.thumbnailUrl);
	}
}

export async function resolveMissingQueueTitles(): Promise<void> {
	await resolveQueueItemTitles(getVideoIdsNeedingTitleResolution());
}
