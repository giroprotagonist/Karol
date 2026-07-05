import Router from 'koa-router';
import type { Context } from 'koa';
import { BrowserWindow } from 'electron';
import { IpcEvents } from '../common/IpcEvents.enum';
import type { YouTubeQueueItem, YouTubeDjNowPlaying } from '../common/YouTubeKaraokeTypes';
import {
	openYouTubePlayerWindow,
	loadYouTubeVideo,
	getYouTubePlayerInfo,
} from '../main/helpers/youtubeOutputPlayer';
import { autoSelectYouTubeWindowSource } from '../main/helpers/youtubeCaptureSource';
import { signalingServer } from './index';
import { store } from '../common/deskreen-electron-store';
import { ElectronStoreKeys } from '../common/ElectronStoreKeys.enum';

type QueueRequestBody = {
	url?: string;
	action?: 'queue' | 'play-now';
};

async function handleQueueAction(
	url: string,
	action: 'queue' | 'play-now',
): Promise<{ ok: boolean; videoId?: string; error?: string }> {
	const videoId = extractUrlVideoId(url);
	if (!videoId) {
		return { ok: false, error: 'invalid YouTube URL' };
	}

	const item: YouTubeQueueItem = {
		id: `ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		url,
		videoId,
		title: `YouTube: ${videoId}`,
		thumbnail: '',
		status: 'queued',
	};

	if (action === 'play-now') {
		try {
			store.set(ElectronStoreKeys.YouTubeKaraokeActive, 'true');
			openYouTubePlayerWindow(signalingServer.port);
			await new Promise((resolve) => setTimeout(resolve, 800));
			await autoSelectYouTubeWindowSource();
			await loadYouTubeVideo(videoId, signalingServer.port);
		} catch (err) {
			console.error('[YT_DJ_API] failed to setup play-now:', err);
		}
	}

	const windows = BrowserWindow.getAllWindows();
	for (const win of windows) {
		if (!win.isDestroyed()) {
			win.webContents.send(IpcEvents.YOUTUBE_KARAOKE_QUEUE_VIDEO, item);
			if (action === 'play-now') {
				win.webContents.send('youtube-karaoke-play-now-from-api', videoId);
			}
		}
	}

	return { ok: true, videoId };
}

export function registerYouTubeKaraokeApi(router: Router): void {
	const queueHandler = async (ctx: Context) => {
		const body = (ctx.request as Context['request'] & { body?: QueueRequestBody })
			.body ?? {};
		const url = body.url || '';
		const action = body.action || 'queue';

		if (!url) {
			ctx.status = 400;
			ctx.body = { error: 'url is required' };
			return;
		}

		const result = await handleQueueAction(url, action);
		if (!result.ok) {
			ctx.status = 400;
			ctx.body = { error: result.error };
			return;
		}

		ctx.body = { ok: true, videoId: result.videoId, action };
	};

	router.post('/api/youtube-karaoke/queue', queueHandler);
	router.post('/api/youtube-dj/queue', queueHandler);

	router.post('/api/youtube-dj/play-now', async (ctx: Context) => {
		const body = (ctx.request as Context['request'] & { body?: QueueRequestBody })
			.body ?? {};
		const url = body.url || '';
		if (!url) {
			ctx.status = 400;
			ctx.body = { error: 'url is required' };
			return;
		}
		const result = await handleQueueAction(url, 'play-now');
		ctx.body = result;
	});

	router.get('/api/youtube-karaoke/health', (ctx) => {
		ctx.body = { ok: true };
	});

	router.get('/api/youtube-dj/health', (ctx) => {
		ctx.body = { ok: true };
	});

	router.get('/api/youtube-dj/now-playing', async (ctx) => {
		const info = await getYouTubePlayerInfo();
		const payload: YouTubeDjNowPlaying = {
			title: info?.title || '',
			videoId: info?.videoId || '',
			currentTime: info?.currentTime || 0,
			duration: info?.duration || 0,
			state: info?.state ?? -2,
		};
		ctx.body = payload;
	});
}

function extractUrlVideoId(url: string): string | null {
	try {
		const u = new URL(url);
		if (u.hostname.includes('youtube.com')) {
			return u.searchParams.get('v') || null;
		}
		if (u.hostname.includes('youtu.be')) {
			return u.pathname.slice(1).split('/')[0] || null;
		}
	} catch {
		// invalid URL
	}
	if (/^[a-zA-Z0-9_-]{11}$/.test(url.trim())) {
		return url.trim();
	}
	return null;
}
