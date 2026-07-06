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

async function loadVideoById(videoId: string): Promise<void> {
	if (!videoId) {
		return;
	}
	await window.electron.ipcRenderer.invoke(IpcEvents.YOUTUBE_KARAOKE_LOAD_VIDEO, videoId);
}

async function handleRemoteCommand(payload: YouTubeDjRemoteCommandPayload): Promise<unknown> {
	switch (payload.type) {
		case 'getState':
			return getKaraokeState();

		case 'playNow': {
			if (!payload.id) {
				throw new Error('queue item id is required');
			}
			const videoId = playNow(payload.id);
			if (videoId) {
				await loadVideoById(videoId);
			}
			return getKaraokeState();
		}

		case 'skipNext': {
			const nextVideoId = skipNext();
			if (nextVideoId) {
				await loadVideoById(nextVideoId);
			}
			return getKaraokeState();
		}

		case 'skipPrev': {
			const prevVideoId = skipPrev();
			if (prevVideoId) {
				await loadVideoById(prevVideoId);
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
				const added = addNewVideosToQueue(result.added, 'playlist');
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
