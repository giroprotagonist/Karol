import type {
	YouTubeDjNowPlaying,
	YouTubeDjPlaylistEntry,
	YouTubeDjPlaylistModeConfig,
	YouTubeDjPlaylistSyncResult,
	YouTubeDjStatus,
	YouTubeKaraokeMode,
	YouTubeKaraokeState,
	YouTubeSearchResult,
} from '@common/YouTubeKaraokeTypes';
import type {
	HardwareMixerState,
	LibraryState,
	LibraryTrack,
	VlcNowPlaying,
	VlcPlaylistState,
	VlcStatus,
} from '@common/VlcControllerTypes';

const HOST_KEY = 'deskreen_dj_host';

/** When loaded from Deskreen's bundled /dj-controller/ page, use the page origin. */
export function getDefaultHost(): string {
	if (typeof window !== 'undefined' && window.location.pathname.includes('dj-controller')) {
		const origin = window.location.origin.replace(/\/+$/, '');
		const saved = normalizeHost(getSavedHost());
		if (saved && hostsMatch(saved, origin)) {
			return saved;
		}
		return origin;
	}
	const saved = normalizeHost(getSavedHost());
	return saved;
}

function hostsMatch(a: string, b: string): boolean {
	try {
		const urlA = new URL(a.startsWith('http') ? a : `http://${a}`);
		const urlB = new URL(b.startsWith('http') ? b : `http://${b}`);
		return urlA.host === urlB.host;
	} catch {
		return false;
	}
}

export function getSavedHost(): string {
	try {
		return localStorage.getItem(HOST_KEY) || '';
	} catch {
		return '';
	}
}

export function saveHost(host: string): void {
	try {
		localStorage.setItem(HOST_KEY, host.trim());
	} catch {
		// ignore
	}
}

function normalizeHost(host: string): string {
	const trimmed = host.trim().replace(/\/+$/, '');
	if (!trimmed) {
		return '';
	}
	if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
		return trimmed;
	}
	return `http://${trimmed}`;
}

function apiBase(host: string): string {
	return `${normalizeHost(host)}/api/youtube-dj`;
}

function vlcApiBase(host: string): string {
	return `${normalizeHost(host)}/api/vlc-dj`;
}

const FETCH_TIMEOUT_MS = 12000;
const PLAYLIST_LOAD_TIMEOUT_MS = 180_000;

