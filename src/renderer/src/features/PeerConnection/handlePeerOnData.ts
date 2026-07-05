import DesktopCapturerSourceType from '../../../../common/DesktopCapturerSourceType';
import type { RemoteInputPayload } from '../../../../common/RemoteInputTypes';
import { IpcEvents } from '../../../../common/IpcEvents.enum';
import prepareDataMessageToSendScreenSourceType from './prepareDataMessageToSendScreenSourceType';
import prepareDataMessageRemoteControlCapability from './prepareDataMessageRemoteControlCapability';

let remoteControlSessionNotified = false;

async function getAllowTabletControlSetting(): Promise<boolean> {
	try {
		return Boolean(
			await window.electron.ipcRenderer.invoke(
				IpcEvents.GetAllowTabletControlWhileCasting,
			),
		);
	} catch {
		return false;
	}
}

async function getDisplayLogicalSizeForPeer(
	peerConnection: PeerConnection,
): Promise<{ width: number; height: number } | undefined> {
	if (!peerConnection.displayID) {
		return undefined;
	}
	try {
		const size = await window.electron.ipcRenderer.invoke(
			'get-display-logical-size-by-display-id',
			peerConnection.displayID,
		);
		if (
			size &&
			typeof size.width === 'number' &&
			typeof size.height === 'number'
		) {
			return size;
		}
	} catch {
		// ignore
	}
	return undefined;
}

async function sendRemoteControlCapability(
	peerConnection: PeerConnection,
): Promise<void> {
	if (!peerConnection.peer) {
		return;
	}
	const enabled = await getAllowTabletControlSetting();
	const logicalSize = await getDisplayLogicalSizeForPeer(peerConnection);
	peerConnection.peer.send(
		prepareDataMessageRemoteControlCapability(
			enabled,
			peerConnection.desktopCapturerSourceID,
			logicalSize?.width,
			logicalSize?.height,
		),
	);
}

async function handleRemoteInput(
	peerConnection: PeerConnection,
	payload: RemoteInputPayload,
): Promise<void> {
	const allowed = await getAllowTabletControlSetting();
	if (!allowed) {
		return;
	}

	if (
		!peerConnection.desktopCapturerSourceID.includes(
			DesktopCapturerSourceType.SCREEN,
		)
	) {
		return;
	}

	const result = await window.electron.ipcRenderer.invoke(
		IpcEvents.InjectRemoteInput,
		{
			displayID: peerConnection.displayID,
			desktopCapturerSourceID: peerConnection.desktopCapturerSourceID,
			payload,
		},
	);

	const injected = Boolean(result?.ok ?? result);

	if (injected && !remoteControlSessionNotified) {
		remoteControlSessionNotified = true;
		window.electron.ipcRenderer.send(IpcEvents.RemoteControlSessionActive, true);
	}

	if (!injected && peerConnection.peer) {
		peerConnection.peer.send(
			JSON.stringify({
				type: 'remote_input_result',
				payload: {
					ok: false,
					reason: result?.reason ?? 'unknown',
				},
			}),
		);
	}
}

export default async function handlePeerOnData(
	peerConnection: PeerConnection,
	data: string,
): Promise<void> {
	const dataJSON = JSON.parse(data);

	if (dataJSON.type === 'set_video_quality') {
		const videoTrack = peerConnection.localStream?.getVideoTracks()[0];
		if (!videoTrack) {
			return;
		}

		const multiplier = dataJSON.payload.value as number;

		const frameRate = multiplier >= 1 ? 30
			: multiplier >= 0.8 ? 24
			: multiplier >= 0.6 ? 20
			: multiplier >= 0.4 ? 15
			: 10;

		try {
			await videoTrack.applyConstraints({
				frameRate: { max: frameRate, ideal: frameRate },
			});
		} catch (_error) {
			console.warn('failed to apply frameRate constraint', _error);
		}

		if (multiplier < 1) {
			try {
				const simplePeer = peerConnection.peer as any;
				const pc: RTCPeerConnection | undefined = simplePeer?._pc;
				if (pc) {
					const senders = pc.getSenders();
					const videoSender = senders.find(
						(s: RTCRtpSender) => s.track?.kind === 'video',
					);
					if (videoSender) {
						const params = videoSender.getParameters();
						if (params.encodings && params.encodings.length > 0) {
							const targetKbps = Math.round(8000 * multiplier);
							params.encodings[0].maxBitrate = targetKbps * 1000;
							params.encodings[0].scaleResolutionDownBy =
								multiplier >= 0.8 ? undefined
								: multiplier >= 0.6 ? 1.25
								: multiplier >= 0.4 ? 1.5
								: 2;
							await videoSender.setParameters(params);
							console.warn(
								'[QUALITY] applied bitrate',
								targetKbps,
								'kbps',
								'fps',
								frameRate,
								'scale',
								params.encodings[0].scaleResolutionDownBy,
							);
						}
					}
				}
			} catch (_error) {
				console.warn('failed to apply sender bitrate', _error);
			}
		} else {
			try {
				const simplePeer = peerConnection.peer as any;
				const pc: RTCPeerConnection | undefined = simplePeer?._pc;
				if (pc) {
					const senders = pc.getSenders();
					const videoSender = senders.find(
						(s: RTCRtpSender) => s.track?.kind === 'video',
					);
					if (videoSender) {
						const params = videoSender.getParameters();
						if (params.encodings && params.encodings.length > 0) {
							params.encodings[0].maxBitrate = 8000 * 1000;
							params.encodings[0].scaleResolutionDownBy = undefined;
							await videoSender.setParameters(params);
							console.warn('[QUALITY] restored full 8000 kbps');
						}
					}
				}
			} catch (_error) {
				console.warn('failed to restore sender bitrate', _error);
			}
		}
	}

	if (dataJSON.type === 'get_sharing_source_type') {
		const sourceType = peerConnection.desktopCapturerSourceID.includes(
			DesktopCapturerSourceType.SCREEN,
		)
			? DesktopCapturerSourceType.SCREEN
			: DesktopCapturerSourceType.WINDOW;

		peerConnection.peer?.send(
			prepareDataMessageToSendScreenSourceType(sourceType),
		);
		await sendRemoteControlCapability(peerConnection);
	}

	if (dataJSON.type === 'get_remote_control_capability') {
		await sendRemoteControlCapability(peerConnection);
	}

	if (dataJSON.type === 'remote_input') {
		await handleRemoteInput(peerConnection, dataJSON.payload as RemoteInputPayload);
	}
}

/**
 * Send karaoke overlay info over the data channel to the receiver.
 * Called periodically from the karaoke panel to push the current song title.
 */
export function sendKaraokeInfoToReceiver(
	peerConnection: PeerConnection,
	title: string,
): void {
	if (!peerConnection.peer || !title) return;
	try {
		peerConnection.peer.send(
			JSON.stringify({
				type: 'karaoke_info',
				payload: { title },
			}),
		);
	} catch (_) {
		// ignore closed data channel
	}
}

export function resetRemoteControlSessionNotification(): void {
	remoteControlSessionNotified = false;
}
