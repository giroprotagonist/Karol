import type { YouTubeSearchResult } from '../../common/YouTubeKaraokeTypes';
import {
	YOUTUBE_DJ_TEST_PLAYLIST_ID,
	YOUTUBE_DJ_TEST_PLAYLIST_VIDEO_IDS,
} from '../../common/youtubeDjDefaults';

const PLAYLIST_ITEMS_ENDPOINT =
	'https://www.googleapis.com/youtube/v3/playlistItems';
const INNERTUBE_BROWSE = 'https://www.youtube.com/youtubei/v1/browse';
const MAX_CONTINUATION_PAGES = 60;

export function extractPlaylistId(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) {
		return null;
	}
	if (/^PL[a-zA-Z0-9_-]+$/.test(trimmed)) {
		return trimmed;
	}
	try {
		const u = new URL(trimmed);
		if (
			u.hostname.includes('youtube.com') ||
			u.hostname.includes('youtu.be')
		) {
			const list = u.searchParams.get('list');
			if (list && list.startsWith('PL')) {
				return list;
			}
		}
	} catch {
		// not a URL
	}
	return null;
}

async function fetchPlaylistViaApi(
	playlistId: string,
	apiKey: string,
): Promise<YouTubeSearchResult[]> {
	const results: YouTubeSearchResult[] = [];
	let pageToken = '';

	do {
		const url = new URL(PLAYLIST_ITEMS_ENDPOINT);
		url.searchParams.set('part', 'snippet');
		url.searchParams.set('playlistId', playlistId);
		url.searchParams.set('maxResults', '50');
		url.searchParams.set('key', apiKey);
		if (pageToken) {
			url.searchParams.set('pageToken', pageToken);
		}

		const res = await fetch(url.toString());
		const data = (await res.json()) as {
			items?: Array<{
				snippet?: {
					title?: string;
					resourceId?: { videoId?: string };
					thumbnails?: { default?: { url?: string } };
				};
			}>;
			nextPageToken?: string;
		};

		for (const item of data.items ?? []) {
			const videoId = item.snippet?.resourceId?.videoId ?? '';
			if (!videoId) {
				continue;
			}
			results.push({
				videoId,
				title: String(item.snippet?.title ?? `YouTube: ${videoId}`),
				channelTitle: '',
				thumbnailUrl: String(item.snippet?.thumbnails?.default?.url ?? ''),
				url: `https://www.youtube.com/watch?v=${videoId}`,
			});
		}

		pageToken = data.nextPageToken ?? '';
	} while (pageToken);

	return results;
}

type InnertubeConfig = {
	apiKey: string;
	clientVersion: string;
	initialData: unknown;
};

class PlaylistCollector {
	seen = new Set<string>();
	results: YouTubeSearchResult[] = [];
	continuation: string | null = null;

	merge(other: PlaylistCollector): void {
		for (const video of other.results) {
			if (!this.seen.has(video.videoId)) {
				this.seen.add(video.videoId);
				this.results.push(video);
			}
		}
		if (other.continuation) {
			this.continuation = other.continuation;
		}
	}

	consume(node: unknown): void {
		if (!node || typeof node !== 'object') {
			return;
		}
		if (Array.isArray(node)) {
			for (const child of node) {
				this.consume(child);
			}
			return;
		}
		const obj = node as Record<string, unknown>;
		if (obj.playlistVideoRenderer && typeof obj.playlistVideoRenderer === 'object') {
			this.addVideo(obj.playlistVideoRenderer as Record<string, unknown>);
		}
		if (obj.playlistPanelVideoRenderer && typeof obj.playlistPanelVideoRenderer === 'object') {
			this.addVideo(obj.playlistPanelVideoRenderer as Record<string, unknown>);
		}
		this.captureContinuation(obj);
		for (const value of Object.values(obj)) {
			this.consume(value);
		}
	}

