type VideoConstraints = {
	frameRate: {
		min?: number;
		ideal?: number;
		max?: number;
	};
};

export default async function captureDesktopMediaStream(
	videoConstraints: VideoConstraints,
	includeSystemAudio = true,
): Promise<MediaStream> {
	// NOTE: do NOT call setHostCaptureSessionActive(true) here.
	// The display-media handler in configureScreenCaptureSession.ts
	// is the sole authority on capture-session state.
	//
	// Also, do NOT request audio from getDisplayMedia.  On macOS
	// the combined video+audio request often produces a stream
	// with zero video tracks, forcing a fallback that tears down
	// and recreates the capture session — which leaves the
	// receiver-side video track permanently muted.
	// System audio is added separately by syncHostCastAudioOutput.
	const _unused = includeSystemAudio; // keep signature for callers

	return navigator.mediaDevices.getDisplayMedia({
		video: videoConstraints,
		audio: false,
	});
}
