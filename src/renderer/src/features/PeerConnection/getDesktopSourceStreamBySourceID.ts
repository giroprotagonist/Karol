import { IpcEvents } from '../../../../common/IpcEvents.enum';
import captureDesktopMediaStream from './captureDesktopMediaStream';
import DesktopCapturerSourceType from '../../../../common/DesktopCapturerSourceType';

export default async function getDesktopSourceStreamBySourceID(
	sourceID: string,
	_width: number | null | undefined = undefined,
	_height: number | null | undefined = undefined,
	_minSizeMultiplier = 1,
	_maxSizeMultiplier = 1,
	minFrameRate = 24,
	maxFrameRate = 30,
	includeSystemAudio = true,
): Promise<MediaStream> {
	const trimmedSourceId = sourceID.trim();
	if (trimmedSourceId !== '') {
		await window.electron.ipcRenderer.invoke(
			IpcEvents.SetPreferredCapturerSourceIdForDisplayMedia,
			trimmedSourceId,
		);
	}

	const isWindowSource = trimmedSourceId.includes(
		DesktopCapturerSourceType.WINDOW,
	);
	// Electron window capture rejects frameRate.min — caused capture failure + wrong-source fallback.
	const frameRate = isWindowSource
		? { ideal: 24, max: 24 }
		: { min: minFrameRate, ideal: maxFrameRate, max: maxFrameRate };

	const videoConstraints: {
		frameRate: typeof frameRate;
		width?: { ideal: number; max: number };
		height?: { ideal: number; max: number };
	} = { frameRate };

	// Window capture on Retina Macs defaults to very high resolution — cap for WiFi streaming.
	if (isWindowSource) {
		videoConstraints.width = { ideal: 1280, max: 1920 };
		videoConstraints.height = { ideal: 720, max: 1080 };
	}

	return captureDesktopMediaStream(videoConstraints, includeSystemAudio);
}
