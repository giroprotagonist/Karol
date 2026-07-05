import DesktopCapturerSourceType from '../../../../common/DesktopCapturerSourceType';
import NullSimplePeer from './NullSimplePeer';

/** Cap window-capture encoder bitrate for smoother playback on weak WiFi. */
const KARAOKE_WINDOW_CAPTURE_MAX_BITRATE_BPS = 3_500_000;
const KARAOKE_WINDOW_CAPTURE_MAX_FRAMERATE = 24;

type SimplePeerWithPc = { _pc?: RTCPeerConnection };

export function applyHostStreamEncodingPreferences(
	peerConnection: PeerConnection,
): void {
	if (peerConnection.peer === NullSimplePeer) {
		return;
	}

	const pc = (peerConnection.peer as SimplePeerWithPc)._pc;
	if (!pc) {
		return;
	}

	const isWindowSource = peerConnection.desktopCapturerSourceID.includes(
		DesktopCapturerSourceType.WINDOW,
	);

	const videoSender = pc
		.getSenders()
		.find((sender) => sender.track?.kind === 'video');
	if (!videoSender) {
		return;
	}

	try {
		const params = videoSender.getParameters();
		if (!params.encodings || params.encodings.length === 0) {
			return;
		}

		if (isWindowSource) {
			params.encodings[0].maxBitrate = KARAOKE_WINDOW_CAPTURE_MAX_BITRATE_BPS;
			params.encodings[0].maxFramerate = KARAOKE_WINDOW_CAPTURE_MAX_FRAMERATE;
			params.degradationPreference = 'maintain-framerate';
		} else {
			params.encodings[0].maxBitrate = 8_000_000;
			params.degradationPreference = 'maintain-resolution';
		}

		void videoSender.setParameters(params);
	} catch (error) {
		console.warn('failed to apply host stream encoding preferences', error);
	}
}
