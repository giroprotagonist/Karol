import type { HardwareMixerState } from '@common/VlcControllerTypes';

type HardwareMixerStripProps = {
  mixer: HardwareMixerState | null;
  connected: boolean;
  onMicVolumeChange: (level: number) => void;
  onMicMuteToggle: () => void;
  onVlcVolumeChange: (level: number) => void;
};

export default function HardwareMixerStrip({
  mixer,
  connected,
  onMicVolumeChange,
  onMicMuteToggle,
  onVlcVolumeChange,
}: HardwareMixerStripProps) {
  const micVolume = mixer?.micVolume ?? 50;
  const micMuted = mixer?.micMuted ?? false;

  return (
    <div className="hardware-mixer-strip">
      <h2>Mixer</h2>

      <div className="mic-fader">
        <label className="fader-label">
          <i className="fas fa-microphone" /> Mic
        </label>
        <input
          className="volume"
          type="range"
          min={0}
          max={100}
          step={1}
          value={micVolume}
          disabled={!connected}
          onChange={(e) => onMicVolumeChange(Number(e.target.value))}
          style={{ '--progress': `${micVolume}%` } as React.CSSProperties}
        />
        <span className="fader-value">{micVolume}%</span>
      </div>

      <button
        className={`mic-mute-btn ${micMuted ? 'muted' : 'unmuted'}`}
        type="button"
        disabled={!connected}
        onClick={onMicMuteToggle}
      >
        {micMuted ? 'Unmute' : 'Mute'}
      </button>

      <div className="divider" />

      <div className="vlc-volume-fader">
        <label className="fader-label">
          <i className="fas fa-volume-up" /> VLC Out
        </label>
        <input
          className="volume"
          type="range"
          min={0}
          max={100}
          step={1}
          value={mixer?.vlcVolume ?? 50}
          disabled={!connected}
          onChange={(e) => onVlcVolumeChange(Number(e.target.value))}
          style={{ '--progress': `${mixer?.vlcVolume ?? 50}%` } as React.CSSProperties}
        />
        <span className="fader-value">{mixer?.vlcVolume ?? 50}%</span>
      </div>
    </div>
  );
}
