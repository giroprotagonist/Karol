import type {
	YouTubeDjNowPlaying,
	YouTubeDjPlaylistModeConfig,
	YouTubeDjPlaylistSyncResult,
	YouTubeDjStatus,
	YouTubeKaraokeMode,
	YouTubeKaraokeState,
	YouTubeSearchResult,
} from '@common/YouTubeKaraokeTypes';

const HOST_KEY = 'deskreen_dj_host';

/** When loaded from Deskreen's bundled /dj-controller/ page, use the page origin. */
export function getDefaultHost(): string {
	const saved = getSavedHost();
	if (saved) {
		return saved;
	}
	if (typeof window === 'undefined') {
		return '';
	}
	if (window.location.pathname.includes('dj-controller')) {
		return window.location.origin.replace(/\/+$/, '');
	}
	return '';
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

async function request<T>(
	host: string,
	path: string,
	init?: RequestInit,
): Promise<T> {
	const res = await fetch(`${apiBase(host)}${path}`, {
		...init,
		headers: {
			'Content-Type': 'application/json',
			'X-Deskreen-Client': 'DeskreenController/1.0',
			...(init?.headers ?? {}),
		},
	});
	const data = (await res.json()) as T & { error?: string };
	if (!res.ok) {
		throw new Error(data.error || `Request failed (${res.status})`);
	}
	return data;
}

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

export async function fetchPlaylistConfig(
	host: string,
): Promise<{ ok: boolean; config: YouTubeDjPlaylistModeConfig }> {
	return request(host, '/playlist');
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
	return request(host, '/sync', { method: 'POST', body: '{}' });
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

export async function transportSeekRelative(host: string, delta: number): Promise<void> {
	await request(host, '/transport/seek-relative', {
		method: 'POST',
		body: JSON.stringify({ delta }),
	});
}

export async function transportSeek(host: string, seconds: number): Promise<void> {
	await request(host, '/transport/seek', {
		method: 'POST',
		body: JSON.stringify({ seconds }),
	});
}

export async function transportSkipNext(host: string): Promise<void> {
	await request(host, '/transport/skip-next', { method: 'POST', body: '{}' });
}

export async function transportSkipPrev(host: string): Promise<void> {
	await request(host, '/transport/skip-prev', { method: 'POST', body: '{}' });
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

export async function importPlaylist(
	host: string,
	playlistUrl: string,
	playFirst = false,
): Promise<{ ok: boolean; count?: number }> {
	return request(host, '/import-playlist', {
		method: 'POST',
		body: JSON.stringify({ playlistUrl, playFirst }),
	});
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
