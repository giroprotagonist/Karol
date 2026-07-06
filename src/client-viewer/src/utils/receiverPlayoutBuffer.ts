import {
	RECEIVER_AV_START_MAX_WAIT_MS,
	RECEIVER_PREROLL_JITTER_REAPPLY_MS,
	RECEIVER_QUALITY_BUFFER_DELAY_MS,
} from '../constants/castReliabilityConstants';
import isReceiverMode from './isReceiverMode';
import { getReceiverQualityBufferPreference } from './receiverQualityBufferPreference';
import {
	applyReceiverJitterBufferTargets,
	getActiveReceiverPeerConnection,
} from './receiverJitterBuffer';
import { receiverPlaybackDebug } from './receiverPlaybackDebug';
import { waitForReceiverVideoReady } from './waitForReceiverVideoReady';

export function getReceiverPlayoutBufferDelayMs(): number {
	if (!isReceiverMode() || !getReceiverQualityBufferPreference()) {
		return 0;
	}
	return RECEIVER_QUALITY_BUFFER_DELAY_MS;
}

export type ReceiverPlayoutStartOptions = {
	onBufferingChange?: (buffering: boolean) => void;
	/** Unmute after pre-roll when stream has audio (receiver karaoke). */
	unmutedAfterBuffer?: boolean;
	/** Fired when video priming times out without a ready frame (A/V stays muted). */
	onAvStartTimeout?: () => void;
	reason?: string;
};

let activePlayoutCancel: (() => void) | null = null;
/** Synchronous guard — React isPlayoutBuffering state lags behind this. */
let playoutBufferActive = false;
/** True during phase B (video priming) before audio unlock. */
let avStartPending = false;

export function isReceiverPlayoutBufferActive(): boolean {
	return playoutBufferActive;
}

export function isReceiverAvStartPending(): boolean {
	return avStartPending;
}

export function cancelActiveReceiverPlayoutBuffer(): void {
	if (activePlayoutCancel) {
		activePlayoutCancel();
		activePlayoutCancel = null;
	}
	playoutBufferActive = false;
	avStartPending = false;
}

type BufferingPresentation = {
	targetMuted: boolean;
	previousVolume: number;
	previousDisplay: string;
	previousOpacity: string;
	previousVisibility: string;
};

type SuspendedAudioTrack = {
	track: MediaStreamTrack;
	wasEnabled: boolean;
};

function getStreamFromVideo(video: HTMLVideoElement): MediaStream | null {
	const { srcObject } = video;
	return srcObject instanceof MediaStream ? srcObject : null;
}

function suspendStreamAudio(video: HTMLVideoElement): SuspendedAudioTrack[] {
	const stream = getStreamFromVideo(video);
	if (!stream) {
		return [];
	}
	const suspended: SuspendedAudioTrack[] = [];
	for (const track of stream.getAudioTracks()) {
		suspended.push({ track, wasEnabled: track.enabled });
		track.enabled = false;
	}
	return suspended;
}

function restoreStreamAudio(suspended: SuspendedAudioTrack[]): void {
	for (const { track, wasEnabled } of suspended) {
		track.enabled = wasEnabled;
	}
}

function enforceStreamAudioSuspended(video: HTMLVideoElement): boolean {
	const stream = getStreamFromVideo(video);
	if (!stream) {
		return false;
	}
	let reDisabled = false;
	for (const track of stream.getAudioTracks()) {
		if (track.enabled) {
			track.enabled = false;
			reDisabled = true;
		}
	}
	return reDisabled;
}

function applyBufferingPresentation(video: HTMLVideoElement): BufferingPresentation {
	const presentation: BufferingPresentation = {
		targetMuted: video.muted,
		previousVolume: video.volume,
		previousDisplay: video.style.display,
		previousOpacity: video.style.opacity,
		previousVisibility: video.style.visibility,
	};
	video.muted = true;
	video.volume = 0;
	video.pause();
	video.style.display = 'none';
	video.style.opacity = '0';
	video.style.visibility = 'hidden';
	return presentation;
}

function restoreVisualPresentation(
	video: HTMLVideoElement,
	presentation: BufferingPresentation,
): void {
	video.style.display = presentation.previousDisplay;
	video.style.opacity = presentation.previousOpacity || '1';
	video.style.visibility = presentation.previousVisibility || 'visible';
}

function restoreBufferingPresentation(
	video: HTMLVideoElement,
	presentation: BufferingPresentation,
	unmutedAfterBuffer: boolean,
): void {
	restoreVisualPresentation(video, presentation);
	video.volume = presentation.previousVolume > 0 ? presentation.previousVolume : 1;
	video.muted = unmutedAfterBuffer ? false : presentation.targetMuted;
}

function enforceBufferingPresentation(video: HTMLVideoElement): void {
	if (!video.paused) {
		video.pause();
	}
	if (!video.muted) {
		video.muted = true;
	}
	if (video.volume !== 0) {
		video.volume = 0;
	}
	if (video.style.display !== 'none') {
		video.style.display = 'none';
	}
	enforceStreamAudioSuspended(video);
}

/** Phase B: video visible and playing, audio still held. */
function enforcePrimingPresentation(video: HTMLVideoElement): void {
	if (!video.muted) {
		video.muted = true;
	}
	if (video.volume !== 0) {
		video.volume = 0;
	}
	enforceStreamAudioSuspended(video);
}

/**
 * Pre-roll: stay paused/hidden/muted for delayMs while WebRTC receives frames,
 * then reveal video, wait for first frame, then unlock audio together.
 */
