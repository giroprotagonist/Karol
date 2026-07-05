import {
	RECEIVER_QUALITY_BUFFER_FRAME_STALE_MS,
	RECEIVER_QUALITY_BUFFER_FROZEN_THRESHOLD_MS,
} from '../constants/castReliabilityConstants';
import isReceiverMode from './isReceiverMode';

const FRAME_STALE_MS = 8000;
const FROZEN_THRESHOLD_MS = 5000;
const RECOVER_PLAY_INTERVAL_MS = 3000;

type StreamHealthSnapshot = {
	lastFrameAt: number;
	isMonitoring: boolean;
	qualityBufferEnabled: boolean;
};

const snapshot: StreamHealthSnapshot = {
	lastFrameAt: 0,
	isMonitoring: false,
	qualityBufferEnabled: false,
};

function getFrameStaleMs(): number {
	return snapshot.qualityBufferEnabled
		? RECEIVER_QUALITY_BUFFER_FRAME_STALE_MS
		: FRAME_STALE_MS;
}

function getFrozenThresholdMs(): number {
	return snapshot.qualityBufferEnabled
		? RECEIVER_QUALITY_BUFFER_FROZEN_THRESHOLD_MS
		: FROZEN_THRESHOLD_MS;
}

export function setReceiverStreamHealthBufferMode(enabled: boolean): void {
	snapshot.qualityBufferEnabled = enabled;
}

export function markCastFrameReceived(): void {
	snapshot.lastFrameAt = Date.now();
}

/** True when no frames have arrived recently (or monitoring has not started). */
export function isCastStreamStale(): boolean {
	if (!snapshot.isMonitoring || snapshot.lastFrameAt === 0) {
		return false;
	}
	return Date.now() - snapshot.lastFrameAt > getFrameStaleMs();
}

export function isCastStreamHealthy(): boolean {
	return !isCastStreamStale();
}

export class ReceiverStreamHealthMonitor {
	private video: HTMLVideoElement | null = null;

	private rafId: number | null = null;

	private intervalId: ReturnType<typeof setInterval> | null = null;

	private lastCurrentTime = -1;

	private lastProgressAt = 0;

	private onFrozen: (() => void) | null = null;

	attach(
		video: HTMLVideoElement,
		options?: { onFrozen?: () => void; qualityBufferEnabled?: boolean },
	): void {
		this.detach();
		this.video = video;
		this.onFrozen = options?.onFrozen ?? null;
		setReceiverStreamHealthBufferMode(options?.qualityBufferEnabled ?? false);
		this.lastCurrentTime = video.currentTime;
		this.lastProgressAt = Date.now();
		snapshot.isMonitoring = true;
		snapshot.lastFrameAt = Date.now();

		const markProgress = () => {
			if (!this.video) {
				return;
			}
			if (this.video.currentTime !== this.lastCurrentTime) {
				this.lastCurrentTime = this.video.currentTime;
				this.lastProgressAt = Date.now();
				markCastFrameReceived();
			}
		};

		video.addEventListener('timeupdate', markProgress);
		video.addEventListener('playing', markProgress);
		video.addEventListener('resize', markProgress);

		if ('requestVideoFrameCallback' in video) {
			const onFrame = () => {
				markCastFrameReceived();
				this.lastProgressAt = Date.now();
				if (this.video) {
					this.rafId = (
						video as HTMLVideoElement & {
							requestVideoFrameCallback: (
								cb: () => void,
							) => number;
						}
					).requestVideoFrameCallback(onFrame);
				}
			};
			this.rafId = (
				video as HTMLVideoElement & {
					requestVideoFrameCallback: (cb: () => void) => number;
				}
			).requestVideoFrameCallback(onFrame);
		}

		this.intervalId = setInterval(() => {
			if (!this.video) {
				return;
			}

			const staleMs = Date.now() - this.lastProgressAt;
			const frozenThresholdMs = getFrozenThresholdMs();
			const frameStaleMs = getFrameStaleMs();
			if (staleMs >= frozenThresholdMs && this.video.paused) {
				this.video.play().catch(() => {
					// autoplay policy — ignore
				});
			}
			if (staleMs >= frameStaleMs) {
				this.onFrozen?.();
			}
		}, RECOVER_PLAY_INTERVAL_MS);

		this.cleanupListeners = () => {
			video.removeEventListener('timeupdate', markProgress);
			video.removeEventListener('playing', markProgress);
			video.removeEventListener('resize', markProgress);
		};
	}

	private cleanupListeners: (() => void) | null = null;

	detach(): void {
		if (this.cleanupListeners) {
			this.cleanupListeners();
			this.cleanupListeners = null;
		}
		if (this.rafId !== null && this.video) {
			if ('cancelVideoFrameCallback' in this.video) {
				(
					this.video as HTMLVideoElement & {
						cancelVideoFrameCallback: (id: number) => void;
					}
				).cancelVideoFrameCallback(this.rafId);
			}
			this.rafId = null;
		}
		if (this.intervalId !== null) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
		this.video = null;
		this.onFrozen = null;
		snapshot.isMonitoring = false;
		snapshot.lastFrameAt = 0;
		snapshot.qualityBufferEnabled = false;
	}
}

export function shouldUseReceiverRelaxedDisconnect(): boolean {
	return isReceiverMode();
}
