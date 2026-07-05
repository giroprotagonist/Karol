import { applyReceiverQualityBufferFromPreference } from './receiverJitterBuffer';

const TARGET_RATE = 1;

let rateLockResetCount = 0;

function lockPlaybackRate(video: HTMLVideoElement): void {
	if (video.playbackRate === TARGET_RATE && video.defaultPlaybackRate === TARGET_RATE) {
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

	applyReceiverQualityBufferFromPreference();
}

/**
 * Pin HTMLMediaElement playback speed to 1.0. Chromium's WebRTC jitter buffer
 * may adjust playbackRate to accelerate/decelerate playout; this prevents
 * audible speed fluctuations (chipmunk / slowdown).
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
}