export function startReceiverPlayoutWithBuffer(
	video: HTMLVideoElement,
	options: ReceiverPlayoutStartOptions = {},
): () => void {
	cancelActiveReceiverPlayoutBuffer();

	const delayMs = getReceiverPlayoutBufferDelayMs();
	const pc = getActiveReceiverPeerConnection();
	const unmutedAfterBuffer = options.unmutedAfterBuffer ?? false;
	const preRollStartedAt = performance.now();

	if (pc && delayMs > 0) {
		applyReceiverJitterBufferTargets(pc, delayMs);
	}

	let cancelled = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let enforceTimer: ReturnType<typeof setInterval> | null = null;
	let jitterReapplyTimer: ReturnType<typeof setInterval> | null = null;
	let presentation: BufferingPresentation | null = null;
	let suspendedAudio: SuspendedAudioTrack[] = [];
	let primingPhase = false;

	const endBufferingState = () => {
		playoutBufferActive = false;
		avStartPending = false;
		options.onBufferingChange?.(false);
		if (activePlayoutCancel === cancel) {
			activePlayoutCancel = null;
		}
	};

	const clearTimers = () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		if (enforceTimer) {
			clearInterval(enforceTimer);
			enforceTimer = null;
		}
		if (jitterReapplyTimer) {
			clearInterval(jitterReapplyTimer);
			jitterReapplyTimer = null;
		}
	};

	const startJitterReapply = () => {
		if (!pc || delayMs <= 0) {
			return;
		}
		if (jitterReapplyTimer) {
			clearInterval(jitterReapplyTimer);
		}
		jitterReapplyTimer = setInterval(() => {
			if (cancelled || !pc) {
				return;
			}
			applyReceiverJitterBufferTargets(pc, delayMs);
		}, RECEIVER_PREROLL_JITTER_REAPPLY_MS);
	};

	const cancel = () => {
		cancelled = true;
		clearTimers();
		restoreStreamAudio(suspendedAudio);
		suspendedAudio = [];
		if (presentation) {
			restoreBufferingPresentation(video, presentation, unmutedAfterBuffer);
		}
		endBufferingState();
	};

	const completeAvStart = (videoReadyWaitMs: number, timedOut: boolean, ready: boolean) => {
		if (cancelled || !presentation) {
			return;
		}
		clearTimers();
		if (pc) {
			applyReceiverJitterBufferTargets(pc, delayMs);
		}
		if (timedOut && !ready) {
			receiverPlaybackDebug('av-start-timeout', {
				reason: options.reason ?? 'stream-start',
				waitMs: videoReadyWaitMs,
				readyState: video.readyState,
			});
			options.onAvStartTimeout?.();
			endBufferingState();
			return;
		}
		restoreStreamAudio(suspendedAudio);
		suspendedAudio = [];
		restoreBufferingPresentation(video, presentation, unmutedAfterBuffer);
		endBufferingState();

		receiverPlaybackDebug('av-start', {
			reason: options.reason ?? 'stream-start',
			preRollMs: Math.round(performance.now() - preRollStartedAt - videoReadyWaitMs),
			videoReadyWaitMs,
			timedOut,
			readyState: video.readyState,
			videoWidth: video.videoWidth,
			videoHeight: video.videoHeight,
		});
	};

	const beginVideoPriming = async () => {
		if (cancelled || !presentation) {
			return;
		}
		clearTimers();
		if (pc) {
			applyReceiverJitterBufferTargets(pc, delayMs);
		}

		restoreVisualPresentation(video, presentation);
		video.muted = true;
		video.volume = 0;
		enforceStreamAudioSuspended(video);

		avStartPending = true;
		primingPhase = true;
		startJitterReapply();

		enforceTimer = setInterval(() => {
			if (cancelled) {
				return;
			}
			if (primingPhase) {
				enforcePrimingPresentation(video);
			} else {
				enforceBufferingPresentation(video);
			}
		}, 200);

		try {
			await video.play();
		} catch (error) {
			console.error('[PLAYOUT_BUFFER] play() during priming failed:', error);
		}

		const readyResult = await waitForReceiverVideoReady(
			video,
			RECEIVER_AV_START_MAX_WAIT_MS,
		);

		if (cancelled) {
			return;
		}

		primingPhase = false;
		completeAvStart(readyResult.waitMs, readyResult.timedOut, readyResult.ready);
	};

	if (delayMs <= 0) {
		playoutBufferActive = false;
		avStartPending = false;
		options.onBufferingChange?.(false);
		void video.play().catch(() => {
			// autoplay policy
		});
		activePlayoutCancel = cancel;
		return cancel;
	}

	playoutBufferActive = true;
	options.onBufferingChange?.(true);
	presentation = applyBufferingPresentation(video);
	suspendedAudio = suspendStreamAudio(video);
	startJitterReapply();

	enforceTimer = setInterval(() => {
		if (cancelled) {
			return;
		}
		if (primingPhase) {
			enforcePrimingPresentation(video);
		} else {
			enforceBufferingPresentation(video);
		}
	}, 200);

	timer = setTimeout(() => {
		void beginVideoPriming();
	}, delayMs);

	activePlayoutCancel = cancel;
	return cancel;
}

export function reapplyReceiverPlayoutBufferAfterFullscreen(
	video: HTMLVideoElement,
	options: Omit<ReceiverPlayoutStartOptions, 'reason'> & {
		reason?: string;
	} = {},
): () => void {
	if (getReceiverPlayoutBufferDelayMs() <= 0) {
		return () => {};
	}
	return startReceiverPlayoutWithBuffer(video, {
		...options,
		reason: options.reason ?? 'fullscreen',
	});
}
