/** True when the queue item still needs a human-readable title fetched. */
export function isPlaceholderQueueTitle(title: string, videoId: string): boolean {
	if (!title.trim()) {
		return true;
	}
	if (title === videoId) {
		return true;
	}
	if (title === `YouTube: ${videoId}`) {
		return true;
	}
	return false;
}

export function getQueueItemDisplayTitle(title: string, videoId: string): string {
	if (!isPlaceholderQueueTitle(title, videoId)) {
		return title;
	}
	return 'Loading title…';
}
