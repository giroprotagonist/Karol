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

export type YouTubeDjQueueSnapshot = {
	queue: YouTubeQueueItem[];
	currentIndex: number;
	mode: YouTubeKaraokeMode;
	currentTitle?: string;
	currentTime?: number;
	duration?: number;
	updatedAt?: number;
};

export type YouTubeDjRemoteCommandType =
	| 'getState'
	| 'playNow'
	| 'skipNext'
	| 'skipPrev'
	| 'clearQueue'
	| 'removeFromQueue'
	| 'moveQueueItemUp'
	| 'moveQueueItemDown'
	| 'reorderQueue'
	| 'setMode'
	| 'addVideos'
	| 'applySyncResult';

export type YouTubeDjRemoteCommandPayload = {
	requestId: string;
	type: YouTubeDjRemoteCommandType;
	id?: string;
	fromIndex?: number;
	toIndex?: number;
	mode?: YouTubeKaraokeMode;
	videos?: YouTubeSearchResult[];
	source?: 'playlist' | 'manual' | 'extension';
	result?: YouTubeDjPlaylistSyncResult;
};

export type YouTubeDjStatus = {
	ok: boolean;
	djActive: boolean;
	castConnected: boolean;
	captureReady: boolean;
	port: number;
};
