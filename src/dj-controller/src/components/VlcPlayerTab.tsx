import { useCallback, useEffect, useState } from 'react';
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
  vlcTransportPause,
  vlcTransportPlay,
  vlcTransportSeek,
  vlcTransportSkipNext,
  vlcTransportSkipPrev,
  vlcTransportVolume,
} from '../api';
import VlcTransportCard from './VlcTransportCard';
import VlcPlaylistSection from './VlcPlaylistSection';
import HardwareMixerStrip from './HardwareMixerStrip';

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

  const isPlaying = vlcStatus?.state === 'playing';

  // Load library once on mount
  useEffect(() => {
    if (!connected) {
      return;
    }
    fetchVlcLibrary(host)
      .then((data) => setVlcLibrary(data.tracks))
      .catch(() => {
        // ignore
      });
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
          setVlcPlaylist(playlist);
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
        setVlcLibrary(data.tracks);
      } else {
        const results = await searchVlcLibrary(host, q);
        setVlcLibrary(results);
      }
    },
    [host],
  );

  const handlePlayNow = useCallback(
    async (path: string) => {
      await vlcClearQueue(host);
      await vlcEnqueueFile(host, path);
      const playlist = await fetchVlcPlaylist(host);
      setVlcPlaylist(playlist);
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

  return (
    <div className="vlc-tab-layout">
      <div className="vlc-main-col">
        <VlcTransportCard
          nowPlaying={vlcNowPlaying}
          status={vlcStatus}
          connected={connected}
          onPlay={() => vlcTransportPlay(host)}
          onPause={() => vlcTransportPause(host)}
          onSkipNext={() => vlcTransportSkipNext(host)}
          onSkipPrev={() => vlcTransportSkipPrev(host)}
          onSeek={(seconds) => vlcTransportSeek(host, seconds)}
          onVolumeChange={(level) => vlcTransportVolume(host, level)}
        />

        <VlcPlaylistSection
          tracks={vlcPlaylist.tracks}
          currentIndex={vlcPlaylist.currentIndex}
          library={vlcLibrary}
          connected={connected}
          searchQuery={searchQuery}
          onSearchChange={handleSearch}
          onPlayNow={handlePlayNow}
          onEnqueue={handleEnqueue}
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
            prev ? { ...prev, vlcVolume: level } : { micVolume: 50, micMuted: false, vlcVolume: level },
          );
          vlcTransportVolume(host, level);
        }}
      />
    </div>
  );
}
