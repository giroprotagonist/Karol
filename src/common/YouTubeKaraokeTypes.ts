export type YouTubeQueueItem = {
	id: string;
	url: string;
	videoId: string;
	title: string;
	thumbnail: string;
	status: 'queued' | 'loading' | 'playing' | 'ended' | 'error';
	errorReason?: string;
	durationSec?: number;
};

export type YouTubeKaraokeMode = 'queue' | 'hotswap' | 'manual';

export type YouTubeKaraokeState = {
	queue: YouTubeQueueItem[];
	currentIndex: number;
	mode: YouTubeKaraokeMode;
	isPlaying: boolean;
	currentTitle: string;
	currentThumbnail: string;
	currentTime: number;
	duration: number;
};

export type YouTubeSearchResult = {
	videoId: string;
	title: string;
	channelTitle: string;
	thumbnailUrl: string;
	url: string;
};

export type YouTubeDjNowPlaying = {
	title: string;
	videoId: string;
	currentTime: number;
	duration: number;
	state: number;
};
