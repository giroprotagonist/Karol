import type { YouTubeSearchResult } from '../../common/YouTubeKaraokeTypes';
import { getInMemoryYouTubeApiKey } from './youtubeApiKeyConfig';

const SEARCH_ENDPOINT = 'https://www.googleapis.com/youtube/v3/search';
const MAX_SEARCH_RESULTS = 12;

export async function searchYouTubeVideos(query: string): Promise<YouTubeSearchResult[]> {
	const apiKey = getInMemoryYouTubeApiKey();
	if (!apiKey || !query.trim()) {
		return [];
	}

	try {
		const url = new URL(SEARCH_ENDPOINT);
		url.searchParams.set('part', 'snippet');
		url.searchParams.set('maxResults', String(MAX_SEARCH_RESULTS));
		url.searchParams.set('q', query.trim());
		url.searchParams.set('type', 'video');
		url.searchParams.set('key', apiKey);

		const res = await fetch(url.toString());
		const data = await res.json();

		return (data.items || []).map((item: Record<string, unknown>) => {
			const snippet = item.snippet as Record<string, unknown>;
			const id = item.id as Record<string, string>;
			return {
				videoId: id.videoId || '',
				title: String(snippet.title || ''),
				channelTitle: String(snippet.channelTitle || ''),
				thumbnailUrl: String(
					(snippet.thumbnails as Record<string, Record<string, string>>)?.default?.url ||
						'',
				),
				url: `https://www.youtube.com/watch?v=${id.videoId || ''}`,
			};
		});
	} catch (error) {
		console.error('[YT_SEARCH] error', error);
		return [];
	}
}
