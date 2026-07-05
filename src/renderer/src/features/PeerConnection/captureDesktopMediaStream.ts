import { applyHostMonoAudioMix } from './hostMonoAudioMix';

type VideoConstraints = {
	frameRate: {
		min?: number;
		ideal?: number;
		max?: number;
	};
};

async function withHostMonoAudio(stream: MediaStream): Promise<MediaStream> {
	if (stream.getAudioTracks().length === 0) {
		return stream;
	}
	return applyHostMonoAudioMix(stream);
}

export default async function captureDesktopMediaStream(
	videoConstraints: VideoConstraints,
	includeSystemAudio = true,
): Promise<MediaStream> {
	// NOTE: do NOT call setHostCaptureSessionActive here — the
	// display-media handler in configureScreenCaptureSession.ts
	// is the sole authority on capture-session state.  Calling it
	// prematurely deadlocks source enumeration.

	const systemAudioConstraints = {
		echoCancellation: false,
		noiseSuppression: false,
		autoGainControl: false,
		channelCount: 2,
		sampleRate: 48000,
	} as MediaTrackConstraints;

	const captureVideoOnly = async (): Promise<MediaStream> => {
		return navigator.mediaDevices.getDisplayMedia({
			video: videoConstraints,
			audio: false,
		});
	};

	if (!includeSystemAudio) {
		return await captureVideoOnly();
	}

	// First attempt: video + system audio via the display-media handler
	// (which responds with audio: 'loopback').  On macOS this sometimes
	// produces a stream with zero video tracks — when that happens we
	// stop the tracks and fall back to video-only.  The fallback works
	// now because the capture-session deadlock has been fixed.
	try {
		const streamWithAudio = await navigator.mediaDevices.getDisplayMedia({
			video: videoConstraints,
			audio: systemAudioConstraints,
		});
		if (streamWithAudio.getVideoTracks().length > 0) {
			return await withHostMonoAudio(streamWithAudio);
		}
		streamWithAudio.getTracks().forEach((track) => track.stop());
	} catch (error) {
		console.warn(
			'system audio capture unavailable, falling back to video only',
			error,
		);
	}

	return await captureVideoOnly();
}
