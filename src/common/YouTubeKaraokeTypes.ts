export type YouTubeQueueItem = {
	id: string;
	url: string;
	videoId: string;
	title: string;
	thumbnail: string;
	status: 'queued' | 'loading' | 'playing' | 'ended' | 'error';
};

export type YouTubeKaraokeState = {
	queue: YouTubeQueueItem[];
	currentIndex: number;
	mode: 'queue' | 'hotswap';
	isPlaying: boolean;
	currentTitle: string;
	currentThumbnail: string;
};

export type YouTubeSearchResult = {
	videoId: string;
	title: string;
	channelTitle: string;
	thumbnailUrl: string;
	url: string;
};
