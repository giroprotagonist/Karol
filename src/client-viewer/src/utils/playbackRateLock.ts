import { getReceiverControlModePreference } from './receiverControlModePreference';
import { getReceiverQualityBufferPreference } from './receiverQualityBufferPreference';
import isReceiverMode from './isReceiverMode';

const TARGET_RATE = 1;

/** Clamp only pathological chipmunk / extreme slowdown. */
const EXTREME_MIN_RATE = 0.5;
const EXTREME_MAX_RATE = 1.5;

let rateLockResetCount = 0;

function lockPlaybackRateStrict(video: HTMLVideoElement): void {
	if (
		video.playbackRate === TARGET_RATE &&
		video.defaultPlaybackRate === TARGET_RATE
	) {
		return;
	}

	const previousRate = video.playbackRate;
	video.defaultPlaybackRate = TARGET_RATE;
	video.playbackRate = TARGET_RATE;

	rateLockResetCount += 1;
	if (rateLockResetCount === 1 || rateLockResetCount % 10 === 0) {
		console.warn(
			'[RATE_LOCK] resetting playbackRate from',
			previousRate,
			'to 1.0 (count=',
			rateLockResetCount,
			')',
		);
	}
}

function lockPlaybackRateWithQualityBuffer(video: HTMLVideoElement): void {
	const rate = video.playbackRate;
	if (rate >= EXTREME_MIN_RATE && rate <= EXTREME_MAX_RATE) {
		return;
	}
	video.defaultPlaybackRate = TARGET_RATE;
	video.playbackRate = TARGET_RATE;
	console.warn('[RATE_LOCK] clamped extreme playbackRate', rate, 'to 1.0');
}

function shouldUseRelaxedRateLock(): boolean {
	if (getReceiverControlModePreference()) {
		return false;
	}
	if (isReceiverMode() && getReceiverQualityBufferPreference()) {
		return true;
	}
	return getReceiverQualityBufferPreference();
}

function lockPlaybackRate(video: HTMLVideoElement): void {
	if (shouldUseRelaxedRateLock()) {
		lockPlaybackRateWithQualityBuffer(video);
		return;
	}
	lockPlaybackRateStrict(video);
}

/**
 * Pin HTMLMediaElement playback speed to 1.0 in low-latency mode.
 * When quality buffer is enabled, allow mild rate variation so Chromium's
 * jitter buffer can absorb WiFi jitter without fighting every frame.
 */
export function initPlaybackRateLock(video: HTMLVideoElement): () => void {
	video.defaultPlaybackRate = TARGET_RATE;
	video.playbackRate = TARGET_RATE;

	if ('preservesPitch' in video) {
		(video as HTMLVideoElement & { preservesPitch: boolean }).preservesPitch =
			true;
	}
	if ('webkitPreservesPitch' in video) {
		(
			video as HTMLVideoElement & { webkitPreservesPitch: boolean }
		).webkitPreservesPitch = true;
	}

	const onRateChange = () => {
		lockPlaybackRate(video);
	};
	video.addEventListener('ratechange', onRateChange);

	let rafId = 0;
	const tick = () => {
		lockPlaybackRate(video);
		rafId = requestAnimationFrame(tick);
	};
	rafId = requestAnimationFrame(tick);

	return () => {
		video.removeEventListener('ratechange', onRateChange);
		cancelAnimationFrame(rafId);
	};
};
