export type YouTubeVideoMetadata = {
	videoId: string;
	title: string;
	thumbnailUrl: string;
};

const VIDEOS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/videos';

async function fetchViaApi(
	videoIds: string[],
	apiKey: string,
): Promise<Map<string, YouTubeVideoMetadata>> {
	const result = new Map<string, YouTubeVideoMetadata>();

	for (let index = 0; index < videoIds.length; index += 50) {
		const batch = videoIds.slice(index, index + 50);
		const url = new URL(VIDEOS_ENDPOINT);
		url.searchParams.set('part', 'snippet');
		url.searchParams.set('id', batch.join(','));
		url.searchParams.set('key', apiKey);

		const res = await fetch(url.toString());
		if (!res.ok) {
			continue;
		}

		const data = (await res.json()) as {
			items?: Array<{
				id?: string;
				snippet?: {
					title?: string;
					thumbnails?: { default?: { url?: string } };
				};
			}>;
		};

		for (const item of data.items ?? []) {
			const videoId = item.id ?? '';
			if (!videoId) {
				continue;
			}
			result.set(videoId, {
				videoId,
				title: String(item.snippet?.title ?? ''),
				thumbnailUrl: String(item.snippet?.thumbnails?.default?.url ?? ''),
			});
		}
	}

	return result;
}

async function fetchViaOembed(videoId: string): Promise<YouTubeVideoMetadata | null> {
	try {
		const url = new URL('https://www.youtube.com/oembed');
		url.searchParams.set('url', `https://www.youtube.com/watch?v=${videoId}`);
		url.searchParams.set('format', 'json');

		const res = await fetch(url.toString());
		if (!res.ok) {
			return null;
		}

		const data = (await res.json()) as { title?: string; thumbnail_url?: string };
		const title = String(data.title ?? '').trim();
		if (!title) {
			return null;
		}

		return {
			videoId,
			title,
			thumbnailUrl: String(data.thumbnail_url ?? ''),
		};
	} catch {
		return null;
	}
}

export async function fetchYouTubeVideoMetadata(
	videoIds: string[],
	apiKey = '',
): Promise<YouTubeVideoMetadata[]> {
	const unique = [...new Set(videoIds.map((id) => id.trim()).filter(Boolean))];
	if (unique.length === 0) {
		return [];
	}

	const byId = new Map<string, YouTubeVideoMetadata>();

	if (apiKey) {
		try {
			const apiResults = await fetchViaApi(unique, apiKey);
			for (const [videoId, metadata] of apiResults) {
				if (metadata.title) {
					byId.set(videoId, metadata);
				}
			}
		} catch (error) {
			console.error('[YT_METADATA] API fetch failed', error);
		}
	}

	const missing = unique.filter((videoId) => !byId.has(videoId));
	const oembedResults = await Promise.all(missing.map((videoId) => fetchViaOembed(videoId)));
	for (const metadata of oembedResults) {
		if (metadata) {
			byId.set(metadata.videoId, metadata);
		}
	}

	return unique
		.map((videoId) => byId.get(videoId))
		.filter((metadata): metadata is YouTubeVideoMetadata => Boolean(metadata));
}
