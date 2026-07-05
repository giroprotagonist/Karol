import { ipcMain, BrowserWindow } from 'electron';
import { IpcEvents } from '../../common/IpcEvents.enum';
import { type YouTubeQueueItem } from '../../common/YouTubeKaraokeTypes';
import type { YouTubeSearchResult } from '../../common/YouTubeKaraokeTypes';
import { signalingServer } from '../../server';
import { getDeskreenGlobal } from './getDeskreenGlobal';
import { store } from '../../common/deskreen-electron-store';
import { ElectronStoreKeys } from '../../common/ElectronStoreKeys.enum';
import { YOUTUBE_DJ_TEST_PLAYLIST_URL } from '../../common/youtubeDjDefaults';
import { fetchYouTubePlaylistVideos } from './youtubePlaylistFetch';
import { autoSelectYouTubeWindowSource, resolveYouTubeCapturerSourceId } from './youtubeCaptureSource';
import {
	openYouTubePlayerWindow,
	closeYouTubePlayerWindow,
	loadYouTubeVideo,
	playYouTubeVideo,
	pauseYouTubeVideo,
	seekYouTubeVideo,
	setYouTubeVolume,
	openYouTubeSignIn,
	focusYouTubePlayerWindow,
	getYouTubePlayerInfo,
	getYouTubePlayerDebugInfo,
} from './youtubeOutputPlayer';

export { autoSelectYouTubeWindowSource } from './youtubeCaptureSource';

let youtubeApiKey = '';

const SEARCH_ENDPOINT = 'https://www.googleapis.com/youtube/v3/search';
const MAX_SEARCH_RESULTS = 12;

function getServerPort(): number {
	return signalingServer.port;
}

