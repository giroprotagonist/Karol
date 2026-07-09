import type { LibraryTrack, VlcTrack } from '@common/VlcControllerTypes';

type VlcPlaylistSectionProps = {
  tracks: VlcTrack[];
  currentIndex: number;
  library: LibraryTrack[];
  connected: boolean;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onPlayNow: (path: string) => void;
  onEnqueue: (path: string) => void;
};

export default function VlcPlaylistSection({
  tracks,
  currentIndex,
  library,
  connected,
  searchQuery,
  onSearchChange,
  onPlayNow,
  onEnqueue,
}: VlcPlaylistSectionProps) {
  return (
    <div className="vlc-playlist-section">
      <h2>Library</h2>
      <input
        className="field"
        placeholder="Search library…"
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
      />

      <div className="vlc-library-list">
        {library.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <i className="fas fa-folder-open" />
            </div>
            <p>No tracks found</p>
          </div>
        ) : (
          library.map((track) => (
            <div key={track.path} className="vlc-library-item">
              <div className="vlc-track-meta">
                <div className="vlc-track-title">{track.title}</div>
                {track.artist ? (
                  <div className="vlc-track-artist">{track.artist}</div>
                ) : null}
              </div>
              <div className="vlc-track-actions">
                <button
                  className="btn small"
                  type="button"
                  disabled={!connected}
                  onClick={() => onPlayNow(track.path)}
                >
                  Play
                </button>
                <button
                  className="btn small"
                  type="button"
                  disabled={!connected}
                  onClick={() => onEnqueue(track.path)}
                >
                  + Queue
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="divider" />

      <h2>VLC Playlist</h2>
      <div className="vlc-library-list">
        {tracks.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <i className="fas fa-list" />
            </div>
            <p>Playlist is empty</p>
          </div>
        ) : (
          tracks.map((track, i) => (
            <div
              key={track.id}
              className={`vlc-library-item ${i === currentIndex ? 'active' : ''}`}
            >
              <div className="vlc-index">{i + 1}</div>
              <div className="vlc-track-meta">
                <div className="vlc-track-title">{track.name}</div>
              </div>
              {i === currentIndex ? (
                <span className="status-chip status-playing">Now</span>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
