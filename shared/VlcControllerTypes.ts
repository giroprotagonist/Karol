// ── VLC Controller Types ──

export type VlcStatus = {
	ok: boolean;
	vlcRunning: boolean;
	playing: boolean;
	currentIndex: number;
	playlistLength: number;
	volume: number;
};

export type VlcNowPlaying = {
	title: string;
	artist?: string;
	album?: string;
	filePath: string;
	duration: number;
	currentTime: number;
	state: number; // 0=idle, 1=playing, 2=paused
};

export type VlcPlaylistState = {
	tracks: VlcNowPlaying[];
	currentIndex: number;
	isPlaying: boolean;
};

export type LibraryTrack = {
	id: string;
	title: string;
	artist?: string;
	album?: string;
	filePath: string;
	duration: number;
};

export type LibraryState = {
	tracks: LibraryTrack[];
	totalCount: number;
	scanComplete: boolean;
};

export type HardwareMixerState = {
	micVolume: number;
	micMuted: boolean;
	systemVolume: number;
};
