import { BrowserWindow } from 'electron';
import { IpcEvents } from '../../common/IpcEvents.enum';
import { ElectronStoreKeys } from '../../common/ElectronStoreKeys.enum';
import { store } from '../../common/deskreen-electron-store';
import {
	PLAYLIST_SYNC_INTERVAL_MS,
	YOUTUBE_DJ_TEST_PLAYLIST_URL,
} from '../../common/youtubeDjDefaults';
import type {
	YouTubeDjPlaylistModeConfig,
	YouTubeDjPlaylistSyncResult,
	YouTubeDjSetPlaylistModeInput,
	YouTubeSearchResult,
} from '../../common/YouTubeKaraokeTypes';
import {
	extractPlaylistId,
	fetchYouTubePlaylistVideos,
} from './youtubePlaylistFetch';
import { getInMemoryYouTubeApiKey } from './youtubeApiKeyConfig';
import { broadcastSyncResult } from './youtubePlaylistBroadcast';

let pollTimer: ReturnType<typeof setInterval> | null = null;
let syncInFlight = false;
let lastAddedCount = 0;

function readStringArray(key: ElectronStoreKeys): string[] {
	const raw = store.get(key);
	if (!raw) {
		return [];
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed.filter((value): value is string => typeof value === 'string');
	} catch {
		return [];
	}
}

function writeStringArray(key: ElectronStoreKeys, values: string[]): void {
	store.set(key, JSON.stringify(values));
}

function getSyncedVideoIds(): string[] {
	return readStringArray(ElectronStoreKeys.YouTubeDjSyncedVideoIds);
}

function setSyncedVideoIds(ids: string[]): void {
	writeStringArray(ElectronStoreKeys.YouTubeDjSyncedVideoIds, ids);
}

function broadcastSyncResult(result: YouTubeDjPlaylistSyncResult): void {
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) {
			win.webContents.send(IpcEvents.YOUTUBE_DJ_PLAYLIST_SYNC_RESULT, result);
		}
	}
}

export function getPlaylistModeConfig(): YouTubeDjPlaylistModeConfig {
	const enabled = store.get(ElectronStoreKeys.YouTubeDjPlaylistModeEnabled) === 'true';
	const playlistId =
		typeof store.get(ElectronStoreKeys.YouTubeDjCentralPlaylistId) === 'string'
			? (store.get(ElectronStoreKeys.YouTubeDjCentralPlaylistId) as string)
			: '';
	const playlistUrl =
		typeof store.get(ElectronStoreKeys.YouTubeDjCentralPlaylistUrl) === 'string'
			? (store.get(ElectronStoreKeys.YouTubeDjCentralPlaylistUrl) as string)
			: '';
	const lastSyncRaw = store.get(ElectronStoreKeys.YouTubeDjPlaylistLastSyncAt);
	const lastSyncAt = lastSyncRaw && Number.isFinite(Number.parseInt(lastSyncRaw, 10))
		? Number.parseInt(lastSyncRaw, 10)
		: null;
	const lastSyncError =
		typeof store.get(ElectronStoreKeys.YouTubeDjPlaylistLastSyncError) === 'string'
			? (store.get(ElectronStoreKeys.YouTubeDjPlaylistLastSyncError) as string)
			: null;

	return {
		enabled,
		playlistId,
		playlistUrl,
		syncedVideoIds: getSyncedVideoIds(),
		lastSyncAt,
		lastSyncError,
		lastAddedCount,
	};
}

function stopPolling(): void {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
}

export function stopPlaylistSyncPolling(): void {
	stopPolling();
}

function startPolling(): void {
	stopPolling();
	pollTimer = setInterval(() => {
		void runPlaylistSync();
	}, PLAYLIST_SYNC_INTERVAL_MS);
}

