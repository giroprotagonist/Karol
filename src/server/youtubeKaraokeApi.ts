import Router from 'koa-router';
import type { Context } from 'koa';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type {
	YouTubeSearchResult,
	YouTubeDjNowPlaying,
	YouTubeDjPlaylistModeConfig,
	YouTubeDjStatus,
} from '../common/YouTubeKaraokeTypes';
import {
	openYouTubePlayerWindow,
	getYouTubePlayerInfo,
	playYouTubeVideo,
	pauseYouTubeVideo,
	seekYouTubeVideo,
	setYouTubeVolume,
} from '../main/helpers/youtubeOutputPlayer';
import { autoSelectYouTubeWindowSource, resolveYouTubeCapturerSourceId } from '../main/helpers/youtubeCaptureSource';
import {
	getPlaylistModeConfig,
	patchPlaylistMode,
	setPlaylistMode,
	syncPlaylistNow,
} from '../main/helpers/youtubePlaylistSync';
import { fetchYouTubePlaylistVideos } from '../main/helpers/youtubePlaylistFetch';
import { searchYouTubeVideos } from '../main/helpers/youtubeSearchMain';
import { getInMemoryYouTubeApiKey } from '../main/helpers/youtubeApiKeyConfig';
import {
	getRendererQueueState,
	invokeRendererCommand,
} from '../main/helpers/youtubeDjApiBridge';
import {
	isYouTubeQueueWindowOpen,
	openYouTubeQueueWindow,
} from '../main/helpers/youtubeQueueWindow';
import { signalingServer } from './index';
import { store } from '../common/deskreen-electron-store';
import { ElectronStoreKeys } from '../common/ElectronStoreKeys.enum';
import { getDeskreenGlobal } from '../main/helpers/getDeskreenGlobal';

type QueueRequestBody = {
	url?: string;
	action?: 'queue' | 'play-now';
};

type PlaylistSetRequestBody = {
	playlistUrl?: string;
	enabled?: boolean;
};

type PlaylistPatchRequestBody = {
	playlistUrl?: string;
	enabled?: boolean;
};

type ReorderRequestBody = {
	fromIndex?: number;
	toIndex?: number;
};

type ImportPlaylistRequestBody = {
	playlistUrl?: string;
	playFirst?: boolean;
};

type SearchRequestBody = {
	query?: string;
};

type TransportSeekRequestBody = {
	seconds?: number;
};

type TransportSeekRelativeRequestBody = {
	delta?: number;
};

type TransportVolumeRequestBody = {
	level?: number;
};

function setCors(ctx: Context): void {
	ctx.set('Access-Control-Allow-Origin', '*');
	ctx.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
	ctx.set('Access-Control-Allow-Headers', 'Content-Type');
}

async function getDjStatus(): Promise<YouTubeDjStatus> {
	const deskreenGlobal = getDeskreenGlobal();
	const sourceId = await resolveYouTubeCapturerSourceId();
		return {
		ok: true,
		djActive: store.get(ElectronStoreKeys.YouTubeKaraokeActive) === 'true',
		castConnected: deskreenGlobal.connectedDevicesService.getDevices().length > 0,
		captureReady: Boolean(sourceId),
		port: signalingServer.port,
		hostMode: 'mac',
	};
}

async function handleQueueAction(
	url: string,
	action: 'queue' | 'play-now',
): Promise<{ ok: boolean; videoId?: string; error?: string }> {
	const videoId = extractUrlVideoId(url);
	if (!videoId) {
		return { ok: false, error: 'invalid YouTube URL' };
	}

	const video: YouTubeSearchResult = {
		videoId,
		title: '',
		channelTitle: '',
		thumbnailUrl: '',
		url: url.startsWith('http') ? url : `https://www.youtube.com/watch?v=${videoId}`,
	};

	try {
		if (action === 'play-now') {
			store.set(ElectronStoreKeys.YouTubeKaraokeActive, 'true');
			openYouTubePlayerWindow(signalingServer.port);
			await new Promise((resolve) => setTimeout(resolve, 800));
			await autoSelectYouTubeWindowSource();
		}

		await invokeRendererCommand('addVideos', { videos: [video], source: 'extension' });
		const state = await getRendererQueueState();
		const item = state.queue.find((q) => q.videoId === videoId);
		if (!item) {
			return { ok: false, error: 'failed to add video to queue' };
		}

		if (action === 'play-now') {
			await invokeRendererCommand('playNow', { id: item.id });
		}

		return { ok: true, videoId };
	} catch (err) {
		const message = err instanceof Error ? err.message : `${action} failed`;
		console.error(`[YT_DJ_API] ${action} failed:`, err);
		return { ok: false, error: message };
	}
}

