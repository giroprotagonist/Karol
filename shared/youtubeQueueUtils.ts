/**
 * Returns a human-readable title for a queue item.
 * Falls back to the video ID if the title is empty or just a URL.
 */
export function getQueueItemDisplayTitle(title: string, videoId: string): string {
	const clean = (title || '').trim();
	if (!clean || clean.startsWith('http')) return videoId;
	return clean;
}
