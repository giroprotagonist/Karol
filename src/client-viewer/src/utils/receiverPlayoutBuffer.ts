import { RECEIVER_QUALITY_BUFFER_DELAY_MS } from '../constants/castReliabilityConstants';
import isReceiverMode from './isReceiverMode';
import { getReceiverQualityBufferPreference } from './receiverQualityBufferPreference';
import {
	applyReceiverJitterBufferTargets,
	getActiveReceiverPeerConnection,
} from './receiverJitterBuffer';

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
	reason?: string;
};

let activePlayoutCancel: (() => void) | null = null;
/** Synchronous guard — React isPlayoutBuffering state lags behind this. */
let playoutBufferActive = false;

export function isReceiverPlayoutBufferActive(): boolean {
	return playoutBufferActive;
}

export function cancelActiveReceiverPlayoutBuffer(): void {
	if (activePlayoutCancel) {
		activePlayoutCancel();
		activePlayoutCancel = null;
	}
	playoutBufferActive = false;
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

function restoreBufferingPresentation(
	video: HTMLVideoElement,
	presentation: BufferingPresentation,
	unmutedAfterBuffer: boolean,
): void {
	video.style.display = presentation.previousDisplay;
	video.style.opacity = presentation.previousOpacity || '1';
	video.style.visibility = presentation.previousVisibility || 'visible';
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

/**
 * Pre-roll: stay paused/hidden/muted for delayMs while WebRTC receives frames,
 * then reveal + play. Android WebView ignores video mute/pause for stream audio.
 */
export function startReceiverPlayoutWithBuffer(
	video: HTMLVideoElement,
	options: ReceiverPlayoutStartOptions = {},
): () => void {
	cancelActiveReceiverPlayoutBuffer();

	const delayMs = getReceiverPlayoutBufferDelayMs();
	const pc = getActiveReceiverPeerConnection();
	const unmutedAfterBuffer = options.unmutedAfterBuffer ?? false;

	if (pc && delayMs > 0) {
		applyReceiverJitterBufferTargets(pc, delayMs);
	}

	let cancelled = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let enforceTimer: ReturnType<typeof setInterval> | null = null;
	let presentation: BufferingPresentation | null = null;
	let suspendedAudio: SuspendedAudioTrack[] = [];

	const endBufferingState = () => {
		playoutBufferActive = false;
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

	const finishBuffering = () => {
		if (cancelled || !presentation) {
			return;
		}
		clearTimers();
		if (pc) {
			applyReceiverJitterBufferTargets(pc, delayMs);
		}
		restoreStreamAudio(suspendedAudio);
		suspendedAudio = [];
		restoreBufferingPresentation(video, presentation, unmutedAfterBuffer);
		endBufferingState();
		void video.play().catch((error) => {
			console.error('[PLAYOUT_BUFFER] play() after buffer failed:', error);
		});
	};

	if (delayMs <= 0) {
		playoutBufferActive = false;
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

	enforceTimer = setInterval(() => {
		if (cancelled) {
			return;
		}
		enforceBufferingPresentation(video);
	}, 200);

	timer = setTimeout(finishBuffering, delayMs);

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
