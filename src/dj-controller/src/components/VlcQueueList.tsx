import type { VlcTrack } from '@common/VlcControllerTypes';

type VlcQueueListProps = {
  tracks: VlcTrack[];
  currentIndex: number;
  connected: boolean;
  onPlay: (id: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
};

export default function VlcQueueList({
  tracks,
  currentIndex,
  connected,
  onPlay,
  onRemove,
  onClear,
}: VlcQueueListProps) {
  return (
    <div className="card queue-card">
      <div className="card-header">
        <h2>VLC Queue ({tracks.length})</h2>
        <button
          className="btn small danger-subtle"
          type="button"
          disabled={!connected || tracks.length === 0}
          onClick={onClear}
        >
          Clear
        </button>
      </div>

      <div className="queue-list">
        {tracks.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <i className="fas fa-list" />
            </div>
            <p>Queue is empty</p>
          </div>
        ) : (
          tracks.map((track, i) => (
            <div
              key={track.id}
              className={`queue-item ${i === currentIndex ? 'active' : ''}`}
            >
              <div className="queue-leading-col">
                <span className="queue-index">{i + 1}</span>
                <div className="queue-leading-actions">
                  <button
                    className="queue-row-btn play"
                    type="button"
                    disabled={!connected || i === currentIndex}
                    onClick={() => onPlay(track.id)}
                    aria-label={`Play ${track.name}`}
                  >
                    <i className="fas fa-play" />
                  </button>
                  <button
                    className="queue-row-btn remove"
                    type="button"
                    disabled={!connected}
                    onClick={() => onRemove(track.id)}
                    aria-label={`Remove ${track.name}`}
                  >
                    <i className="fas fa-times" />
                  </button>
                </div>
              </div>
              <div className="queue-item-body">
                <p className="queue-title-full">{track.name}</p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
