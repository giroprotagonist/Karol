import type { CSSProperties } from 'react';
import type { YouTubeDjNowPlaying, YouTubeKaraokeState } from '@common/YouTubeKaraokeTypes';
import { formatTime } from '../api';

const YT_STATES: Record<number, string> = {
	'-2': 'Loading',
	'-1': 'Error',
	0: 'Ended',
	1: 'Playing',
	2: 'Paused',
	3: 'Buffering',
	5: 'Cued',
};

type NowPlayingCardProps = {
	title: string;
	videoId: string;
	thumbnail: string;
	nowPlaying: YouTubeDjNowPlaying | null;
	queueState: YouTubeKaraokeState | null;
	connected: boolean;
	busy: boolean;
	volume: number;
	autoAdvance: boolean;
	manualMode: boolean;
	onPlayPause: () => void;
	onSkipPrev: () => void;
	onSkipNext: () => void;
	onSeekRelative: (delta: number) => void;
	onSeek: (seconds: number) => void;
	onVolumeChange: (level: number) => void;
	onAutoAdvanceChange: (enabled: boolean) => void;
	onManualModeChange: (enabled: boolean) => void;
};

function youtubeThumb(videoId: string, thumbnail?: string): string {
	if (thumbnail) {
		return thumbnail;
	}
	if (videoId) {
		return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
	}
	return '';
}

export default function NowPlayingCard({
	title,
	videoId,
	thumbnail,
	nowPlaying,
	queueState,
	connected,
	busy,
	volume,
	autoAdvance,
	manualMode,
	onPlayPause,
	onSkipPrev,
	onSkipNext,
	onSeekRelative,
	onSeek,
	onVolumeChange,
	onAutoAdvanceChange,
	onManualModeChange,
}: NowPlayingCardProps) {
	const currentTime = nowPlaying?.currentTime ?? queueState?.currentTime ?? 0;
	const duration = nowPlaying?.duration ?? queueState?.duration ?? 0;
	const state = nowPlaying?.state ?? -2;
	const isPlaying = state === 1;
	const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
	const thumbSrc = youtubeThumb(videoId, thumbnail);
	const modeLabel = queueState?.mode === 'hotswap' ? 'Hotswap' : queueState?.mode === 'manual' ? 'Manual' : 'Queue';

	return (
		<div className="card now-playing-card">
			<div className="now-playing-hero">
				{thumbSrc ? (
					<img className="now-playing-art" src={thumbSrc} alt="" />
				) : (
					<div className="now-playing-art placeholder">
						<span>♪</span>
					</div>
				)}
				<div className="now-playing-overlay">
					<span className={`playback-badge ${isPlaying ? 'live' : ''}`}>
						{YT_STATES[state] || 'Loading'}
					</span>
					<span className="mode-badge">{modeLabel}</span>
				</div>
			</div>

			<div className="now-playing-info">
				<h2 className="now-playing-title">{title}</h2>
				<div className="scrubber-wrap">
					<input
						className="scrubber"
						type="range"
						min={0}
						max={duration || 1}
						step={1}
						value={Math.min(currentTime, duration || 0)}
						disabled={!connected || duration <= 0}
						onChange={(e) => onSeek(Number(e.target.value))}
						style={{ '--progress': `${progress}%` } as CSSProperties}
					/>
					<div className="scrubber-times">
						<span>{formatTime(currentTime)}</span>
						<span>{formatTime(duration)}</span>
					</div>
				</div>
			</div>

			<div className="transport">
				<button
					className="btn transport-btn"
					type="button"
					disabled={!connected || busy}
					onClick={onSkipPrev}
					aria-label="Previous"
				>
					⏮
				</button>
				<button
					className="btn transport-btn"
					type="button"
					disabled={!connected || busy}
					onClick={() => onSeekRelative(-10)}
				>
					−10
				</button>
				<button
					className="btn transport-btn primary large"
					type="button"
					disabled={!connected || busy}
					onClick={onPlayPause}
					aria-label={isPlaying ? 'Pause' : 'Play'}
				>
					{isPlaying ? '⏸' : '▶'}
				</button>
				<button
					className="btn transport-btn"
					type="button"
					disabled={!connected || busy}
					onClick={() => onSeekRelative(10)}
				>
					+10
				</button>
				<button
					className="btn transport-btn"
					type="button"
					disabled={!connected || busy}
					onClick={onSkipNext}
					aria-label="Next"
				>
					⏭
				</button>
			</div>

			<div className="volume-row">
				<span className="volume-icon" aria-hidden>
					{volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}
				</span>
				<input
					className="volume"
					type="range"
					min={0}
					max={1}
					step={0.05}
					value={volume}
					disabled={!connected}
					onChange={(e) => onVolumeChange(Number(e.target.value))}
					style={{ '--progress': `${volume * 100}%` } as CSSProperties}
				/>
				<span className="volume-value">{Math.round(volume * 100)}%</span>
			</div>

			<div className="mode-toggles">
				<label className="toggle-pill">
					<input
						type="checkbox"
						checked={autoAdvance}
						disabled={!connected || manualMode}
						onChange={(e) => onAutoAdvanceChange(e.target.checked)}
					/>
					<span>Auto-advance</span>
				</label>
				<label className="toggle-pill">
					<input
						type="checkbox"
						checked={manualMode}
						disabled={!connected}
						onChange={(e) => onManualModeChange(e.target.checked)}
					/>
					<span>Manual DJ</span>
				</label>
			</div>
		</div>
	);
}
