import type { YouTubeSearchResult } from '../../common/YouTubeKaraokeTypes';
import {
	YOUTUBE_DJ_TEST_PLAYLIST_ID,
	YOUTUBE_DJ_TEST_PLAYLIST_VIDEO_IDS,
} from '../../common/youtubeDjDefaults';

const PLAYLIST_ITEMS_ENDPOINT =
	'https://www.googleapis.com/youtube/v3/playlistItems';

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

async function fetchPlaylistViaHtmlScrape(
	playlistId: string,
): Promise<YouTubeSearchResult[]> {
	const res = await fetch(
		`https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`,
	);
	const html = await res.text();
	const seen = new Set<string>();
	const results: YouTubeSearchResult[] = [];
	const re = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(html)) !== null) {
		const videoId = match[1];
		if (seen.has(videoId) || videoId === playlistId.slice(0, 11)) {
			continue;
		}
		seen.add(videoId);
		results.push({
			videoId,
			title: `YouTube: ${videoId}`,
			channelTitle: '',
			thumbnailUrl: '',
			url: `https://www.youtube.com/watch?v=${videoId}`,
		});
	}
	return results;
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
