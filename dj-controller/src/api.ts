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

type HardwareMixerState = {
	micVolume: number;
	micMuted: boolean;
};

const HOST_KEY = 'karol_player_host';

/** When loaded from Karol's bundled /dj-controller/ page, use the page origin. */
export function getDefaultHost(): string {
	if (typeof window !== 'undefined' && window.location.pathname.includes('dj-controller')) {
		const origin = window.location.origin.replace(/\/+$/, '');
		// Always prefer the page origin — avoids stale saved host
		saveHost(origin);
		return origin;
	}
	const saved = normalizeHost(getSavedHost());
	return saved;
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

const FETCH_TIMEOUT_MS = 12000;
const PLAYLIST_LOAD_TIMEOUT_MS = 180_000;

async function request<T>(
	host: string,
	path: string,
	init?: RequestInit,
	timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<T> {
	const base = apiBase(host);
	const url = `${base}${path}`;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			...init,
			signal: controller.signal,
			headers: {
				...(init?.method && init.method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
				'X-Karol-Client': 'KarolController/1.0',
				...(init?.headers ?? {}),
			},
		});
		const text = await res.text();
		let data: T & { error?: string; ok?: boolean };
		try {
			data = JSON.parse(text) as T & { error?: string; ok?: boolean };
		} catch (parseErr) {
			if (!text.trim()) {
				throw new Error(`Empty response from ${base} (status ${res.status})`);
			}
			throw new Error(`Invalid response from ${base}: ${text.slice(0, 100)}`);
		}
		if (!res.ok) {
			throw new Error(data.error || `Request failed (${res.status})`);
		}
		// The S8 proxy returns HTTP 200 with { ok: false, error: "..." } when the upstream
		// (Mac Karol) is unreachable. Treat these as errors too so callers don't receive
		// a mismatched object shape and crash.
		if (data.ok === false && data.error) {
			throw new Error(data.error);
		}
		if (typeof data.error === 'string' && data.error) {
			// Some endpoints return { error: "..." } without an explicit ok:false wrapper.
			// If the response only has an error field and nothing else of substance,
			// treat it as a request failure.
			const meaningfulKeys = Object.keys(data).filter(
				(k) => k !== 'error' && k !== 'ok',
			);
			if (meaningfulKeys.length === 0) {
				throw new Error(data.error);
			}
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

export type KarolFxName = 'sendit' | 'applause' | 'airhorn' | 'fire' | 'encore';

export async function triggerFx(host: string, name: KarolFxName): Promise<void> {
	await request(host, '/fx', {
		method: 'POST',
		body: JSON.stringify({ name }),
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

// Hardware
export async function fetchHardwareMixer(host: string): Promise<HardwareMixerState> {
	return request<HardwareMixerState>(host, '/hardware/mic');
}

export async function setMicVolume(host: string, level: number): Promise<void> {
	await request(
		host,
		'/hardware/mic',
		{ method: 'POST', body: JSON.stringify({ level }) },
	);
}

export async function setMicMute(host: string, muted: boolean): Promise<void> {
	await request(
		host,
		'/hardware/mic/mute',
		{ method: 'POST', body: JSON.stringify({ muted }) },
	);
}

// ─── Library Status (local video download progress) ─────────

export interface LibraryStatus {
	ok: boolean;
	ready: boolean;
	metadata: { title: string; duration: number; subtitles: string[] } | null;
	subtitles: { lang: string }[];
}

export async function fetchLibraryStatus(
	host: string,
	videoId: string,
): Promise<LibraryStatus> {
	if (!videoId) return { ok: true, ready: false, metadata: null, subtitles: [] };
	const resp = await fetch(
		`${normalizeHost(host)}/api/library/status/${encodeURIComponent(videoId)}`,
		{ signal: AbortSignal.timeout(5000) },
	);
	if (!resp.ok) return { ok: true, ready: false, metadata: null, subtitles: [] };
	return resp.json();
}

// ─── Library Dashboard API ───────────────────────────────────

function libraryApiBase(host: string): string {
	return `${normalizeHost(host)}/api/library`;
}

async function libraryRequest<T>(
	host: string,
	path: string,
	init?: RequestInit,
	timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<T> {
	const base = libraryApiBase(host);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${base}${path}`, {
			...init,
			signal: controller.signal,
			headers: {
				'Content-Type': 'application/json',
				...(init?.headers ?? {}),
			},
		});
		const data = (await res.json()) as T & { error?: string; ok?: boolean };
		if (!res.ok) {
			throw new Error(data.error || `Request failed (${res.status})`);
		}
		return data;
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			throw new Error('Request timed out');
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

export interface LibraryVideoMeta {
	videoId: string;
	title: string;
	duration: number;
	size: number;
	subtitles: string[];
	thumbnail: string;
	upload_date: string;
	cached: boolean;
	tag?: string;
	year?: string;
	artist?: string;
	source?: string;
}

export interface LibraryListResponse {
	ok: boolean;
	count: number;
	videos: LibraryVideoMeta[];
}

export interface LibraryScanStats {
	ok: boolean;
	totalVideos: number;
	totalMp4Files: number;
	totalSize: number;
	totalSizeFormatted: string;
	subtitleLanguages: string[];
}

export interface LibraryTagEntry {
	tag: string;
	year: string;
	artist: string;
	source: string;
}

export interface LibraryTagsResponse {
	ok: boolean;
	tags: Record<string, LibraryTagEntry>;
}

/** Merged video entry used by the Library tab UI */
export interface LibraryVideo {
	videoId: string;
	title: string;
	duration: number;
	size: number;
	subtitles: string[];
	thumbnail: string;
	uploaded: string;
	downloaded: boolean;
	tag: string;
	year: string;
	artist: string;
	source: string;
	playlists: { id: string; name: string }[];
}

export async function fetchLibraryList(host: string): Promise<LibraryListResponse> {
	return libraryRequest<LibraryListResponse>(host, '/list', undefined, 30_000);
}

export async function fetchLibraryScan(host: string): Promise<LibraryScanStats> {
	return libraryRequest<LibraryScanStats>(host, '/scan');
}

export async function fetchLibraryTags(host: string): Promise<LibraryTagsResponse> {
	return libraryRequest<LibraryTagsResponse>(host, '/tags');
}

export async function setLibraryTag(
	host: string,
	videoId: string,
	tag: string,
	year?: string,
	artist?: string,
	source?: string,
): Promise<{ ok: boolean }> {
	return libraryRequest<{ ok: boolean }>(host, '/tags', {
		method: 'POST',
		body: JSON.stringify({ videoId, tag, year, artist, source }),
	});
}

export async function downloadPlaylist(
	host: string,
	playlistUrl: string,
): Promise<{ ok: boolean }> {
	return libraryRequest<{ ok: boolean }>(host, '/download-playlist', {
		method: 'POST',
		body: JSON.stringify({ playlistUrl }),
	});
}

export async function checkLibraryVideoStatus(
	host: string,
	videoId: string,
): Promise<LibraryStatus> {
	return fetchLibraryStatus(host, videoId);
}

export interface AddVideoResponse {
	ok: boolean;
	videoId?: string;
	status?: 'downloading' | 'complete';
	message?: string;
	error?: string;
}

export interface DownloadStatusResponse {
	ok: boolean;
	videoId: string;
	status: 'downloading' | 'complete' | 'failed' | 'not_found';
	progress: number;
	error?: string;
}

export async function addVideoToLibrary(
	host: string,
	url: string,
): Promise<AddVideoResponse> {
	return libraryRequest<AddVideoResponse>(host, '/add-video', {
		method: 'POST',
		body: JSON.stringify({ url }),
	});
}

export async function fetchDownloadStatus(
	host: string,
	videoId: string,
): Promise<DownloadStatusResponse> {
	return libraryRequest<DownloadStatusResponse>(host, '/download-status/' + videoId);
}

export interface DeleteVideoResponse {
	ok: boolean;
	videoId: string;
	deleted: { mp4: boolean; info: boolean; subs: number };
	warnings?: string[];
}

export async function deleteLibraryVideo(
	host: string,
	videoId: string,
): Promise<DeleteVideoResponse> {
	return libraryRequest<DeleteVideoResponse>(host, '/video/' + encodeURIComponent(videoId), {
		method: 'DELETE',
	});
}
