import { useState } from 'react';
import type { VlcTrack } from '@common/VlcControllerTypes';

type VlcQueueListProps = {
  tracks: VlcTrack[];
  currentIndex: number;
  connected: boolean;
  host: string;
  pendingOps?: Set<string>;
  onPlay: (id: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
};

function formatDuration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function QueueCoverImage({ uri, name, host }: { uri?: string; name: string; host: string }) {
  const [imgErr, setImgErr] = useState(false);
  const src = uri ? (uri.startsWith('http') ? uri : `${host}${uri}`) : '';
  return !imgErr && src ? (
    <img
      className="vlc-queue-thumb"
      src={src}
      alt={name}
      loading="lazy"
      onError={() => setImgErr(true)}
    />
  ) : (
    <div className="vlc-queue-thumb vlc-queue-thumb-fb">
      <i className="fas fa-music" />
    </div>
  );
}

export default function VlcQueueList({
  tracks,
  currentIndex,
  connected,
  host,
  pendingOps,
  onPlay,
  onRemove,
  onClear,
}: VlcQueueListProps) {
  return (
    <div className="card queue-card vlc-queue-card">
      <div className="card-header">
        <h2>VLC Queue ({tracks.length})</h2>
        <button
          className="btn small danger-subtle"
          type="button"
          disabled={!connected || tracks.length === 0}
          onClick={onClear}
        >
          <i className="fas fa-trash-alt" /> Clear
        </button>
      </div>

      <div className="vlc-queue-list">
        {!tracks || tracks.length === 0 ? (
          <div className="vlc-empty-state">
            <div className="vlc-empty-icon">
              <i className="fas fa-list-music" />
            </div>
            <p className="vlc-empty-heading">No tracks in queue</p>
            <p className="vlc-empty-hint">Add tracks from the Library tab</p>
          </div>
        ) : (
          tracks.map((track, i) => {
            const isActive = i === currentIndex;
            const isPending = pendingOps?.has(track.id) ?? false;
            const coverUri = track.coverUrl;
            const dur = formatDuration(track.duration);
            return (
              <div
                key={track.id}
                className={`vlc-queue-row${isActive ? ' vlc-queue-row--active' : ''}${isPending ? ' vlc-queue-row--pending' : ''}`}
                onClick={() => {
                  if (!isActive && !isPending && connected) onPlay(track.id);
                }}
              >
                <div className="vlc-queue-row-accent" />

                <span className="vlc-queue-num">
                  {isPending ? (
                    <i className="fas fa-spinner fa-spin" />
                  ) : (
                    i + 1
                  )}
                </span>

                <QueueCoverImage uri={coverUri} name={track.name} host={host} />

                <div className="vlc-queue-meta">
                  <span className="vlc-queue-title">{track.name}</span>
                  <div className="vlc-queue-sub-row">
                    {dur ? <span className="vlc-queue-dur">{dur}</span> : null}
                    {isActive ? <span className="vlc-queue-status">NOW</span> : null}
                  </div>
                </div>

                <button
                  className="vlc-queue-remove-btn"
                  type="button"
                  disabled={!connected || isPending}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(track.id);
                  }}
                  aria-label={`Remove ${track.name}`}
                >
                  <i className="fas fa-times" />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
