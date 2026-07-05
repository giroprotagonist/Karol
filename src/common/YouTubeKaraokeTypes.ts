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

export type YouTubeDjPlaylistModeConfig = {
	enabled: boolean;
	playlistId: string;
	playlistUrl: string;
	syncedVideoIds: string[];
	lastSyncAt: number | null;
	lastSyncError: string | null;
	lastAddedCount: number;
};

export type YouTubeDjPlaylistSyncResult = {
	added: YouTubeSearchResult[];
	playlistId: string;
	syncedAt: number;
	error?: string;
};

export type YouTubeDjSetPlaylistModeInput = {
	enabled: boolean;
	playlistUrlOrId?: string;
};