export function registerYouTubeKaraokeApi(router: Router): void {
	const queueHandler = async (ctx: Context) => {
		setCors(ctx);
		const body = (ctx.request as Context['request'] & { body?: QueueRequestBody }).body ?? {};
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
		setCors(ctx);
		const body = (ctx.request as Context['request'] & { body?: QueueRequestBody }).body ?? {};
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
		setCors(ctx);
		ctx.body = { ok: true };
	});

	router.get('/api/youtube-dj/health', async (ctx) => {
		setCors(ctx);
		ctx.body = await getDjStatus();
	});

	router.get('/api/youtube-dj/status', async (ctx: Context) => {
		setCors(ctx);
		ctx.body = await getDjStatus();
	});

	router.get('/api/youtube-dj/now-playing', async (ctx: Context) => {
		setCors(ctx);
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

	router.get('/api/youtube-dj/queue', async (ctx: Context) => {
		setCors(ctx);
		const state = await getRendererQueueState();
		ctx.body = { ok: true, ...state };
	});

	router.get('/api/youtube-dj/queue-window', (ctx: Context) => {
		setCors(ctx);
		ctx.body = { ok: true, open: isYouTubeQueueWindowOpen() };
	});

	router.post('/api/youtube-dj/queue-window/open', (ctx: Context) => {
		setCors(ctx);
		openYouTubeQueueWindow();
		ctx.body = { ok: true, open: isYouTubeQueueWindowOpen() };
	});

	router.get('/api/youtube-dj/playlist', (ctx: Context) => {
		setCors(ctx);
		const config: YouTubeDjPlaylistModeConfig = getPlaylistModeConfig();
		ctx.body = { ok: true, config };
	});

	router.post('/api/youtube-dj/playlist', async (ctx: Context) => {
		setCors(ctx);
		const body = (ctx.request as Context['request'] & { body?: PlaylistSetRequestBody }).body ?? {};
		const playlistUrl = body.playlistUrl?.trim() ?? '';
		const enabled = body.enabled ?? true;

		if (!playlistUrl) {
			ctx.status = 400;
			ctx.body = { error: 'playlistUrl is required' };
			return;
		}

		try {
			const config = await setPlaylistMode({
				enabled,
				playlistUrlOrId: playlistUrl,
			});
			ctx.body = { ok: true, config };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'failed to set playlist';
			ctx.status = 400;
			ctx.body = { ok: false, error: message };
		}
	});

	router.patch('/api/youtube-dj/playlist', async (ctx: Context) => {
		setCors(ctx);
		const body = (ctx.request as Context['request'] & { body?: PlaylistPatchRequestBody }).body ?? {};
		try {
			const config = await patchPlaylistMode(body);
			ctx.body = { ok: true, config };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'failed to update playlist mode';
			ctx.status = 400;
			ctx.body = { ok: false, error: message };
		}
	});

	router.post('/api/youtube-dj/sync', async (ctx: Context) => {
		setCors(ctx);
		const result = await syncPlaylistNow();
		try {
			await invokeRendererCommand('applySyncResult', { result });
		} catch (error) {
			console.error('[YT_DJ_API] failed to apply sync result in renderer:', error);
		}
		ctx.body = { ok: true, result, config: getPlaylistModeConfig() };
	});

	router.post('/api/youtube-dj/queue/clear', async (ctx: Context) => {
		setCors(ctx);
		try {
			const state = await invokeRendererCommand('clearQueue');
			ctx.body = { ok: true, state };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'failed to clear queue';
			ctx.status = 500;
			ctx.body = { ok: false, error: message };
		}
	});

	router.post('/api/youtube-dj/queue/reorder', async (ctx: Context) => {
		setCors(ctx);
		const body = (ctx.request as Context['request'] & { body?: ReorderRequestBody }).body ?? {};
		const fromIndex = body.fromIndex;
		const toIndex = body.toIndex;
		if (typeof fromIndex !== 'number' || typeof toIndex !== 'number') {
			ctx.status = 400;
			ctx.body = { error: 'fromIndex and toIndex are required' };
			return;
		}
		const state = await getRendererQueueState();
		const fromItem = state.queue[fromIndex];
		const toItem = state.queue[toIndex];
		if (!fromItem || !toItem) {
			ctx.status = 400;
			ctx.body = { error: 'invalid queue indices' };
			return;
		}
		try {
			await invokeRendererCommand('reorderQueue', { fromIndex, toIndex });
			ctx.body = { ok: true, state: await getRendererQueueState() };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'failed to reorder queue';
			ctx.status = 500;
			ctx.body = { ok: false, error: message };
		}
	});

	router.post('/api/youtube-dj/queue/:id/play', async (ctx: Context) => {
		setCors(ctx);
		const id = ctx.params.id;
		try {
			const state = await invokeRendererCommand('playNow', { id });
			ctx.body = { ok: true, state };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'failed to play queue item';
			ctx.status = 500;
			ctx.body = { ok: false, error: message };
		}
	});

	router.delete('/api/youtube-dj/queue/:id', async (ctx: Context) => {
		setCors(ctx);
		const id = ctx.params.id;
		try {
			const state = await invokeRendererCommand('removeFromQueue', { id });
			ctx.body = { ok: true, state };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'failed to remove queue item';
			ctx.status = 500;
			ctx.body = { ok: false, error: message };
		}
	});

	router.post('/api/youtube-dj/import-playlist', async (ctx: Context) => {
		setCors(ctx);
		const body = (ctx.request as Context['request'] & { body?: ImportPlaylistRequestBody }).body ?? {};
		const playlistUrl = body.playlistUrl?.trim() ?? '';
		if (!playlistUrl) {
			ctx.status = 400;
			ctx.body = { error: 'playlistUrl is required' };
			return;
		}

		try {
			const { videos } = await fetchYouTubePlaylistVideos(
				playlistUrl,
				getInMemoryYouTubeApiKey(),
			);
			if (videos.length === 0) {
				ctx.status = 400;
				ctx.body = { error: 'no videos found in playlist' };
				return;
			}

			await invokeRendererCommand('addVideos', { videos, source: 'manual' });
			if (body.playFirst) {
				const state = await getRendererQueueState();
				const first = state.queue.find((item) => item.videoId === videos[0].videoId);
				if (first) {
					await invokeRendererCommand('playNow', { id: first.id });
				}
			}
			ctx.body = { ok: true, count: videos.length, state: await getRendererQueueState() };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'failed to import playlist';
			ctx.status = 500;
			ctx.body = { ok: false, error: message };
		}
	});

	router.post('/api/youtube-dj/search', async (ctx: Context) => {
		setCors(ctx);
		const body = (ctx.request as Context['request'] & { body?: SearchRequestBody }).body ?? {};
		const query = body.query?.trim() ?? '';
		if (!query) {
			ctx.status = 400;
			ctx.body = { error: 'query is required' };
			return;
		}
		const results = await searchYouTubeVideos(query);
		ctx.body = { ok: true, results };
	});

	router.post('/api/youtube-dj/transport/play', async (ctx: Context) => {
		setCors(ctx);
		const info = await getYouTubePlayerInfo();
		if (!info?.videoId) {
			const state = await getRendererQueueState();
			const idx = Math.max(0, state.currentIndex ?? 0);
			const item = state.queue[idx] ?? state.queue[0];
			if (item) {
				await invokeRendererCommand('playNow', { id: item.id });
			}
		} else {
			await playYouTubeVideo();
		}
		ctx.body = { ok: true };
	});

	router.post('/api/youtube-dj/transport/pause', async (ctx: Context) => {
		setCors(ctx);
		await pauseYouTubeVideo();
		ctx.body = { ok: true };
	});

	router.post('/api/youtube-dj/transport/seek', async (ctx: Context) => {
		setCors(ctx);
		const body = (ctx.request as Context['request'] & { body?: TransportSeekRequestBody }).body ?? {};
		const seconds = body.seconds ?? 0;
		await seekYouTubeVideo(Math.max(0, seconds));
		ctx.body = { ok: true };
	});

	router.post('/api/youtube-dj/transport/seek-relative', async (ctx: Context) => {
		setCors(ctx);
		const body =
			(ctx.request as Context['request'] & { body?: TransportSeekRelativeRequestBody }).body ?? {};
		const delta = body.delta ?? 0;
		const info = await getYouTubePlayerInfo();
		const base = info?.currentTime ?? 0;
		await seekYouTubeVideo(Math.max(0, base + delta));
		ctx.body = { ok: true };
	});

	router.post('/api/youtube-dj/transport/volume', async (ctx: Context) => {
		setCors(ctx);
		const body = (ctx.request as Context['request'] & { body?: TransportVolumeRequestBody }).body ?? {};
		const level = typeof body.level === 'number' ? body.level : 1;
		await setYouTubeVolume(Math.max(0, Math.min(1, level)));
		ctx.body = { ok: true };
	});

	router.post('/api/youtube-dj/transport/skip-next', async (ctx: Context) => {
		setCors(ctx);
		try {
			const state = await invokeRendererCommand('skipNext');
			ctx.body = { ok: true, state };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'failed to skip next';
			ctx.status = 500;
			ctx.body = { ok: false, error: message };
		}
	});

	router.post('/api/youtube-dj/transport/skip-prev', async (ctx: Context) => {
		setCors(ctx);
		try {
			const state = await invokeRendererCommand('skipPrev');
			ctx.body = { ok: true, state };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'failed to skip previous';
			ctx.status = 500;
			ctx.body = { ok: false, error: message };
		}
	});

	router.post('/api/youtube-dj/mode', async (ctx: Context) => {
		setCors(ctx);
		const body = (ctx.request as Context['request'] & { body?: { mode?: string } }).body ?? {};
		const mode = body.mode;
		if (mode !== 'queue' && mode !== 'hotswap' && mode !== 'manual') {
			ctx.status = 400;
			ctx.body = { error: 'mode must be queue, hotswap, or manual' };
			return;
		}
		try {
			const state = await invokeRendererCommand('setMode', { mode });
			ctx.body = { ok: true, state };
		} catch (error) {
			const message = error instanceof Error ? error.message : 'failed to set mode';
			ctx.status = 500;
			ctx.body = { ok: false, error: message };
		}
	});

	// Audio preview — uses yt-dlp to extract the best-audio direct URL.
	// Returns JSON with the URL; the frontend loads it directly in an <audio> element.
	router.get('/api/youtube-dj/audio-stream', async (ctx: Context) => {
		setCors(ctx);
		const videoId = (ctx.query.videoId as string) || '';
		if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
			ctx.status = 400;
			ctx.body = { error: 'videoId query parameter must be an 11-char YouTube ID' };
			return;
		}
		try {
			const audioUrl = await new Promise<string>((resolve, reject) => {
				execFile(
					'yt-dlp',
					['--format', 'bestaudio', '--no-warnings', '--no-check-certificate',
					 '--get-url', `https://www.youtube.com/watch?v=${videoId}`],
					{ timeout: 20_000 },
					(error, stdout, _stderr) => {
						// yt-dlp may return non-zero even with a valid URL on stdout
						const lines = stdout.trim().split('\n');
						const url = lines[lines.length - 1]?.trim();
						if (url && url.startsWith('http')) {
							resolve(url);
							return;
						}
						reject(new Error(error?.message || 'yt-dlp returned no audio URL'));
					},
				);
			});
			ctx.body = { ok: true, url: audioUrl };
		} catch (error) {
			ctx.status = 500;
			ctx.body = { error: error instanceof Error ? error.message : 'Failed to get audio stream' };
		}
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
