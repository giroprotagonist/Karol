import { useCallback, useEffect, useRef, useState } from 'react';
import type { HardwareMixerState, LibraryTrack, VlcNowPlaying, VlcPlaylistState, VlcStatus } from '@common/VlcControllerTypes';
import {
  fetchHardwareMixer,
  fetchVlcLibrary,
  fetchVlcNowPlaying,
  fetchVlcPlaylist,
  fetchVlcStatus,
  searchVlcLibrary,
  setMicMute,
  setMicVolume,
  vlcClearQueue,
  vlcEnqueueFile,
  vlcPlayId,
  vlcRemoveFromQueue,
  vlcTransportPause,
  vlcTransportPlay,
  vlcTransportSeek,
  vlcTransportSkipNext,
  vlcTransportSkipPrev,
  vlcTransportVolume,
} from '../api';
import VlcTransportCard from './VlcTransportCard';
import VlcQueueList from './VlcQueueList';
import HardwareMixerStrip from './HardwareMixerStrip';
import AbletonMixerStrip from './AbletonMixerStrip';

type VlcSubTab = 'player' | 'queue' | 'library' | 'ableton';

function formatDuration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function LibraryCoverImg({ coverUrl, title, host }: { coverUrl?: string; title: string; host: string }) {
  const [imgErr, setImgErr] = useState(false);
  const src = coverUrl ? `${host}${coverUrl}` : '';

  if (!coverUrl || imgErr) {
    return (
      <div className="vlc-lib-thumb vlc-lib-thumb-fb">
        <i className="fas fa-music" />
      </div>
    );
  }

  return (
    <img
      className="vlc-lib-thumb"
      src={src}
      alt={title}
      loading="lazy"
      onError={() => setImgErr(true)}
    />
  );
}

type LibraryTrackRowProps = {
  track: LibraryTrack;
  connected: boolean;
  isPreviewing: boolean;
  host: string;
  onPreviewPlay: (path: string) => void;
  onPreviewStop: () => void;
  onPlayNow: (path: string) => void;
  onEnqueue: (path: string) => void;
};

function LibraryTrackRow({
  track,
  connected,
  isPreviewing,
  host,
  onPreviewPlay,
  onPreviewStop,
  onPlayNow,
  onEnqueue,
}: LibraryTrackRowProps) {
  const dur = formatDuration(track.duration);

  return (
    <div className={`vlc-library-row${isPreviewing ? ' vlc-library-row--previewing' : ''}`}>
      <div className="vlc-lib-top-row">
        <LibraryCoverImg coverUrl={track.coverUrl} title={track.title} host={host} />

        <div className="vlc-lib-meta">
          <span className="vlc-lib-title">{track.title}</span>
          <span className="vlc-lib-subtitle">
            {track.artist ? track.artist : ''}
            {track.artist && track.album ? ' · ' : ''}
            {track.album ? track.album : ''}
          </span>
          {dur ? <span className="vlc-lib-dur">{dur}</span> : null}
        </div>
      </div>

      <div className="vlc-lib-bottom-row">
        {isPreviewing ? (
          <button
            className="vlc-lib-btn vlc-lib-btn--stop"
            type="button"
            onClick={(e) => { e.stopPropagation(); onPreviewStop(); }}
            title="Stop preview"
          >
            <i className="fas fa-stop" />
            <span className="vlc-lib-btn-label">Stop</span>
          </button>
        ) : (
          <button
            className="vlc-lib-btn vlc-lib-btn--preview"
            type="button"
            disabled={!connected}
            onClick={(e) => { e.stopPropagation(); onPreviewPlay(track.path); }}
            title="Preview"
          >
            <i className="fas fa-play" />
            <span className="vlc-lib-btn-label">Preview</span>
          </button>
        )}
        <button
          className="vlc-lib-btn vlc-lib-btn--play"
          type="button"
          disabled={!connected}
          onClick={(e) => { e.stopPropagation(); onPlayNow(track.path); }}
          title="Play now in VLC"
        >
          <i className="fas fa-forward" />
          <span className="vlc-lib-btn-label">Play</span>
        </button>
        <button
          className="vlc-lib-btn vlc-lib-btn--enqueue"
          type="button"
          disabled={!connected}
          onClick={(e) => { e.stopPropagation(); onEnqueue(track.path); }}
          title="Add to queue"
        >
          <i className="fas fa-plus" />
          <span className="vlc-lib-btn-label">Queue</span>
        </button>
      </div>
    </div>
  );
}

