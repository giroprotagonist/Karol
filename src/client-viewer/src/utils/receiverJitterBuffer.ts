import type SimplePeer from 'simple-peer';
import {
	RECEIVER_AUDIO_PLAYOUT_OFFSET_MS,
	RECEIVER_JITTER_BUFFER_TARGET_MAX_MS,
	RECEIVER_QUALITY_BUFFER_DELAY_MS,
} from '../constants/castReliabilityConstants';
import { getReceiverQualityBufferPreference } from './receiverQualityBufferPreference';
import { receiverPlaybackDebug } from './receiverPlaybackDebug';

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
		const isAudio = receiver.track?.kind === 'audio';
		const trackDelayMs = isAudio
			? delayMs + RECEIVER_AUDIO_PLAYOUT_OFFSET_MS
			: delayMs;
		applyJitterBufferTargetToReceiver(receiver, trackDelayMs, isAudio ? 'audio' : 'video');
	}
	receiverPlaybackDebug('jitter-targets-applied', {
		baseDelayMs: delayMs,
		audioOffsetMs: RECEIVER_AUDIO_PLAYOUT_OFFSET_MS,
		receiverCount: receivers.length,
	});
}

function applyJitterBufferTargetToReceiver(
	receiver: RTCRtpReceiver,
	delayMs: number,
	kind: 'audio' | 'video',
): void {
	const rtpReceiver = receiver as RtpReceiverWithBufferHints;
	const jitterTargetMs = Math.min(
		Math.max(delayMs, 0),
		RECEIVER_JITTER_BUFFER_TARGET_MAX_MS,
	);
	const playoutDelaySeconds = Math.max(delayMs, 0) / 1000;
	try {
		if ('jitterBufferTarget' in rtpReceiver) {
			rtpReceiver.jitterBufferTarget = jitterTargetMs;
		}
		if ('playoutDelayHint' in rtpReceiver) {
			rtpReceiver.playoutDelayHint = playoutDelaySeconds;
		}
		receiverPlaybackDebug('jitter-receiver', {
			kind,
			jitterTargetMs,
			playoutDelaySeconds,
		});
	} catch (error) {
		console.warn(
			'Unable to set receiver jitter buffer target',
			{ kind, delayMs, jitterTargetMs, playoutDelaySeconds },
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