	private addVideo(renderer: Record<string, unknown>): void {
		const nav = renderer.navigationEndpoint as Record<string, unknown> | undefined;
		const watch = nav?.watchEndpoint as Record<string, unknown> | undefined;
		const videoId =
			(typeof watch?.videoId === 'string' && watch.videoId.length === 11
				? watch.videoId
				: typeof renderer.videoId === 'string' && renderer.videoId.length === 11
					? renderer.videoId
					: '') || '';
		if (!videoId || this.seen.has(videoId)) {
			return;
		}
		this.seen.add(videoId);
		const titleObj = renderer.title as Record<string, unknown> | undefined;
		const runs = titleObj?.runs as Array<{ text?: string }> | undefined;
		const title =
			runs?.[0]?.text?.trim() ||
			(typeof titleObj?.simpleText === 'string' ? titleObj.simpleText.trim() : '') ||
			`YouTube: ${videoId}`;
		this.results.push({
			videoId,
			title,
			channelTitle: '',
			thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/default.jpg`,
			url: `https://www.youtube.com/watch?v=${videoId}`,
		});
	}

	private captureContinuation(obj: Record<string, unknown>): void {
		const item = obj.continuationItemRenderer as Record<string, unknown> | undefined;
		const token = item ? extractContinuationToken(item) : '';
		if (token) {
			this.continuation = token;
		}
	}
}

function extractContinuationToken(renderer: Record<string, unknown>): string {
	const endpoint = renderer.continuationEndpoint as Record<string, unknown> | undefined;
	if (!endpoint) {
		return '';
	}
	const direct = endpoint.continuationCommand as Record<string, unknown> | undefined;
	if (typeof direct?.token === 'string' && direct.token) {
		return direct.token;
	}
	const commands = (endpoint.commandExecutorCommand as Record<string, unknown> | undefined)
		?.commands as Array<Record<string, unknown>> | undefined;
	for (const cmd of commands ?? []) {
		const token = (cmd.continuationCommand as Record<string, unknown> | undefined)?.token;
		if (typeof token === 'string' && token) {
			return token;
		}
	}
	return '';
}

function extractYtInitialData(html: string): unknown | null {
	const marker = 'var ytInitialData = ';
	const startIdx = html.indexOf(marker);
	if (startIdx < 0) {
		return null;
	}
	let i = startIdx + marker.length;
	while (i < html.length && /\s/.test(html[i] ?? '')) {
		i++;
	}
	if (html[i] !== '{') {
		return null;
	}
	let depth = 0;
	const begin = i;
	for (; i < html.length; i++) {
		const ch = html[i];
		if (ch === '{') {
			depth++;
		} else if (ch === '}') {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(html.slice(begin, i + 1));
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}

function extractPlaylistListContinuationToken(initialData: unknown): string {
	if (!initialData || typeof initialData !== 'object') {
		return '';
	}
	const found = findPlaylistListContinuation(initialData);
	return found ?? '';
}

function findPlaylistListContinuation(node: unknown): string | null {
	if (!node || typeof node !== 'object') {
		return null;
	}
	if (Array.isArray(node)) {
		for (const child of node) {
			const hit = findPlaylistListContinuation(child);
			if (hit) {
				return hit;
			}
		}
		return null;
	}
	const obj = node as Record<string, unknown>;
	const listRenderer = obj.playlistVideoListRenderer as Record<string, unknown> | undefined;
	if (listRenderer) {
		const contents = listRenderer.contents as unknown[] | undefined;
		for (const item of contents ?? []) {
			if (!item || typeof item !== 'object') {
				continue;
			}
			const contRenderer = (item as Record<string, unknown>).continuationItemRenderer;
			if (contRenderer && typeof contRenderer === 'object') {
				const token = extractContinuationToken(contRenderer as Record<string, unknown>);
				if (token) {
					return token;
				}
			}
		}
	}
	for (const value of Object.values(obj)) {
		const hit = findPlaylistListContinuation(value);
		if (hit) {
			return hit;
		}
	}
	return null;
}

function extractInnertubeConfig(html: string): InnertubeConfig | null {
	const apiKey = /"INNERTUBE_API_KEY":"([^"]+)"/.exec(html)?.[1];
	if (!apiKey) {
		return null;
	}
	const clientVersion =
		/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/.exec(html)?.[1] ||
		/"clientVersion":"([^"]+)"/.exec(html)?.[1] ||
		'2.20240101.00.00';
	const initialData = extractYtInitialData(html);
	if (!initialData) {
		return null;
	}
	return { apiKey, clientVersion, initialData };
}