type VlcPlayerTabProps = {
  host: string;
  connected: boolean;
};

export default function VlcPlayerTab({ host, connected }: VlcPlayerTabProps) {
  const [vlcStatus, setVlcStatus] = useState<VlcStatus | null>(null);
  const [vlcNowPlaying, setVlcNowPlaying] = useState<VlcNowPlaying | null>(null);
  const [vlcPlaylist, setVlcPlaylist] = useState<VlcPlaylistState>({ tracks: [], currentIndex: -1 });
  const [vlcLibrary, setVlcLibrary] = useState<LibraryTrack[]>([]);
  const [hardwareMixer, setHardwareMixer] = useState<HardwareMixerState | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [vlcSubTab, setVlcSubTab] = useState<VlcSubTab>('player');
  const [pendingOps, setPendingOps] = useState<Set<string>>(new Set());
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(true);

  const isPlaying = vlcStatus?.state === 'playing';

  // Load library once on mount
  useEffect(() => {
    if (!connected) {
      return;
    }
    setLibraryLoading(true);
    fetchVlcLibrary(host)
      .then((data) => setVlcLibrary(data?.tracks ?? []))
      .catch((err) => {
        console.error('Failed to load VLC library:', err);
      })
      .finally(() => setLibraryLoading(false));
  }, [host, connected]);

  // Poll VLC status
  useEffect(() => {
    if (!connected) {
      return;
    }

    let cancelled = false;

    const poll = async () => {
      try {
        const [status, np, playlist] = await Promise.all([
          fetchVlcStatus(host),
          fetchVlcNowPlaying(host),
          fetchVlcPlaylist(host),
        ]);
        if (!cancelled) {
          setVlcStatus(status);
          setVlcNowPlaying(np);
          // Defensive: ensure playlist shape is always valid — the S8 proxy may
          // return a non-object when the Mac Deskreen backend is down.
          setVlcPlaylist(
            playlist && Array.isArray((playlist as any).tracks)
              ? playlist
              : { tracks: [], currentIndex: -1 },
          );

          // Push to native bridge for VLC notification
          if (np && (window as any).KarolNative?.publishVlcNowPlaying) {
            (window as any).KarolNative.publishVlcNowPlaying(JSON.stringify({
              title: np.title || '',
              artist: np.artist || '',
              album: np.album || '',
              duration: np.duration || 0,
              position: np.position || 0,
              state: status?.state || 'stopped',
              filePath: np.filePath || '',
              id: np.id || '',
              coverUrl: np.coverUrl || '',
              isPlaying: status?.state === 'playing',
            }));
          }
        }
      } catch {
        // ignore
      }
    };

    void poll();
    const intervalMs = isPlaying ? 500 : 2000;
    const interval = setInterval(poll, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [host, connected, isPlaying]);

  // Poll hardware mixer
  useEffect(() => {
    if (!connected) {
      return;
    }

    let cancelled = false;

    const poll = async () => {
      try {
        const mixer = await fetchHardwareMixer(host);
        if (!cancelled) {
          setHardwareMixer((prev) => ({
            micVolume: mixer.micVolume,
            micMuted: mixer.micMuted,
            vlcVolume: mixer.vlcVolume ?? prev?.vlcVolume ?? 50,
          }));
        }
      } catch {
        // ignore
      }
    };

    void poll();
    const interval = setInterval(poll, 2000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [host, connected]);

  // Library search
  const handleSearch = useCallback(
    async (q: string) => {
      setSearchQuery(q);
      if (!q.trim()) {
        const data = await fetchVlcLibrary(host);
        setVlcLibrary(data?.tracks ?? []);
      } else {
        const results = await searchVlcLibrary(host, q);
        setVlcLibrary(results);
      }
    },
    [host],
  );

  const handlePlayNow = useCallback(
    async (path: string) => {
      setPendingOps((prev) => new Set(prev).add(path));
      try {
        await vlcClearQueue(host);
        await vlcEnqueueFile(host, path);
        // Give VLC a moment to process the enqueue before playing
        await new Promise((r) => setTimeout(r, 200));
        await vlcTransportPlay(host);
        const playlist = await fetchVlcPlaylist(host);
        setVlcPlaylist(playlist);
      } catch {
        const playlist = await fetchVlcPlaylist(host);
        setVlcPlaylist(playlist);
      }
      setPendingOps((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    },
    [host],
  );

  const handleEnqueue = useCallback(
    async (path: string) => {
      await vlcEnqueueFile(host, path);
      const playlist = await fetchVlcPlaylist(host);
      setVlcPlaylist(playlist);
    },
    [host],
  );

  const handleEnqueueAll = useCallback(async () => {
    // Enqueue all library tracks one by one, then refresh
    for (const track of vlcLibrary) {
      await vlcEnqueueFile(host, track.path);
    }
    const playlist = await fetchVlcPlaylist(host);
    setVlcPlaylist(playlist);
  }, [host, vlcLibrary]);

  const handleQueuePlay = useCallback(
    async (id: string) => {
      // Optimistic: update currentIndex and mark pending
      const idx = vlcPlaylist.tracks.findIndex((t) => t.id === id);
      if (idx >= 0) {
        setVlcPlaylist((prev) => ({ ...prev, currentIndex: idx }));
      }
      setPendingOps((prev) => new Set(prev).add(id));
      try {
        await vlcPlayId(host, id);
        const playlist = await fetchVlcPlaylist(host);
        setVlcPlaylist(playlist);
      } catch {
        // rollback by refreshing
        const playlist = await fetchVlcPlaylist(host);
        setVlcPlaylist(playlist);
      }
      setPendingOps((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
    [host, vlcPlaylist.tracks],
  );

  const handleQueueRemove = useCallback(
    async (id: string) => {
      // Optimistic: remove from local list
      setVlcPlaylist((prev) => ({
        ...prev,
        tracks: prev.tracks.filter((t) => t.id !== id),
      }));
      setPendingOps((prev) => new Set(prev).add(id));
      try {
        await vlcRemoveFromQueue(host, id);
        const playlist = await fetchVlcPlaylist(host);
        setVlcPlaylist(playlist);
      } catch {
        const playlist = await fetchVlcPlaylist(host);
        setVlcPlaylist(playlist);
      }
      setPendingOps((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
    [host],
  );

  const handleQueueClear = useCallback(async () => {
    // Optimistic: clear now
    setVlcPlaylist({ tracks: [], currentIndex: -1 });
    try {
      await vlcClearQueue(host);
      const playlist = await fetchVlcPlaylist(host);
      setVlcPlaylist(playlist);
    } catch {
      const playlist = await fetchVlcPlaylist(host);
      setVlcPlaylist(playlist);
    }
  }, [host]);

  // Listen for native VLC now-playing pushes from notification service
  useEffect(() => {
    const win = window as any;
    if (!win.__karolNativeVlcNowPlaying) {
      win.__karolNativeVlcNowPlaying = (json: string) => {
        try {
          const d = JSON.parse(json);
          setVlcNowPlaying({
            title: d.title || '',
            artist: d.artist,
            album: d.album,
            duration: d.duration || 0,
            position: d.position || 0,
            filePath: d.filePath,
            id: d.id,
            coverUrl: d.coverUrl,
          });
          setVlcStatus((prev) => ({
            ...(prev || { state: 'stopped', position: 0, duration: 0, volume: 128, time: 0, length: 0, fullscreen: false, loop: false, random: false, repeat: false }),
            state: d.isPlaying ? 'playing' : d.state === 'paused' ? 'paused' : 'stopped',
          }));
        } catch {
          // ignore
        }
      };
    }
  }, []);

  // Preview audio — cleanup on stop or unmount
  useEffect(() => {
    if (previewPath) return;
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.src = '';
      previewAudioRef.current = null;
    }
  }, [previewPath]);

  const handlePreviewPlay = useCallback((filePath: string) => {
    // Stop any currently playing preview first
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.src = '';
    }
    const src = `${host}/api/vlc-dj/audio?path=${encodeURIComponent(filePath)}`;
    const audio = new Audio(src);
    audio.volume = 0.7;
    previewAudioRef.current = audio;
    setPreviewPath(filePath);
    // play() must be called directly in the click handler to preserve
    // the user-gesture context on Android WebView.
    audio.play().catch((err) => {
      console.warn('Preview autoplay blocked:', err);
    });
  }, [host]);

  const handlePreviewStop = useCallback(() => {
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.src = '';
      previewAudioRef.current = null;
    }
    setPreviewPath(null);
  }, []);

  return (
    <div className="vlc-tab-wrapper">
      <nav className="vlc-subtab-nav">
        <button
          type="button"
          className={`vlc-subtab-btn ${vlcSubTab === 'player' ? 'active' : ''}`}
          onClick={() => setVlcSubTab('player')}
        >
          <i className="fas fa-play-circle" /> Player
        </button>
        <button
          type="button"
          className={`vlc-subtab-btn ${vlcSubTab === 'queue' ? 'active' : ''}`}
          onClick={() => setVlcSubTab('queue')}
        >
          <i className="fas fa-list-ol" /> Queue
        </button>
        <button
          type="button"
          className={`vlc-subtab-btn ${vlcSubTab === 'library' ? 'active' : ''}`}
          onClick={() => setVlcSubTab('library')}
        >
          <i className="fas fa-folder-open" /> Library
        </button>
        <button
          type="button"
          className={`vlc-subtab-btn ${vlcSubTab === 'ableton' ? 'active' : ''}`}
          onClick={() => setVlcSubTab('ableton')}
        >
          <i className="fas fa-sliders-h" /> Ableton
        </button>
      </nav>

      {vlcSubTab === 'player' ? (
        <div className="vlc-tab-layout">
          <div className="vlc-main-col">
            <VlcTransportCard
              nowPlaying={vlcNowPlaying}
              status={vlcStatus}
              connected={connected}
              host={host}
              onPlay={() => vlcTransportPlay(host)}
              onPause={() => vlcTransportPause(host)}
              onSkipNext={() => vlcTransportSkipNext(host)}
              onSkipPrev={() => vlcTransportSkipPrev(host)}
              onSeek={(seconds) => vlcTransportSeek(host, seconds)}
              onVolumeChange={(level) => vlcTransportVolume(host, level)}
            />
          </div>

          <HardwareMixerStrip
            mixer={hardwareMixer}
            connected={connected}
            onMicVolumeChange={(level) => {
              setHardwareMixer((prev) =>
                prev ? { ...prev, micVolume: level } : { micVolume: level, micMuted: false },
              );
              setMicVolume(host, level);
            }}
            onMicMuteToggle={() => {
              const newMuted = !(hardwareMixer?.micMuted ?? false);
              setHardwareMixer((prev) =>
                prev ? { ...prev, micMuted: newMuted } : { micVolume: 50, micMuted: newMuted },
              );
              setMicMute(host, newMuted);
            }}
            onVlcVolumeChange={(level) => {
              setHardwareMixer((prev) =>
                prev
                  ? { ...prev, vlcVolume: level }
                  : { micVolume: 50, micMuted: false, vlcVolume: level },
              );
              vlcTransportVolume(host, level);
            }}
          />
        </div>
      ) : vlcSubTab === 'queue' ? (
        <div className="vlc-tab-layout">
          <div className="vlc-main-col">
            <VlcQueueList
              tracks={vlcPlaylist.tracks}
              currentIndex={vlcPlaylist.currentIndex}
              connected={connected}
              host={host}
              pendingOps={pendingOps}
              onPlay={handleQueuePlay}
              onRemove={handleQueueRemove}
              onClear={handleQueueClear}
            />
          </div>
        </div>
      ) : vlcSubTab === 'library' ? (
        <div className="vlc-tab-layout">
          <div className="vlc-main-col">
            <div className="card vlc-library-card">
              <div className="card-header">
                <h2>
                  Library
                  {!libraryLoading && vlcLibrary.length > 0 && (
                    <span className="vlc-library-count">{vlcLibrary.length}</span>
                  )}
                </h2>
                <button
                  className="btn small enqueue-all-btn"
                  type="button"
                  disabled={!connected || vlcLibrary.length === 0}
                  onClick={handleEnqueueAll}
                >
                  <i className="fas fa-plus" /> Enqueue All
                </button>
              </div>

              <div className="vlc-library-search-wrap">
                <i className="fas fa-search vlc-search-icon" />
                <input
                  className="vlc-search-input"
                  placeholder="Search tracks, artists, albums…"
                  value={searchQuery}
                  onChange={(e) => handleSearch(e.target.value)}
                />
                {searchQuery && (
                  <button
                    className="vlc-search-clear"
                    type="button"
                    onClick={() => handleSearch('')}
                    aria-label="Clear search"
                  >
                    <i className="fas fa-times" />
                  </button>
                )}
              </div>

              <div className="vlc-library-list">
                {libraryLoading ? (
                  Array.from({ length: 6 }).map((_, i) => (
                    <div key={`skel-${i}`} className="vlc-library-row vlc-library-skeleton">
                      <div className="vlc-lib-top-row">
                        <div className="vlc-lib-thumb-skel pulse" />
                        <div className="vlc-lib-meta">
                          <div className="vlc-skel-line w-70 pulse" />
                          <div className="vlc-skel-line w-40 pulse" />
                          <div className="vlc-skel-line w-30 pulse" />
                        </div>
                      </div>
                      <div className="vlc-lib-bottom-row" style={{justifyContent:'center', gap:12}}>
                        <div className="vlc-skel-line w-30 pulse" />
                        <div className="vlc-skel-line w-30 pulse" />
                        <div className="vlc-skel-line w-30 pulse" />
                      </div>
                    </div>
                  ))
                ) : vlcLibrary.length === 0 ? (
                  <div className="vlc-empty-state">
                    <div className="vlc-empty-icon">
                      <i className="fas fa-folder-open" />
                    </div>
                    <p className="vlc-empty-heading">
                      {searchQuery ? 'No tracks match your search' : 'No tracks found'}
                    </p>
                    <p className="vlc-empty-hint">
                      {searchQuery
                        ? 'Try a different search term'
                        : 'Add audio files to your music library folder'}
                    </p>
                  </div>
                ) : (
                  vlcLibrary.map((track) => {
                    const isPreviewing = previewPath === track.path;
                    return (
                      <LibraryTrackRow
                        key={track.path}
                        track={track}
                        connected={connected}
                        isPreviewing={isPreviewing}
                        host={host}
                        onPreviewPlay={handlePreviewPlay}
                        onPreviewStop={handlePreviewStop}
                        onPlayNow={handlePlayNow}
                        onEnqueue={handleEnqueue}
                      />
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <AbletonMixerStrip host={host} connected={connected} />
      )}
    </div>
  );
}
