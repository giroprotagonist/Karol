export type AbletonTrack = {
  index: number;
  name: string;
  volume: number;  // 0-1
  muted: boolean;
};

export type AbletonState = {
  connected: boolean;
  playing: boolean;
  tempo: number;
  tracks: AbletonTrack[];
  masterVolume: number; // 0-1
};
