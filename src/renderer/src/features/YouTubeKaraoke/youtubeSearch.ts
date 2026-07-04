import { type YouTubeSearchResult } from '@common/YouTubeKaraokeTypes';
import { IpcEvents } from '@common/IpcEvents.enum';

export async function searchYouTube(
	query: string,
): Promise<YouTubeSearchResult[]> {
	if (!query.trim()) return [];

	const result = await window.electron.ipcRenderer.invoke(
		IpcEvents.YOUTUBE_KARAOKE_SEARCH,
		query,
	);
	return (result?.results as YouTubeSearchResult[]) || [];
}

export function extractVideoId(url: string): string | null {
	try {
		const u = new URL(url);
		if (u.hostname.includes('youtube.com') || u.hostname.includes('youtu.be')) {
			if (u.hostname.includes('youtu.be')) {
				return u.pathname.slice(1).split('/')[0] || null;
			}
			return u.searchParams.get('v') || null;
		}
	} catch (_) {}
	// Raw ID match
	const match = url.match(/^[a-zA-Z0-9_-]{11}$/);
	if (match) return match[0];
	return null;
}

export function extractVideoTitleFromUrl(url: string): string {
	try {
		const u = new URL(url);
		return u.searchParams.get('title') || url;
	} catch (_) {
		return url;
	}
}