async function request<T>(
	host: string,
	path: string,
	init?: RequestInit,
	timeoutMs: number = FETCH_TIMEOUT_MS,
	useVlc?: boolean,
): Promise<T> {
	const base = useVlc ? vlcApiBase(host) : apiBase(host);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${base}${path}`, {
			...init,
			signal: controller.signal,
			headers: {
				'Content-Type': 'application/json',
				'X-Karol-Client': 'KarolController/1.0',
				...(init?.headers ?? {}),
			},
		});
		const data = (await res.json()) as T & { error?: string };
		if (!res.ok) {
			throw new Error(data.error || `Request failed (${res.status})`);
		}
		return data;
		} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			throw new Error('Request timed out — is the DJ host running?');
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

export type QueueSortMode =
	| 'custom'
	| 'playlist-order'
	| 'date-added-newest'
	| 'date-added-oldest'
	| 'published-newest'
	| 'published-oldest'
	| 'popular'
	| 'duration-longest'
	| 'duration-shortest'
	| 'title-asc'
	| 'title-desc';

export const QUEUE_SORT_OPTIONS: { value: QueueSortMode; label: string }[] = [
	{ value: 'custom', label: 'Custom order' },
	{ value: 'playlist-order', label: 'Playlist order' },
	{ value: 'date-added-newest', label: 'Date added (newest)' },
	{ value: 'date-added-oldest', label: 'Date added (oldest)' },
	{ value: 'published-newest', label: 'Date published (newest)' },
	{ value: 'published-oldest', label: 'Date published (oldest)' },
	{ value: 'popular', label: 'Most popular' },
	{ value: 'duration-longest', label: 'Duration (longest)' },
	{ value: 'duration-shortest', label: 'Duration (shortest)' },
	{ value: 'title-asc', label: 'Title (A–Z)' },
	{ value: 'title-desc', label: 'Title (Z–A)' },
];

export async function fetchStatus(host: string): Promise<YouTubeDjStatus> {
	return request<YouTubeDjStatus>(host, '/status');
}

export async function fetchNowPlaying(host: string): Promise<YouTubeDjNowPlaying> {
	return request<YouTubeDjNowPlaying>(host, '/now-playing');
}

export async function fetchQueue(
	host: string,
): Promise<YouTubeKaraokeState & { ok?: boolean }> {
	return request(host, '/queue');
}

export function normalizePlaylistConfig(
	config: YouTubeDjPlaylistModeConfig,
): YouTubeDjPlaylistModeConfig {
	if (config.playlists?.length) {
		return config;
	}
	if (!config.playlistId) {
		return {
			...config,
			activePlaylistId: config.activePlaylistId ?? '',
			playlists: [],
		};
	}
	return {
		...config,
		activePlaylistId: config.activePlaylistId || config.playlistId,
		playlists: [
			{
				playlistId: config.playlistId,
				playlistUrl: config.playlistUrl,
				name: 'My Playlist',
				syncedVideoIds: config.syncedVideoIds ?? [],
				lastSyncAt: config.lastSyncAt,
				lastSyncError: config.lastSyncError,
				videoCount: config.syncedVideoIds?.length ?? 0,
			},
		],
	};
}

export async function fetchPlaylistConfig(
	host: string,
): Promise<{ ok: boolean; config: YouTubeDjPlaylistModeConfig }> {
	const data = await request<{ ok: boolean; config: YouTubeDjPlaylistModeConfig }>(
		host,
		'/playlist',
	);
	return { ...data, config: normalizePlaylistConfig(data.config) };
}

export async function queueUrl(
	host: string,
	url: string,
	action: 'queue' | 'play-now' = 'queue',
): Promise<{ ok: boolean; videoId?: string }> {
	return request(host, '/queue', {
		method: 'POST',
		body: JSON.stringify({ url, action }),
	});
}

export async function syncPlaylist(
	host: string,
): Promise<{ ok: boolean; result: YouTubeDjPlaylistSyncResult; config: YouTubeDjPlaylistModeConfig }> {
	return request(host, '/sync', { method: 'POST', body: '{}' }, PLAYLIST_LOAD_TIMEOUT_MS);
}

export async function setPlaylistMode(
	host: string,
	enabled: boolean,
	playlistUrl?: string,
): Promise<{ ok: boolean; config: YouTubeDjPlaylistModeConfig }> {
	if (enabled && playlistUrl) {
		return request(host, '/playlist', {
			method: 'POST',
			body: JSON.stringify({ enabled: true, playlistUrl }),
		});
	}
	return request(host, '/playlist', {
		method: 'PATCH',
		body: JSON.stringify({ enabled }),
	});
}

export async function addPlaylist(
	host: string,
	playlistUrl: string,
): Promise<{ ok: boolean; playlist: YouTubeDjPlaylistEntry; config: YouTubeDjPlaylistModeConfig }> {
	return request(
		host,
		'/playlists',
		{
			method: 'POST',
			body: JSON.stringify({ playlistUrl }),
		},
		PLAYLIST_LOAD_TIMEOUT_MS,
	);
}

export async function removePlaylist(
	host: string,
	playlistId: string,
): Promise<{ ok: boolean; config: YouTubeDjPlaylistModeConfig }> {
	return request(host, `/playlists/${encodeURIComponent(playlistId)}`, {
		method: 'DELETE',
	});
}

export async function activatePlaylist(
	host: string,
	playlistId: string,
	playFirst = false,
): Promise<{ ok: boolean; config: YouTubeDjPlaylistModeConfig }> {
	return request(
		host,
		`/playlists/${encodeURIComponent(playlistId)}/activate`,
		{
			method: 'POST',
			body: JSON.stringify({ playFirst }),
		},
		PLAYLIST_LOAD_TIMEOUT_MS,
	);
}

export async function syncPlaylistById(
	host: string,
	playlistId: string,
): Promise<{ ok: boolean; result: YouTubeDjPlaylistSyncResult; config: YouTubeDjPlaylistModeConfig }> {
	return request(host, `/playlists/${encodeURIComponent(playlistId)}/sync`, {
		method: 'POST',
		body: '{}',
	});
}

export async function clearQueue(host: string): Promise<void> {
	await request(host, '/queue/clear', { method: 'POST', body: '{}' });
}

export async function removeQueueItem(host: string, id: string): Promise<void> {
	await request(host, `/queue/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function playQueueItem(host: string, id: string): Promise<void> {
	await request(host, `/queue/${encodeURIComponent(id)}/play`, {
		method: 'POST',
		body: '{}',
	});
}

export async function moveQueueItem(
	host: string,
	fromIndex: number,
	toIndex: number,
): Promise<YouTubeKaraokeState | null> {
	const data = await request<{ ok: boolean; state?: YouTubeKaraokeState }>(host, '/queue/reorder', {
		method: 'POST',
		body: JSON.stringify({ fromIndex, toIndex }),
	});
	return data.state ?? null;
}

export async function sortQueue(
	host: string,
	mode: QueueSortMode,
): Promise<YouTubeKaraokeState | null> {
	if (mode === 'custom') {
		return null;
	}
	const data = await request<{ ok: boolean; state?: YouTubeKaraokeState }>(
		host,
		'/queue/sort',
		{
			method: 'POST',
			body: JSON.stringify({ mode }),
		},
		PLAYLIST_LOAD_TIMEOUT_MS,
	);
	return data.state ?? null;
}

export async function searchVideos(
	host: string,
	query: string,
): Promise<YouTubeSearchResult[]> {
	const data = await request<{ ok: boolean; results: YouTubeSearchResult[] }>(host, '/search', {
		method: 'POST',
		body: JSON.stringify({ query }),
	});
	return data.results ?? [];
}

export async function transportPlay(host: string): Promise<void> {
	await request(host, '/transport/play', { method: 'POST', body: '{}' });
}

export async function transportPause(host: string): Promise<void> {
	await request(host, '/transport/pause', { method: 'POST', body: '{}' });
}

export async function transportSeekRelative(
	host: string,
	delta: number,
): Promise<YouTubeDjNowPlaying | null> {
	const data = await request<{ ok: boolean; nowPlaying?: YouTubeDjNowPlaying }>(
		host,
		'/transport/seek-relative',
		{
			method: 'POST',
			body: JSON.stringify({ delta }),
		},
	);
	return data.nowPlaying ?? null;
}

export async function transportSeek(
	host: string,
	seconds: number,
): Promise<YouTubeDjNowPlaying | null> {
	const data = await request<{ ok: boolean; nowPlaying?: YouTubeDjNowPlaying }>(
		host,
		'/transport/seek',
		{
			method: 'POST',
			body: JSON.stringify({ seconds }),
		},
	);
	return data.nowPlaying ?? null;
}

export async function transportSkipNext(host: string): Promise<{
	state?: YouTubeKaraokeState;
	nowPlaying?: YouTubeDjNowPlaying;
}> {
	return request(host, '/transport/skip-next', { method: 'POST', body: '{}' });
}

export async function transportSkipPrev(host: string): Promise<{
	state?: YouTubeKaraokeState;
	nowPlaying?: YouTubeDjNowPlaying;
}> {
	return request(host, '/transport/skip-prev', { method: 'POST', body: '{}' });
}

export async function transportVolume(host: string, level: number): Promise<void> {
	await request(host, '/transport/volume', {
		method: 'POST',
		body: JSON.stringify({ level }),
	});
}

export async function setMode(host: string, mode: YouTubeKaraokeMode): Promise<void> {
	await request(host, '/mode', {
		method: 'POST',
		body: JSON.stringify({ mode }),
	});
}

export async function setShuffleEnabled(
	host: string,
	enabled: boolean,
): Promise<YouTubeKaraokeState> {
	const data = await request<{ ok: boolean; state: YouTubeKaraokeState }>(host, '/shuffle', {
		method: 'PATCH',
		body: JSON.stringify({ enabled }),
	});
	return data.state;
}

export async function shuffleUpcoming(host: string): Promise<YouTubeKaraokeState> {
	const data = await request<{ ok: boolean; state: YouTubeKaraokeState }>(
		host,
		'/queue/shuffle-upcoming',
		{
			method: 'POST',
			body: '{}',
		},
	);
	return data.state;
}

export async function importPlaylist(
	host: string,
	playlistUrl: string,
	playFirst = false,
): Promise<{ ok: boolean; count?: number }> {
	return request(
		host,
		'/import-playlist',
		{
			method: 'POST',
			body: JSON.stringify({ playlistUrl, playFirst }),
		},
		PLAYLIST_LOAD_TIMEOUT_MS,
	);
}

export function formatTime(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) {
		return '0:00';
	}
	const mins = Math.floor(seconds / 60);
	const secs = Math.floor(seconds % 60);
	return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatSyncTime(timestamp: number | null): string {
	if (!timestamp) {
		return 'never';
	}
	return new Date(timestamp).toLocaleTimeString();
}

// ─── VLC Controller API ──────────────────────────────────────

// VLC status
export async function fetchVlcStatus(host: string): Promise<VlcStatus> {
	return request<VlcStatus>(host, '/status', undefined, undefined, true);
}

export async function fetchVlcNowPlaying(host: string): Promise<VlcNowPlaying | null> {
	return request<VlcNowPlaying | null>(host, '/now-playing', undefined, undefined, true);
}

export async function fetchVlcPlaylist(host: string): Promise<VlcPlaylistState> {
	return request<VlcPlaylistState>(host, '/playlist', undefined, undefined, true);
}

export async function fetchVlcLibrary(host: string): Promise<LibraryState> {
	return request<LibraryState>(host, '/library', undefined, undefined, true);
}

export async function searchVlcLibrary(host: string, query: string): Promise<LibraryTrack[]> {
	const data = await request<{ results: LibraryTrack[] }>(
		host,
		`/library/search?q=${encodeURIComponent(query)}`,
		undefined,
		undefined,
		true,
	);
	return data.results ?? [];
}

// Transport
export async function vlcTransportPlay(host: string): Promise<void> {
	await request(host, '/transport/play', { method: 'POST', body: '{}' }, undefined, true);
}

export async function vlcTransportPause(host: string): Promise<void> {
	await request(host, '/transport/pause', { method: 'POST', body: '{}' }, undefined, true);
}

export async function vlcTransportSkipNext(host: string): Promise<void> {
	await request(host, '/transport/skip-next', { method: 'POST', body: '{}' }, undefined, true);
}

export async function vlcTransportSkipPrev(host: string): Promise<void> {
	await request(host, '/transport/skip-prev', { method: 'POST', body: '{}' }, undefined, true);
}

export async function vlcTransportSeek(host: string, seconds: number): Promise<void> {
	await request(
		host,
		'/transport/seek',
		{ method: 'POST', body: JSON.stringify({ seconds }) },
		undefined,
		true,
	);
}

export async function vlcTransportSeekRelative(host: string, delta: number): Promise<void> {
	await request(
		host,
		'/transport/seek-relative',
		{ method: 'POST', body: JSON.stringify({ delta }) },
		undefined,
		true,
	);
}

export async function vlcTransportVolume(host: string, level: number): Promise<void> {
	await request(
		host,
		'/transport/volume',
		{ method: 'POST', body: JSON.stringify({ level }) },
		undefined,
		true,
	);
}

// Queue
export async function vlcEnqueueFile(host: string, path: string): Promise<void> {
	await request(
		host,
		'/queue',
		{ method: 'POST', body: JSON.stringify({ path }) },
		undefined,
		true,
	);
}

export async function vlcPlayId(host: string, id: string): Promise<void> {
	await request(
		host,
		`/queue/${encodeURIComponent(id)}/play`,
		{ method: 'POST', body: '{}' },
		undefined,
		true,
	);
}

export async function vlcRemoveFromQueue(host: string, id: string): Promise<void> {
	await request(
		host,
		`/queue/${encodeURIComponent(id)}`,
		{ method: 'DELETE' },
		undefined,
		true,
	);
}

export async function vlcClearQueue(host: string): Promise<void> {
	await request(
		host,
		'/queue/clear',
		{ method: 'POST', body: '{}' },
		undefined,
		true,
	);
}

// Hardware
export async function fetchHardwareMixer(host: string): Promise<HardwareMixerState> {
	return request<HardwareMixerState>(host, '/hardware/mic', undefined, undefined, true);
}

export async function setMicVolume(host: string, level: number): Promise<void> {
	await request(
		host,
		'/hardware/mic',
		{ method: 'POST', body: JSON.stringify({ level }) },
		undefined,
		true,
	);
}

export async function setMicMute(host: string, muted: boolean): Promise<void> {
	await request(
		host,
		'/hardware/mic/mute',
		{ method: 'POST', body: JSON.stringify({ muted }) },
		undefined,
		true,
	);
}
