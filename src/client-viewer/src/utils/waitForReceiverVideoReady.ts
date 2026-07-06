import { RECEIVER_AV_START_MAX_WAIT_MS } from '../constants/castReliabilityConstants';

export type ReceiverVideoReadyResult = {
	ready: boolean;
	waitMs: number;
	timedOut: boolean;
	readyState: number;
	videoWidth: number;
	videoHeight: number;
};

function meetsBaseReadiness(video: HTMLVideoElement): boolean {
	return (
		video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA &&
		video.videoWidth > 0 &&
		video.videoHeight > 0 &&
		!video.paused
	);
}

function waitForFirstFrame(video: HTMLVideoElement): Promise<void> {
	const withRvfc = video as HTMLVideoElement & {
		requestVideoFrameCallback?: (
			callback: () => void,
		) => number;
	};

	if (typeof withRvfc.requestVideoFrameCallback === 'function') {
		return new Promise((resolve) => {
			withRvfc.requestVideoFrameCallback!(() => resolve());
		});
	}

	return new Promise((resolve) => {
		const startTime = video.currentTime;
		let sawAdvance = false;

		const onTimeUpdate = () => {
			if (video.currentTime > startTime) {
				sawAdvance = true;
				cleanup();
				resolve();
			}
		};

		const onPlaying = () => {
			if (sawAdvance || video.currentTime > startTime) {
				cleanup();
				resolve();
			}
		};

		const cleanup = () => {
			video.removeEventListener('timeupdate', onTimeUpdate);
			video.removeEventListener('playing', onPlaying);
		};

		video.addEventListener('timeupdate', onTimeUpdate);
		video.addEventListener('playing', onPlaying);

		if (video.currentTime > startTime) {
			cleanup();
			resolve();
		}
	});
}

/**
 * Wait until WebRTC video has decoded dimensions and painted at least one frame.
 */
export async function waitForReceiverVideoReady(
	video: HTMLVideoElement,
	maxWaitMs = RECEIVER_AV_START_MAX_WAIT_MS,
): Promise<ReceiverVideoReadyResult> {
	const startedAt = performance.now();

	const pollUntilBaseReady = (): Promise<boolean> =>
		new Promise((resolve) => {
			if (meetsBaseReadiness(video)) {
				resolve(true);
				return;
			}

			const deadline = startedAt + maxWaitMs;
			const interval = setInterval(() => {
				if (meetsBaseReadiness(video)) {
					clearInterval(interval);
					resolve(true);
					return;
				}
				if (performance.now() >= deadline) {
					clearInterval(interval);
					resolve(false);
				}
			}, 50);
		});

	const baseReady = await pollUntilBaseReady();
	if (!baseReady) {
		return {
			ready: false,
			waitMs: Math.round(performance.now() - startedAt),
			timedOut: true,
			readyState: video.readyState,
			videoWidth: video.videoWidth,
			videoHeight: video.videoHeight,
		};
	}

	const frameWaitStarted = performance.now();
	const frameDeadline = frameWaitStarted + Math.max(0, maxWaitMs - (frameWaitStarted - startedAt));

	try {
		await Promise.race([
			waitForFirstFrame(video),
			new Promise<void>((resolve) => {
				setTimeout(resolve, Math.max(0, frameDeadline - performance.now()));
			}),
		]);
	} catch {
		// fall through — base readiness is enough to proceed
	}

	const waitMs = Math.round(performance.now() - startedAt);
	const timedOut = waitMs >= maxWaitMs && !meetsBaseReadiness(video);

	return {
		ready: meetsBaseReadiness(video),
		waitMs,
		timedOut,
		readyState: video.readyState,
		videoWidth: video.videoWidth,
		videoHeight: video.videoHeight,
	};
}
