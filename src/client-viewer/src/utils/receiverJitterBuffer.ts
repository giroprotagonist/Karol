import type SimplePeer from 'simple-peer';
import { RECEIVER_QUALITY_BUFFER_DELAY_MS } from '../constants/castReliabilityConstants';
import { getReceiverQualityBufferPreference } from './receiverQualityBufferPreference';

/** Chromium Android WebView caps jitterBufferTarget at 4000 ms (logcat-verified). */
const JITTER_BUFFER_TARGET_MAX_MS = 4000;

type SimplePeerWithPc = SimplePeer.Instance & { _pc?: RTCPeerConnection };

type RtpReceiverWithBufferHints = RTCRtpReceiver & {
	jitterBufferTarget?: number;
	playoutDelayHint?: number;
};

let activePeerConnection: RTCPeerConnection | null = null;
let trackListenerCleanup: (() => void) | null = null;

export function getPeerConnectionFromSimplePeer(
	peer: SimplePeer.Instance,
): RTCPeerConnection | null {
	const pc = (peer as SimplePeerWithPc)._pc;
	return pc ?? null;
}

export function registerReceiverPeerConnection(
	pc: RTCPeerConnection | null,
): void {
	trackListenerCleanup?.();
	trackListenerCleanup = null;
	activePeerConnection = pc;

	if (!pc) {
		return;
	}

	const onTrack = () => {
		applyReceiverQualityBufferFromPreference();
	};
	pc.addEventListener('track', onTrack);
	trackListenerCleanup = () => {
		pc.removeEventListener('track', onTrack);
	};
}

export function applyReceiverJitterBufferTargets(
	peerConnection: RTCPeerConnection,
	delayMs: number,
): void {
	const receivers = peerConnection.getReceivers();
	for (const receiver of receivers) {
		applyJitterBufferTargetToReceiver(receiver, delayMs);
	}
}

function applyJitterBufferTargetToReceiver(
	receiver: RTCRtpReceiver,
	delayMs: number,
): void {
	const rtpReceiver = receiver as RtpReceiverWithBufferHints;
	const jitterTargetMs = Math.min(Math.max(delayMs, 0), JITTER_BUFFER_TARGET_MAX_MS);
	const playoutDelaySeconds = delayMs > 0 ? delayMs / 1000 : 0;
	try {
		if ('jitterBufferTarget' in rtpReceiver) {
			rtpReceiver.jitterBufferTarget = jitterTargetMs;
		}
		if ('playoutDelayHint' in rtpReceiver) {
			rtpReceiver.playoutDelayHint = playoutDelaySeconds;
		}
	} catch (error) {
		console.warn(
			'Unable to set receiver jitter buffer target',
			{ delayMs, jitterTargetMs, playoutDelaySeconds },
			error,
		);
	}
}

export function applyReceiverQualityBufferFromPreference(): void {
	if (!activePeerConnection) {
		return;
	}
	const enabled = getReceiverQualityBufferPreference();
	const delayMs = enabled ? RECEIVER_QUALITY_BUFFER_DELAY_MS : 0;
	applyReceiverJitterBufferTargets(activePeerConnection, delayMs);
}

export function getActiveReceiverPeerConnection(): RTCPeerConnection | null {
	return activePeerConnection;
}
