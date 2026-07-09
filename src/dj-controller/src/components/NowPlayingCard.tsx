import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type PointerEvent } from 'react';
import type { YouTubeDjNowPlaying, YouTubeKaraokeState } from '@common/YouTubeKaraokeTypes';
import { formatTime } from '../api';
import TrackTitle from './TrackTitle';
import {
	IconPause,
	IconPlay,
	IconSkipNext,
	IconSkipPrev,
	IconVolumeHigh,
	IconVolumeLow,
	IconVolumeMute,
} from './TransportIcons';

function playbackBadge(state: number | undefined, hasTrack: boolean): string | null {
	if (state === 1) {
		return 'Playing';
	}
	if (state === 2) {
		return 'Paused';
	}
	if (state === 0) {
		return 'Ended';
	}
	if (hasTrack) {
		return null;
	}
	return null;
}

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
	shuffleEnabled: boolean;
	displayTime?: number;
	onPlayPause: () => void;
	onSkipPrev: () => void;
	onSkipNext: () => void;
	onSeekRelative: (delta: number) => void;
	onSeek: (seconds: number) => void;
	onScrubActiveChange?: (active: boolean) => void;
	onVolumeChange: (level: number) => void;
	onAutoAdvanceChange: (enabled: boolean) => void;
	onManualModeChange: (enabled: boolean) => void;
	onShuffleChange: (enabled: boolean) => void;
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
	shuffleEnabled,
	displayTime,
	onPlayPause,
	onSkipPrev,
	onSkipNext,
	onSeekRelative,
	onSeek,
	onScrubActiveChange,
	onVolumeChange,
	onAutoAdvanceChange,
	onManualModeChange,
	onShuffleChange,
}: NowPlayingCardProps) {
	const serverTime = displayTime ?? nowPlaying?.currentTime ?? queueState?.currentTime ?? 0;
	const duration = nowPlaying?.duration ?? queueState?.duration ?? 0;
	const state = nowPlaying?.state;
	const hasTrack = Boolean(videoId || title);
	const isPlaying = state === 1;
	const badge = playbackBadge(state, hasTrack);
	const [scrubTime, setScrubTime] = useState<number | null>(null);
	const [isScrubbing, setIsScrubbing] = useState(false);
	const scrubValueRef = useRef(0);
	const commitGuardRef = useRef(false);
	const currentTime = isScrubbing && scrubTime !== null ? scrubTime : serverTime;
	const progress =
		duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
	const thumbSrc = youtubeThumb(videoId, thumbnail);
	const modeLabel =
		shuffleEnabled && queueState?.mode === 'queue'
			? 'Shuffle'
			: queueState?.mode === 'hotswap'
				? 'Hotswap'
				: queueState?.mode === 'manual'
					? 'Manual'
					: 'Queue';
	const scrubMax = Math.max(duration, 1);
	const scrubValue = Math.min(Math.max(0, currentTime), duration > 0 ? duration : scrubMax);
	scrubValueRef.current = scrubValue;

	useEffect(() => {
		if (!isScrubbing) {
			setScrubTime(null);
		}
	}, [serverTime, duration, videoId, isScrubbing]);

	const logScrub = (message: string, data: Record<string, unknown>) => {
		// #region agent log
		window.KarolNative?.ctrlDbg?.('H10', message, JSON.stringify(data));
		fetch('http://127.0.0.1:7592/ingest/808d4931-5ef3-48a2-9797-d856a57d6e0a', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Debug-Session-Id': '25b906',
			},
			body: JSON.stringify({
				sessionId: '25b906',
				hypothesisId: 'H10',
				location: 'NowPlayingCard.tsx',
				message,
				data,
				timestamp: Date.now(),
			}),
		}).catch(() => {});
		// #endregion
	};

	const armScrub = (initial?: number) => {
		if (!connected || !hasTrack || duration <= 0) {
			return false;
		}
		if (!isScrubbing) {
			setIsScrubbing(true);
			commitGuardRef.current = false;
			onScrubActiveChange?.(true);
			logScrub('scrub-begin', { serverTime, initial: initial ?? scrubValue });
		}
		if (initial !== undefined) {
			setScrubTime(initial);
		}
		return true;
	};

	const beginScrub = () => {
		armScrub(scrubValue);
	};

	const updateScrub = (value: number) => {
		if (!armScrub()) {
			return;
		}
		const capped = duration > 0 ? Math.min(Math.max(0, value), duration) : Math.max(0, value);
		scrubValueRef.current = capped;
		setScrubTime(capped);
	};

	const commitScrub = (inputValue?: number) => {
		if (commitGuardRef.current) {
			return;
		}
		const target =
			inputValue ??
			scrubTime ??
			scrubValueRef.current;
		if (!Number.isFinite(target)) {
			setIsScrubbing(false);
			onScrubActiveChange?.(false);
			return;
		}
		if (!isScrubbing && inputValue === undefined) {
			return;
		}
		commitGuardRef.current = true;
		logScrub('scrub-commit', { target, serverTime, inputValue, scrubTime });
		setIsScrubbing(false);
		setScrubTime(null);
		onScrubActiveChange?.(false);
		onSeek(target);
		window.setTimeout(() => {
			commitGuardRef.current = false;
		}, 250);
	};

	const handleScrubChange = (event: ChangeEvent<HTMLInputElement>) => {
		const value = Number(event.currentTarget.value);
		updateScrub(value);
		// Also commit on onChange — Android WebView may not fire onTouchEnd/onPointerUp
		// reliably for range inputs. commitGuard prevents duplicate commits.
		commitScrub(value);
	};

	const cancelScrub = (event: PointerEvent<HTMLInputElement>) => {
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
		commitScrub(Number(event.currentTarget.value));
	};

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
					{badge ? (
						<span className={`playback-badge ${isPlaying ? 'live' : ''}`}>{badge}</span>
					) : null}
					<span className="mode-badge">{modeLabel}</span>
				</div>
			</div>

			<div className="now-playing-info">
				<TrackTitle text={title || 'Nothing playing'} className="now-playing-title" clampLines={5} />
				<div className="scrubber-wrap">
					<input
						className="scrubber"
						type="range"
						min={0}
						max={scrubMax}
						step={1}
						value={scrubValue}
						disabled={!connected || !hasTrack || duration <= 0 || busy}
						onPointerDown={beginScrub}
						onTouchStart={(_e) => {
							beginScrub();
						}}
						onPointerUp={cancelScrub}
						onPointerCancel={cancelScrub}
						onTouchEnd={(e) => {
							commitScrub(Number(e.currentTarget.value));
						}}
						onInput={(e) => updateScrub(Number(e.currentTarget.value))}
						onChange={handleScrubChange}
						aria-label="Seek"
						style={{ '--progress': `${progress}%` } as CSSProperties}
					/>
					<div className="scrubber-times">
						<span>{formatTime(currentTime)}</span>
						<span>{duration > 0 ? formatTime(duration) : '--:--'}</span>
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
					<IconSkipPrev className="transport-icon" />
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
					{isPlaying ? (
						<IconPause className="transport-icon" />
					) : (
						<IconPlay className="transport-icon" />
					)}
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
					<IconSkipNext className="transport-icon" />
				</button>
			</div>

			<div className="volume-row">
				<span className="volume-icon" aria-hidden>
					{volume === 0 ? (
						<IconVolumeMute className="transport-icon" />
					) : volume < 0.5 ? (
						<IconVolumeLow className="transport-icon" />
					) : (
						<IconVolumeHigh className="transport-icon" />
					)}
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
						checked={shuffleEnabled}
						disabled={!connected || manualMode}
						onChange={(e) => onShuffleChange(e.target.checked)}
					/>
					<span>Shuffle</span>
				</label>
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
