import { useCallback, useEffect, useRef, useState } from 'react';
import type { AbletonState } from '@common/AbletonTypes';

type Props = {
  host: string;
  connected: boolean;
  pollIntervalMs?: number;
};

const DEFAULT_POLL = 2000;

export type { AbletonState };

export default function AbletonMixerStrip({ host, connected, pollIntervalMs = DEFAULT_POLL }: Props) {
  const [state, setState] = useState<AbletonState>({
    connected: false,
    playing: false,
    tempo: 120,
    tracks: [],
    masterVolume: 0.85,
  });
  const [localTempo, setLocalTempo] = useState(120);
  const [localMaster, setLocalMaster] = useState(0.85);
  const [trackLevels, setTrackLevels] = useState<number[]>([0.75, 0.75]);
  const [trackMutes, setTrackMutes] = useState<boolean[]>([false, false]);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const debounceRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // ── Labels for our 2 configured tracks ─────────────────────────────
  const TRACK_LABELS = ['Karaoke / DJ', 'VLC Playlist'];

  // ── Poll ───────────────────────────────────────────────────────────
  const poll = useCallback(async () => {
    if (!host) return;
    try {
      const res = await fetch(`${host}/api/ableton/state`);
      if (res.ok) {
        const data: AbletonState = await res.json();
        setState(data);
        if (data.connected) {
          setLocalTempo(data.tempo);
          setLocalMaster(data.masterVolume);
          if (data.tracks.length > 0) {
            const vols = data.tracks.map((t) => t.volume);
            const mts = data.tracks.map((t) => t.muted);
            while (vols.length < 2) vols.push(0.75);
            while (mts.length < 2) mts.push(false);
            setTrackLevels(vols.slice(0, 2));
            setTrackMutes(mts.slice(0, 2));
          }
        }
      }
    } catch {
      setState((prev) => ({ ...prev, connected: false }));
    }
  }, [host]);

  useEffect(() => {
    if (connected) {
      poll();
      timerRef.current = setInterval(poll, pollIntervalMs);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [connected, poll, pollIntervalMs]);

  // ── Debounced send ─────────────────────────────────────────────────
  const send = useCallback(
    (url: string, body?: unknown) => {
      if (!host) return;
      setLoading(true);
      fetch(url, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
        .catch(() => {})
        .finally(() => setLoading(false));
    },
    [host],
  );

  // ── Track volume (debounced) ───────────────────────────────────────
  const handleTrackVolume = useCallback(
    (idx: number, level: number) => {
      setTrackLevels((prev) => {
        const next = [...prev];
        next[idx] = level;
        return next;
      });
      const key = `vol-${idx}`;
      if (debounceRef.current[key]) clearTimeout(debounceRef.current[key]);
      debounceRef.current[key] = setTimeout(() => {
        send(`${host}/api/ableton/track/${idx}/volume?level=${level}`);
      }, 80);
    },
    [host, send],
  );

  // ── Mute toggle ────────────────────────────────────────────────────
  const handleMute = useCallback(
    (idx: number) => {
      const newVal = !trackMutes[idx];
      setTrackMutes((prev) => {
        const next = [...prev];
        next[idx] = newVal;
        return next;
      });
      send(`${host}/api/ableton/track/${idx}/mute`, { muted: newVal });
    },
    [host, send, trackMutes],
  );

  // ── Master volume (debounced) ──────────────────────────────────────
  const handleMasterVolume = useCallback(
    (level: number) => {
      setLocalMaster(level);
      const key = 'master';
      if (debounceRef.current[key]) clearTimeout(debounceRef.current[key]);
      debounceRef.current[key] = setTimeout(() => {
        send(`${host}/api/ableton/master/volume?level=${level}`);
      }, 80);
    },
    [host, send],
  );

  // ── Tempo ──────────────────────────────────────────────────────────
  const handleTempo = useCallback(
    (bpm: number) => {
      setLocalTempo(bpm);
      const key = 'tempo';
      if (debounceRef.current[key]) clearTimeout(debounceRef.current[key]);
      debounceRef.current[key] = setTimeout(() => {
        send(`${host}/api/ableton/tempo?bpm=${bpm}`);
      }, 200);
    },
    [host, send],
  );

  // ── Transport ──────────────────────────────────────────────────────
  const handlePlay = useCallback(() => send(`${host}/api/ableton/transport/play`), [host, send]);
  const handleStop = useCallback(() => send(`${host}/api/ableton/transport/stop`), [host, send]);

  // ── Connection badge ───────────────────────────────────────────────
  const abletonConnected = state.connected;

  return (
    <div className="ableton-card card">
      <div className="card-header">
        <h2>Ableton Mixer</h2>
        <span className={`ableton-status ${abletonConnected ? 'connected' : 'disconnected'}`}>
          {abletonConnected ? '● Connected' : '○ Not Found'}
        </span>
      </div>

      {/* ── Transport + Tempo ── */}
      <div className="ableton-transport">
        <div className="ableton-transport-btns">
          <button
            className={`btn ${state.playing ? 'btn-primary' : 'btn-default'}`}
            type="button"
            disabled={!abletonConnected}
            onClick={handlePlay}
          >
            <i className="fas fa-play" /> Play
          </button>
          <button
            className="btn btn-default"
            type="button"
            disabled={!abletonConnected}
            onClick={handleStop}
          >
            <i className="fas fa-stop" /> Stop
          </button>
        </div>
        <div className="ableton-tempo">
          <label htmlFor="ableton-tempo-slider">
            Tempo: <strong>{localTempo}</strong> BPM
          </label>
          <input
            id="ableton-tempo-slider"
            type="range"
            min={20}
            max={250}
            step={1}
            value={localTempo}
            disabled={!abletonConnected}
            onChange={(e) => handleTempo(Number(e.target.value))}
          />
        </div>
      </div>

      {/* ── Track strips (Karaoke + VLC) ── */}
      <div className="ableton-strips">
        {[0, 1].map((idx) => (
          <div key={idx} className="ableton-channel">
            <div className="ableton-channel-header">
              <span className="ableton-channel-label">{TRACK_LABELS[idx] ?? `Track ${idx + 1}`}</span>
              <span className="ableton-channel-vol">{Math.round(trackLevels[idx] * 100)}%</span>
            </div>

            <div className="ableton-fader-wrap">
              <input
                type="range"
                className="ableton-fader"
                min={0}
                max={1}
                step={0.01}
                value={trackLevels[idx]}
                disabled={!abletonConnected}
                onChange={(e) => handleTrackVolume(idx, Number(e.target.value))}
              />
            </div>

            <button
              type="button"
              className={`ableton-mute-btn btn small ${trackMutes[idx] ? 'btn-danger' : 'btn-default'}`}
              disabled={!abletonConnected}
              onClick={() => handleMute(idx)}
            >
              <i className={`fas ${trackMutes[idx] ? 'fa-volume-mute' : 'fa-volume-up'}`} />{' '}
              {trackMutes[idx] ? 'Unmute' : 'Mute'}
            </button>
          </div>
        ))}
      </div>

      {/* ── Master fader ── */}
      <div className="ableton-master">
        <div className="ableton-channel-header">
          <span className="ableton-channel-label">Master</span>
          <span className="ableton-channel-vol">{Math.round(localMaster * 100)}%</span>
        </div>
        <div className="ableton-fader-wrap">
          <input
            type="range"
            className="ableton-fader ableton-fader--master"
            min={0}
            max={1}
            step={0.01}
            value={localMaster}
            disabled={!abletonConnected}
            onChange={(e) => handleMasterVolume(Number(e.target.value))}
          />
        </div>
      </div>

      {loading && (
        <div className="ableton-loading">Sending...</div>
      )}
    </div>
  );
}