export function initYouTubeKaraokeIpc(mainWindow: BrowserWindow): void {
	ipcMain.handle(IpcEvents.YOUTUBE_KARAOKE_OPEN_WINDOW, async () => {
		store.set(ElectronStoreKeys.YouTubeKaraokeActive, 'true');
		openYouTubePlayerWindow(getServerPort());
		await new Promise((resolve) => setTimeout(resolve, 1200));
		const sourceId = await autoSelectYouTubeWindowSource();
		return { ok: true, sourceId };
	});

	ipcMain.handle(IpcEvents.YOUTUBE_DJ_START_SESSION, async () => {
		store.set(ElectronStoreKeys.YouTubeKaraokeActive, 'true');
		openYouTubePlayerWindow(getServerPort());
		await new Promise((resolve) => setTimeout(resolve, 1200));
		const sourceId = await autoSelectYouTubeWindowSource();

		const deskreenGlobal = getDeskreenGlobal();
		const connectedDevices =
			deskreenGlobal.connectedDevicesService.getDevices().length;

		return {
			ok: true,
			sourceId,
			connectedDevices,
		};
	});

	ipcMain.handle(IpcEvents.YOUTUBE_DJ_SWITCH_SOURCE, async () => {
		const sourceId = await autoSelectYouTubeWindowSource();
		return { ok: Boolean(sourceId), sourceId };
	});

	ipcMain.handle(IpcEvents.YOUTUBE_DJ_GET_CAPTURER_SOURCE_ID, async () => {
		const sourceId = await resolveYouTubeCapturerSourceId();
		return { sourceId };
	});

	ipcMain.handle(IpcEvents.YOUTUBE_KARAOKE_CLOSE_WINDOW, () => {
		store.delete(ElectronStoreKeys.YouTubeKaraokeActive as string);
		closeYouTubePlayerWindow();
		return { ok: true };
	});

	ipcMain.handle(IpcEvents.YOUTUBE_KARAOKE_LOAD_VIDEO, async (_, videoId: string) => {
		await loadYouTubeVideo(videoId, getServerPort());
		return { ok: true };
	});

	ipcMain.handle(IpcEvents.YOUTUBE_KARAOKE_QUEUE_VIDEO, (_, item: YouTubeQueueItem) => {
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send(IpcEvents.YOUTUBE_KARAOKE_QUEUE_VIDEO, item);
		}
		return { ok: true };
	});

	ipcMain.handle(IpcEvents.YOUTUBE_KARAOKE_PLAY_NOW, async (_, videoId: string) => {
		await loadYouTubeVideo(videoId, getServerPort());
		return { ok: true };
	});

	ipcMain.handle(
		IpcEvents.YOUTUBE_KARAOKE_IMPORT_PLAYLIST,
		async (_, playlistUrlOrId: string, playFirst?: boolean) => {
			const input =
				typeof playlistUrlOrId === 'string' && playlistUrlOrId.trim()
					? playlistUrlOrId.trim()
					: YOUTUBE_DJ_TEST_PLAYLIST_URL;
			const { videos, playlistId } = await fetchYouTubePlaylistVideos(
				input,
				youtubeApiKey,
			);
			return { ok: videos.length > 0, videos, playlistId, playFirst: Boolean(playFirst) };
		},
	);

	ipcMain.handle(IpcEvents.YOUTUBE_DJ_PLAY, async () => {
		await playYouTubeVideo();
		return { ok: true };
	});

	ipcMain.handle(IpcEvents.YOUTUBE_DJ_PAUSE, async () => {
		await pauseYouTubeVideo();
		return { ok: true };
	});

	ipcMain.handle(IpcEvents.YOUTUBE_DJ_SEEK, async (_, seconds: number) => {
		await seekYouTubeVideo(seconds);
		return { ok: true };
	});

	ipcMain.handle(IpcEvents.YOUTUBE_DJ_SEEK_RELATIVE, async (_, delta: number) => {
		const info = await getYouTubePlayerInfo();
		const base = info?.currentTime ?? 0;
		await seekYouTubeVideo(Math.max(0, base + delta));
		return { ok: true };
	});

	ipcMain.handle(IpcEvents.YOUTUBE_DJ_SET_VOLUME, async (_, level: number) => {
		await setYouTubeVolume(level);
		return { ok: true };
	});

	ipcMain.handle(IpcEvents.YOUTUBE_DJ_SIGN_IN, async () => {
		await openYouTubeSignIn();
		return { ok: true };
	});

	ipcMain.handle(IpcEvents.YOUTUBE_DJ_FOCUS_PLAYER, () => {
		focusYouTubePlayerWindow();
		return { ok: true };
	});

	ipcMain.handle(IpcEvents.YOUTUBE_DJ_DEBUG_PLAYER, async () => {
		const info = await getYouTubePlayerDebugInfo();
		return { ok: Boolean(info), info };
	});

	ipcMain.handle(IpcEvents.YOUTUBE_KARAOKE_SEARCH, async (_, query: string) => {
		if (!youtubeApiKey || !query.trim()) {
			return { results: [] as YouTubeSearchResult[] };
		}
		try {
			const url = new URL(SEARCH_ENDPOINT);
			url.searchParams.set('part', 'snippet');
			url.searchParams.set('maxResults', String(MAX_SEARCH_RESULTS));
			url.searchParams.set('q', query);
			url.searchParams.set('type', 'video');
			url.searchParams.set('key', youtubeApiKey);

			const res = await fetch(url.toString());
			const data = await res.json();

			const results: YouTubeSearchResult[] = (data.items || []).map(
				(item: Record<string, unknown>) => {
					const snippet = item.snippet as Record<string, unknown>;
					const id = item.id as Record<string, string>;
					return {
						videoId: id.videoId || '',
						title: String(snippet.title || ''),
						channelTitle: String(snippet.channelTitle || ''),
						thumbnailUrl: String(
							(snippet.thumbnails as Record<string, Record<string, string>>)
								?.default?.url || '',
						),
						url: `https://www.youtube.com/watch?v=${id.videoId || ''}`,
					};
				},
			);
			return { results };
		} catch (error) {
			console.error('[YT_SEARCH] error', error);
			return { results: [] as YouTubeSearchResult[] };
		}
	});

	ipcMain.handle('youtube-karaoke-set-api-key', (_, key: string) => {
		youtubeApiKey = key;
		return { ok: true };
	});

	ipcMain.handle('youtube-karaoke-restart-with-window', async () => {
		store.set(ElectronStoreKeys.YouTubeKaraokeActive, 'true');
		openYouTubePlayerWindow(getServerPort());
		await new Promise((resolve) => setTimeout(resolve, 1200));
		const sourceId = await autoSelectYouTubeWindowSource();
		return { ok: true, sourceId };
	});
}
