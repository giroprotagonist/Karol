import { ipcMain, BrowserWindow } from 'electron';
import { IpcEvents } from '../../common/IpcEvents.enum';
import { type YouTubeQueueItem } from '../../common/YouTubeKaraokeTypes';
import type { YouTubeSearchResult } from '../../common/YouTubeKaraokeTypes';
import { signalingServer } from '../../server';
import { getDeskreenGlobal } from './getDeskreenGlobal';
import { store } from '../../common/deskreen-electron-store';
import { ElectronStoreKeys } from '../../common/ElectronStoreKeys.enum';
import { setPreferredDesktopCapturerSourceId } from './configureScreenCaptureSession';
import { onDeviceConnectedCallback } from '../../server/onDeviceConnectedCallback';
import {
	openYouTubePlayerWindow,
	closeYouTubePlayerWindow,
	loadYouTubeVideo,
	getYouTubeWindowTitle,
} from './youtubeKaraokeWindow';

// YouTube Data API key — set by renderer
let youtubeApiKey = '';

const SEARCH_ENDPOINT = 'https://www.googleapis.com/youtube/v3/search';
const MAX_SEARCH_RESULTS = 12;

function getServerPort(): number {
	return signalingServer.port;
}

async function autoSelectYouTubeWindowSource(): Promise<string | null> {
	const deskreenGlobal = getDeskreenGlobal();
	await deskreenGlobal.desktopCapturerSourcesService.refreshDesktopCapturerSources();
	const ytSource = deskreenGlobal.desktopCapturerSourcesService.getYouTubeWindowSource();
	if (!ytSource) return null;

	const id = ytSource.id;
	setPreferredDesktopCapturerSourceId(id);
	store.set(ElectronStoreKeys.LastDesktopCapturerSourceId, id);

	// Set on waiting-for-connection session (future connections)
	const waitingSession = deskreenGlobal.sharingSessionService.waitingForConnectionSharingSession;
	waitingSession?.setDesktopCapturerSourceID(id);

	// Also set on any already-active sharing session (mid-stream switch)
	const sessions = deskreenGlobal.sharingSessionService.sharingSessions;
	for (const [, session] of sessions) {
		session.setDesktopCapturerSourceID(id);
	}

	console.log('[YT_KARAOKE] auto-selected window source:', id);
	return id;
}

export function initYouTubeKaraokeIpc(mainWindow: BrowserWindow): void {
	ipcMain.handle(IpcEvents.YOUTUBE_KARAOKE_OPEN_WINDOW, async () => {
		store.set(ElectronStoreKeys.YouTubeKaraokeActive, 'true');
		openYouTubePlayerWindow(getServerPort());
		// Give the window time to appear in the desktopCapturer source list
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const sourceId = await autoSelectYouTubeWindowSource();
		return { ok: true, sourceId };
	});

	ipcMain.handle(IpcEvents.YOUTUBE_KARAOKE_CLOSE_WINDOW, () => {
		store.delete(ElectronStoreKeys.YouTubeKaraokeActive as string);
		closeYouTubePlayerWindow();
		return { ok: true };
	});

	ipcMain.handle(
		IpcEvents.YOUTUBE_KARAOKE_LOAD_VIDEO,
		(_, videoId: string) => {
			loadYouTubeVideo(videoId, getServerPort());
			return { ok: true };
		},
	);

	ipcMain.handle(IpcEvents.YOUTUBE_KARAOKE_QUEUE_VIDEO, (_, item: YouTubeQueueItem) => {
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send(IpcEvents.YOUTUBE_KARAOKE_QUEUE_VIDEO, item);
		}
		return { ok: true };
	});

	ipcMain.handle(IpcEvents.YOUTUBE_KARAOKE_PLAY_NOW, async (_, videoId: string) => {
		loadYouTubeVideo(videoId, getServerPort());
		// Also ensure source is selected if the window was closed and reopened
		await new Promise((resolve) => setTimeout(resolve, 500));
		const sourceId = await autoSelectYouTubeWindowSource();
		return { ok: true, sourceId };
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
			url.searchParams.set('videoEmbeddable', 'true');
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

	// Restart sharing with the YouTube window as source.
	// Disconnects all active sessions, resets everything, then reconnects
	// with the YouTube window pre-selected as the source.
	ipcMain.handle('youtube-karaoke-restart-with-window', async () => {
		const deskreenGlobal = getDeskreenGlobal();

		// Disconnect all active devices
		deskreenGlobal.connectedDevicesService.disconnectAllDevices();

		// Destroy all sharing sessions
		const sessions = deskreenGlobal.sharingSessionService.sharingSessions;
		for (const [, session] of sessions) {
			session.disconnectByHostMachineUser();
			session.destroy();
		}
		sessions.clear();

		// Reset the waiting session
		const waitingSession = deskreenGlobal.sharingSessionService.waitingForConnectionSharingSession;
		const oldRoomId = waitingSession?.roomID;
		waitingSession?.denyConnectionForPartner();
		waitingSession?.disconnectByHostMachineUser();
		waitingSession?.destroy();
		deskreenGlobal.sharingSessionService.waitingForConnectionSharingSession = null;
		if (oldRoomId) {
			deskreenGlobal.roomIDService.unmarkRoomIDAsTaken(oldRoomId);
		}

		// Set karaoke mode active
		store.set(ElectronStoreKeys.YouTubeKaraokeActive, 'true');

		// Open the YouTube player window if not already open
		openYouTubePlayerWindow(getServerPort());
		await new Promise((resolve) => setTimeout(resolve, 1500));

		// Auto-select the YouTube window as source
		const sourceId = await autoSelectYouTubeWindowSource();

		// Create a fresh waiting session
		const newWaitingSession =
			await deskreenGlobal.sharingSessionService.createWaitingForConnectionSharingSession();
		if (newWaitingSession) {
			newWaitingSession.setOnDeviceConnectedCallback(onDeviceConnectedCallback);
			if (sourceId) {
				newWaitingSession.setDesktopCapturerSourceID(sourceId);
			}
		}

		return { ok: true, sourceId };
	});
}
