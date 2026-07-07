export type YouTubeQueueItem = {
	id: string;
	url: string;
	videoId: string;
	title: string;
	thumbnail: string;
	status: 'queued' | 'loading' | 'playing' | 'ended' | 'error';
	errorReason?: string;
	durationSec?: number;
	/** Position in the playlist at load time (YouTube custom order) */
	playlistPosition?: number;
	/** When the video was added to the playlist (ms epoch) */
	addedAtMs?: number;
	/** When the video was published to YouTube (ms epoch) */
	publishedAtMs?: number;
	viewCount?: number;
	channelTitle?: string;
};

export type YouTubeKaraokeMode = 'queue' | 'hotswap' | 'manual';

export type YouTubeKaraokeState = {
	queue: YouTubeQueueItem[];
	currentIndex: number;
	mode: YouTubeKaraokeMode;
	/** When true, auto-advance and skip-next pick a random upcoming track */
	shuffleEnabled?: boolean;
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
	playlistPosition?: number;
	addedAtMs?: number;
	publishedAtMs?: number;
	durationSec?: number;
	viewCount?: number;
};

export type YouTubeDjNowPlaying = {
	title: string;
	videoId: string;
	thumbnail?: string;
	currentTime: number;
	duration: number;
	state: number;
	volumeLevel?: number;
};

export type YouTubeDjPlaylistEntry = {
	playlistId: string;
	playlistUrl: string;
	name: string;
	syncedVideoIds: string[];
	lastSyncAt: number | null;
	lastSyncError: string | null;
	videoCount: number;
};

export type YouTubeDjPlaylistModeConfig = {
	enabled: boolean;
	/** Active playlist used for the show and auto-sync */
	activePlaylistId: string;
	playlists: YouTubeDjPlaylistEntry[];
	/** @deprecated Use activePlaylistId + playlists — kept for older clients */
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
	/** `direct` = android-player tablet host; `mac` or omitted = Deskreen CE on Mac */
	hostMode?: 'direct' | 'mac';
	showActive?: boolean;
	queueLength?: number;
	currentTitle?: string;
	interstitialMessage?: string | null;
	lastPlaybackError?: string | null;
	lastAdvanceReason?: string | null;
	volumeLevel?: number;
	youtubeSignedIn?: boolean;
	youtubePremiumActive?: boolean;
};
