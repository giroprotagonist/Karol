export type VlcTrack = {
  id: string;
  name: string;
  uri: string;
  duration?: number;
  coverUrl?: string; // relative URL to /api/vlc-dj/cover?path=...
};

export type VlcStatus = {
  state: 'playing' | 'paused' | 'stopped';
  position: number;
  duration: number;
  volume: number;
  time: number;
  length: number;
  fullscreen: boolean;
  loop: boolean;
  random: boolean;
  repeat: boolean;
  playlistLength?: number;
};

export type VlcNowPlaying = {
  title: string;
  artist?: string;
  album?: string;
  duration: number;
  position: number;
  filePath?: string;
  id?: string;
  coverArt?: string; // base64 data URI (legacy, will be phased out)
  coverPath?: string; // file path for the cover endpoint
  coverUrl?: string;  // full URL to /api/vlc-dj/cover?path=...
};

export type VlcPlaylistState = {
  tracks: VlcTrack[];
  currentIndex: number;
};

export type HardwareMixerState = {
  micVolume: number;
  micMuted: boolean;
  vlcVolume?: number;
};

export type LibraryTrack = {
  path: string;
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
  coverUrl?: string; // relative URL to /api/vlc-dj/cover?path=...
};

export type LibraryState = {
  tracks: LibraryTrack[];
  folder: string;
};
