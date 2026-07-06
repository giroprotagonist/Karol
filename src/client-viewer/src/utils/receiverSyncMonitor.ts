import { receiverPlaybackDebug } from './receiverPlaybackDebug';
import {
	applyReceiverQualityBufferFromPreference,
	getActiveReceiverPeerConnection,
} from './receiverJitterBuffer';
import isReceiverMode from './isReceiverMode';
import { RECEIVER_BUFFER_STANDARD_MS } from '../constants/castReliabilityConstants';

const POLL_INTERVAL_MS = 8000;
const REAPPLY_DRIFT_MS = 150;
const NUDGE_DRIFT_MS = Math.max(400, RECEIVER_BUFFER_STANDARD_MS * 0.06);
const MAX_NUDGE_SECONDS = 0.05;
const NUDGE_COOLDOWN_MS = 30000;
const CONSECUTIVE_REAPPLY_THRESHOLD = 2;

type InboundRtpSummary = {
	kind?: string;
	jitter?: number;
	packetsLost?: number;
	pliCount?: number;
};

let pollTimer: ReturnType<typeof setInterval> | null = null;
let consecutiveHighDrift = 0;
let lastNudgeAt = 0;
let lastVideoTime = 0;
let lastCheckAt = 0;
let activeVideo: HTMLVideoElement | null = null;

export function startReceiverSyncMonitor(video: HTMLVideoElement | null): void {
	stopReceiverSyncMonitor();
	if (!isReceiverMode() || !video) {
		return;
	}

	activeVideo = video;
	lastVideoTime = video.currentTime;
	lastCheckAt = performance.now();

	pollTimer = setInterval(() => {
		if (activeVideo) {
			void runSyncCheck(activeVideo);
		}
	}, POLL_INTERVAL_MS);
}

export function stopReceiverSyncMonitor(): void {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
	activeVideo = null;
	consecutiveHighDrift = 0;
}

async function runSyncCheck(video: HTMLVideoElement): Promise<void> {
	const pc = getActiveReceiverPeerConnection();
	if (!pc || video.paused || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
		lastVideoTime = video.currentTime;
		lastCheckAt = performance.now();
		return;
	}

	const stats = await pc.getStats();
	const rtpStats: InboundRtpSummary[] = [];
	stats.forEach((report) => {
		if (report.type !== 'inbound-rtp') {
			return;
		}
		const inbound = report as RTCInboundRtpStreamStats;
		rtpStats.push({
			kind: inbound.kind,
			jitter: inbound.jitter,
			packetsLost: inbound.packetsLost,
			pliCount: inbound.pliCount,
		});
	});

	const now = performance.now();
	const elapsedSec = (now - lastCheckAt) / 1000;
	const expectedAdvance = elapsedSec;
	const actualAdvance = video.currentTime - lastVideoTime;
	const driftMs = Math.abs(actualAdvance - expectedAdvance) * 1000;

	lastVideoTime = video.currentTime;
	lastCheckAt = now;

	receiverPlaybackDebug('sync-check', {
		driftMs: Math.round(driftMs),
		consecutiveHighDrift,
		rtpStats,
	});

	if (driftMs > REAPPLY_DRIFT_MS) {
		consecutiveHighDrift += 1;
	} else {
		consecutiveHighDrift = 0;
	}

	if (consecutiveHighDrift >= CONSECUTIVE_REAPPLY_THRESHOLD) {
		applyReceiverQualityBufferFromPreference();
		receiverPlaybackDebug('sync-reapply-hints', {
			driftMs: Math.round(driftMs),
		});
		consecutiveHighDrift = 0;
	}

	if (driftMs > NUDGE_DRIFT_MS && now - lastNudgeAt > NUDGE_COOLDOWN_MS) {
		const direction = actualAdvance < expectedAdvance ? 1 : -1;
		const nudge = direction * MAX_NUDGE_SECONDS;
		try {
			video.currentTime = Math.max(0, video.currentTime + nudge);
			lastNudgeAt = now;
			receiverPlaybackDebug('sync-nudge', {
				driftMs: Math.round(driftMs),
				nudgeSeconds: nudge,
			});
		} catch {
			// ignore seek failures during live WebRTC playout
		}
	}
}
