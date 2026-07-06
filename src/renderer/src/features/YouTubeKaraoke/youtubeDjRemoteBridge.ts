import { IpcEvents } from '@common/IpcEvents.enum';
import type {
	YouTubeDjPlaylistSyncResult,
	YouTubeDjRemoteCommandPayload,
	YouTubeKaraokeMode,
	YouTubeSearchResult,
} from '@common/YouTubeKaraokeTypes';
import {
	addNewVideosToQueue,
	clearQueue,
	getKaraokeState,
	getQueueSnapshot,
	markCurrentError,
	moveQueueItemDown,
	moveQueueItemUp,
	playNow,
	reorderQueue,
	removeFromQueue,
	setKaraokeMode,
	skipNext,
	skipPrev,
} from './youtubeKaraokeQueue';
import { scheduleQueueTitleResolution } from './youtubeQueueTitles';

const LOAD_VIDEO_TIMEOUT_MS = 20000;

async function loadVideoById(videoId: string, queueItemId?: string): Promise<void> {
	if (!videoId) {
		return;
	}
	try {
		const result = (await Promise.race([
			window.electron.ipcRenderer.invoke(IpcEvents.YOUTUBE_KARAOKE_LOAD_VIDEO, videoId),
			new Promise<{ ok: false; error: string }>((_, reject) => {
				setTimeout(() => reject(new Error('video load timed out')), LOAD_VIDEO_TIMEOUT_MS);
			}),
		])) as { ok?: boolean; error?: string };
		if (result && result.ok === false) {
			throw new Error(result.error || 'video load failed');
		}
	} catch (error) {
		if (queueItemId) {
			const message = error instanceof Error ? error.message : 'video load failed';
			markCurrentError(message);
		}
		throw error;
	}
}

async function handleRemoteCommand(payload: YouTubeDjRemoteCommandPayload): Promise<unknown> {
	switch (payload.type) {
		case 'getState':
			return getQueueSnapshot();

		case 'playNow': {
			if (!payload.id) {
				throw new Error('queue item id is required');
			}
			const videoId = playNow(payload.id);
			if (videoId) {
				await loadVideoById(videoId, payload.id);
			}
			return getKaraokeState();
		}

		case 'skipNext': {
			const nextVideoId = skipNext();
			if (nextVideoId) {
				const state = getKaraokeState();
				const item = state.queue[state.currentIndex];
				await loadVideoById(nextVideoId, item?.id);
			}
			return getKaraokeState();
		}

		case 'skipPrev': {
			const prevVideoId = skipPrev();
			if (prevVideoId) {
				const state = getKaraokeState();
				const item = state.queue[state.currentIndex];
				await loadVideoById(prevVideoId, item?.id);
			}
			return getKaraokeState();
		}

		case 'clearQueue':
			clearQueue();
			return getKaraokeState();

		case 'removeFromQueue': {
			if (!payload.id) {
				throw new Error('queue item id is required');
			}
			removeFromQueue(payload.id);
			return getKaraokeState();
		}

		case 'moveQueueItemUp': {
			if (!payload.id) {
				throw new Error('queue item id is required');
			}
			moveQueueItemUp(payload.id);
			return getKaraokeState();
		}

		case 'moveQueueItemDown': {
			if (!payload.id) {
				throw new Error('queue item id is required');
			}
			moveQueueItemDown(payload.id);
			return getKaraokeState();
		}

		case 'reorderQueue': {
			const fromIndex = payload.fromIndex;
			const toIndex = payload.toIndex;
			if (
				typeof fromIndex !== 'number' ||
				typeof toIndex !== 'number' ||
				!Number.isInteger(fromIndex) ||
				!Number.isInteger(toIndex)
			) {
				throw new Error('fromIndex and toIndex are required');
			}
			reorderQueue(fromIndex, toIndex);
			return getKaraokeState();
		}

		case 'setMode': {
			const mode = payload.mode as YouTubeKaraokeMode | undefined;
			if (mode !== 'queue' && mode !== 'hotswap' && mode !== 'manual') {
				throw new Error('invalid karaoke mode');
			}
			setKaraokeMode(mode);
			return getKaraokeState();
		}

		case 'addVideos': {
			const videos = (payload.videos ?? []) as YouTubeSearchResult[];
			const source = payload.source ?? 'manual';
			const added = addNewVideosToQueue(videos, source);
			scheduleQueueTitleResolution(videos.map((video) => video.videoId));
			return { state: getKaraokeState(), addedCount: added.length };
		}

		case 'applySyncResult': {
			const result = payload.result as YouTubeDjPlaylistSyncResult | undefined;
			if (result?.added?.length) {
				addNewVideosToQueue(result.added, 'playlist');
				scheduleQueueTitleResolution(result.added.map((video) => video.videoId));
			}
			return getKaraokeState();
		}

		default:
			throw new Error(`unknown remote command: ${payload.type}`);
	}
}

export function initYoutubeDjRemoteBridge(): void {
	window.electron.ipcRenderer.on(
		IpcEvents.YOUTUBE_DJ_REMOTE_COMMAND,
		async (_event, payload: YouTubeDjRemoteCommandPayload) => {
			const requestId = payload?.requestId;
			if (!requestId) {
				return;
			}
			try {
				const result = await handleRemoteCommand(payload);
				window.electron.ipcRenderer.send(IpcEvents.YOUTUBE_DJ_REMOTE_RESPONSE, {
					requestId,
					result,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : 'remote command failed';
				window.electron.ipcRenderer.send(IpcEvents.YOUTUBE_DJ_REMOTE_RESPONSE, {
					requestId,
					error: message,
				});
			}
		},
	);
}
