import { type CSSProperties } from 'react';
import type { VlcNowPlaying, VlcStatus } from '@common/VlcControllerTypes';
import { formatTime } from '../api';

type VlcTransportCardProps = {
  nowPlaying: VlcNowPlaying | null;
  status: VlcStatus | null;
  connected: boolean;
  onPlay: () => void;
  onPause: () => void;
  onSkipNext: () => void;
  onSkipPrev: () => void;
  onSeek: (seconds: number) => void;
  onVolumeChange: (level: number) => void;
};

export default function VlcTransportCard({
  nowPlaying,
  status,
  connected,
  onPlay,
  onPause,
  onSkipNext,
  onSkipPrev,
  onSeek,
  onVolumeChange,
}: VlcTransportCardProps) {
  const isPlaying = status?.state === 'playing';
  const position = nowPlaying?.position ?? status?.position ?? 0;
  const duration = nowPlaying?.duration ?? status?.duration ?? 0;
  const volume = status?.volume ?? 128;
  const volumePercent = Math.round((volume / 256) * 100);
  const progress = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;

  return (
    <div className="card vlc-transport-card">
      {nowPlaying?.coverArt ? (
        <div className="vlc-artwork" style={{ backgroundImage: `url(${nowPlaying.coverArt})` }} />
      ) : (
        <div className="vlc-artwork">
          <i className="fas fa-music" />
        </div>
      )}

      <div className="vlc-track-info">
        <div className="vlc-track-title">
          {nowPlaying?.title || 'No track playing'}
        </div>
        {nowPlaying?.artist ? (
          <div className="vlc-track-artist">{nowPlaying.artist}</div>
        ) : null}
        {nowPlaying?.album ? (
          <div className="vlc-track-album">{nowPlaying.album}</div>
        ) : null}
      </div>

      <div className="scrubber-wrap">
        <input
          className="scrubber"
          type="range"
          min={0}
          max={Math.max(duration, 1)}
          step={1}
          value={Math.min(Math.max(0, position), Math.max(duration, 1))}
          disabled={!connected || duration <= 0}
          onChange={(e) => onSeek(Number(e.target.value))}
          aria-label="Seek"
          style={{ '--progress': `${progress}%` } as CSSProperties}
        />
        <div className="scrubber-times">
          <span>{formatTime(position)}</span>
          <span>{duration > 0 ? formatTime(duration) : '--:--'}</span>
        </div>
      </div>

      <div className="vlc-controls">
        <button
          className="btn vlc-control-btn"
          type="button"
          disabled={!connected}
          onClick={onSkipPrev}
          aria-label="Previous"
        >
          <i className="fas fa-step-backward" />
        </button>
        <button
          className="btn vlc-control-btn large"
          type="button"
          disabled={!connected}
          onClick={() => (isPlaying ? onPause() : onPlay())}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          <i className={`fas ${isPlaying ? 'fa-pause' : 'fa-play'}`} />
        </button>
        <button
          className="btn vlc-control-btn"
          type="button"
          disabled={!connected}
          onClick={onSkipNext}
          aria-label="Next"
        >
          <i className="fas fa-step-forward" />
        </button>
      </div>

      <div className="volume-row">
        <span className="volume-icon" aria-hidden>
          <i
            className={`fas ${
              volumePercent === 0
                ? 'fa-volume-mute'
                : volumePercent < 50
                  ? 'fa-volume-down'
                  : 'fa-volume-up'
            }`}
          />
        </span>
        <input
          className="volume"
          type="range"
          min={0}
          max={100}
          step={1}
          value={volumePercent}
          disabled={!connected}
          onChange={(e) => onVolumeChange(Number(e.target.value))}
          style={{ '--progress': `${volumePercent}%` } as CSSProperties}
        />
        <span className="volume-value">{volumePercent}%</span>
      </div>
    </div>
  );
}