async function runPlaylistSync(): Promise<YouTubeDjPlaylistSyncResult> {
	const config = getPlaylistModeConfig();
	if (!config.enabled || !config.playlistId) {
		return {
			added: [],
			playlistId: config.playlistId,
			syncedAt: Date.now(),
			error: 'playlist mode disabled',
		};
	}

	if (syncInFlight) {
		return {
			added: [],
			playlistId: config.playlistId,
			syncedAt: Date.now(),
			error: 'sync already in progress',
		};
	}

	syncInFlight = true;
	const syncedAt = Date.now();

	try {
		const input = config.playlistUrl || config.playlistId;
		const { videos, playlistId } = await fetchYouTubePlaylistVideos(
			input,
			getInMemoryYouTubeApiKey(),
		);

		if (playlistId !== config.playlistId) {
			store.set(ElectronStoreKeys.YouTubeDjCentralPlaylistId, playlistId);
		}

		const syncedSet = new Set(getSyncedVideoIds());
		const added: YouTubeSearchResult[] = [];

		for (const video of videos) {
			if (!syncedSet.has(video.videoId)) {
				added.push(video);
			}
			syncedSet.add(video.videoId);
		}

		setSyncedVideoIds([...syncedSet]);
		store.set(ElectronStoreKeys.YouTubeDjPlaylistLastSyncAt, String(syncedAt));
		store.delete(ElectronStoreKeys.YouTubeDjPlaylistLastSyncError as string);
		lastAddedCount = added.length;

		const result: YouTubeDjPlaylistSyncResult = {
			added,
			playlistId,
			syncedAt,
		};
		broadcastSyncResult(result);
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : 'playlist sync failed';
		store.set(ElectronStoreKeys.YouTubeDjPlaylistLastSyncError, message);
		lastAddedCount = 0;
		const result: YouTubeDjPlaylistSyncResult = {
			added: [],
			playlistId: config.playlistId,
			syncedAt,
			error: message,
		};
		broadcastSyncResult(result);
		return result;
	} finally {
		syncInFlight = false;
	}
}

export async function setPlaylistMode(
	input: YouTubeDjSetPlaylistModeInput,
): Promise<YouTubeDjPlaylistModeConfig> {
	const wasEnabled = store.get(ElectronStoreKeys.YouTubeDjPlaylistModeEnabled) === 'true';
	const previousPlaylistId =
		typeof store.get(ElectronStoreKeys.YouTubeDjCentralPlaylistId) === 'string'
			? (store.get(ElectronStoreKeys.YouTubeDjCentralPlaylistId) as string)
			: '';

	if (!input.enabled) {
		store.set(ElectronStoreKeys.YouTubeDjPlaylistModeEnabled, 'false');
		stopPolling();
		return getPlaylistModeConfig();
	}

	const playlistInput =
		typeof input.playlistUrlOrId === 'string' && input.playlistUrlOrId.trim()
			? input.playlistUrlOrId.trim()
			: store.get(ElectronStoreKeys.YouTubeDjCentralPlaylistUrl) ||
				YOUTUBE_DJ_TEST_PLAYLIST_URL;

	const playlistId = extractPlaylistId(String(playlistInput));
	if (!playlistId) {
		throw new Error('Invalid playlist URL or ID');
	}

	const playlistUrl =
		typeof input.playlistUrlOrId === 'string' && input.playlistUrlOrId.includes('http')
			? input.playlistUrlOrId.trim()
			: `https://www.youtube.com/playlist?list=${playlistId}`;

	store.set(ElectronStoreKeys.YouTubeDjPlaylistModeEnabled, 'true');
	store.set(ElectronStoreKeys.YouTubeDjCentralPlaylistId, playlistId);
	store.set(ElectronStoreKeys.YouTubeDjCentralPlaylistUrl, playlistUrl);

	if (playlistId !== previousPlaylistId || !wasEnabled) {
		setSyncedVideoIds([]);
		store.delete(ElectronStoreKeys.YouTubeDjPlaylistLastSyncAt as string);
		store.delete(ElectronStoreKeys.YouTubeDjPlaylistLastSyncError as string);
		lastAddedCount = 0;
	}

	startPolling();
	await runPlaylistSync();
	return getPlaylistModeConfig();
}

export async function syncPlaylistNow(): Promise<YouTubeDjPlaylistSyncResult> {
	return runPlaylistSync();
}

export async function patchPlaylistMode(input: {
	enabled?: boolean;
	playlistUrl?: string;
}): Promise<YouTubeDjPlaylistModeConfig> {
	if (input.enabled === false) {
		return setPlaylistMode({ enabled: false });
	}

	const config = getPlaylistModeConfig();
	const playlistUrlOrId =
		input.playlistUrl?.trim() ||
		config.playlistUrl ||
		config.playlistId ||
		YOUTUBE_DJ_TEST_PLAYLIST_URL;

	if (input.enabled === true || input.playlistUrl) {
		return setPlaylistMode({
			enabled: true,
			playlistUrlOrId,
		});
	}

	return config;
}

export function restorePlaylistSyncIfEnabled(): void {
	const config = getPlaylistModeConfig();
	if (config.enabled && config.playlistId) {
		startPolling();
		void runPlaylistSync();
	}
}