async function postInnertubeBrowse(
	innertubeKey: string,
	clientVersion: string,
	continuation: string,
): Promise<unknown> {
	const res = await fetch(`${INNERTUBE_BROWSE}?key=${encodeURIComponent(innertubeKey)}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Accept-Language': 'en-US,en;q=0.9',
		},
		body: JSON.stringify({
			context: {
				client: {
					clientName: 'WEB',
					clientVersion,
					hl: 'en',
					gl: 'US',
				},
			},
			continuation,
		}),
	});
	if (!res.ok) {
		throw new Error(`Innertube browse failed (${res.status})`);
	}
	return res.json();
}

async function fetchPlaylistViaInnertube(
	playlistId: string,
): Promise<YouTubeSearchResult[]> {
	const res = await fetch(
		`https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`,
	);
	const html = await res.text();
	const config = extractInnertubeConfig(html);
	if (!config) {
		return fetchPlaylistViaHtmlScrapeRegex(html);
	}

	const collector = new PlaylistCollector();
	collector.consume(config.initialData);

	let continuation =
		extractPlaylistListContinuationToken(config.initialData) || collector.continuation;
	let pages = 0;
	while (continuation && pages < MAX_CONTINUATION_PAGES) {
		pages++;
		const response = await postInnertubeBrowse(
			config.apiKey,
			config.clientVersion,
			continuation,
		);
		const pageCollector = new PlaylistCollector();
		pageCollector.consume(response);
		collector.merge(pageCollector);
		const next = pageCollector.continuation;
		if (!next || next === continuation) {
			break;
		}
		continuation = next;
	}

	console.info(
		`[YT_PLAYLIST] innertube ${playlistId}: ${collector.results.length} videos (${pages} pages)`,
	);
	return collector.results;
}

function fetchPlaylistViaHtmlScrapeRegex(html: string): YouTubeSearchResult[] {
	const seen = new Set<string>();
	const results: YouTubeSearchResult[] = [];
	const re = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(html)) !== null) {
		const videoId = match[1];
		if (seen.has(videoId)) {
			continue;
		}
		seen.add(videoId);
		results.push({
			videoId,
			title: `YouTube: ${videoId}`,
			channelTitle: '',
			thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/default.jpg`,
			url: `https://www.youtube.com/watch?v=${videoId}`,
		});
	}
	return results;
}

async function fetchPlaylistViaHtmlScrape(
	playlistId: string,
): Promise<YouTubeSearchResult[]> {
	try {
		return await fetchPlaylistViaInnertube(playlistId);
	} catch (error) {
		console.error('[YT_PLAYLIST] innertube failed', error);
		const res = await fetch(
			`https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`,
		);
		return fetchPlaylistViaHtmlScrapeRegex(await res.text());
	}
}

export async function fetchYouTubePlaylistVideos(
	playlistIdOrUrl: string,
	apiKey: string,
): Promise<{ videos: YouTubeSearchResult[]; playlistId: string }> {
	const playlistId = extractPlaylistId(playlistIdOrUrl);
	if (!playlistId) {
		return { videos: [], playlistId: '' };
	}

	if (playlistId === YOUTUBE_DJ_TEST_PLAYLIST_ID && !apiKey) {
		return {
			playlistId,
			videos: YOUTUBE_DJ_TEST_PLAYLIST_VIDEO_IDS.map((videoId) => ({
				videoId,
				title: `YouTube: ${videoId}`,
				channelTitle: '',
				thumbnailUrl: '',
				url: `https://www.youtube.com/watch?v=${videoId}`,
			})),
		};
	}

	if (apiKey) {
		try {
			const videos = await fetchPlaylistViaApi(playlistId, apiKey);
			if (videos.length > 0) {
				return { videos, playlistId };
			}
		} catch (error) {
			console.error('[YT_PLAYLIST] API fetch failed', error);
		}
	}

	try {
		const videos = await fetchPlaylistViaHtmlScrape(playlistId);
		return { videos, playlistId };
	} catch (error) {
		console.error('[YT_PLAYLIST] HTML scrape failed', error);
		return { videos: [], playlistId };
	}
}
