import {
	prepareDataMessageToChangeQuality,
	prepareDataMessageToGetSharingSourceType,
	prepareDataMessageToGetRemoteControlCapability,
} from './simplePeerDataMessages';
import { VideoQuality } from '../VideoAutoQualityOptimizer/VideoQualityEnum';
import { ErrorMessage } from '../../components/ErrorDialog/ErrorMessageEnum';
import {
	DEFAULT_TRACK_ENDED_GRACE_MS,
	RECEIVER_TRACK_ENDED_GRACE_MS,
} from '../../constants/castReliabilityConstants';
import PeerConnectionPeerIsNullError from './errors/PeerConnectionPeerIsNullError';
import { ScreenSharingSource } from './ScreenSharingSourceEnum';
import isReceiverMode, {
	isMobilePlaybackDevice,
} from '../../utils/isReceiverMode';
import {
	applyReceiverQualityBufferFromPreference,
	getPeerConnectionFromSimplePeer,
	registerReceiverPeerConnection,
} from '../../utils/receiverJitterBuffer';

export function getSharingShourceType(peerConnection: PeerConnection) {
	try {
		if (!peerConnection.peer || !peerConnection.isStreamStarted) {
			return;
		}
		// Access the underlying RTCDataChannel to verify it's open before calling send()
		const simplePeer = peerConnection.peer as any;
		if (!simplePeer._channel || simplePeer._channel.readyState !== 'open') {
			return; // data channel not ready yet, retry on next interval
		}
		peerConnection.peer.send(prepareDataMessageToGetSharingSourceType());
		peerConnection.peer.send(prepareDataMessageToGetRemoteControlCapability());
	} catch (e) {
		console.log(e);
	}
}

export default (peerConnection: PeerConnection) => {
	if (peerConnection.peer === null) {
		throw new PeerConnectionPeerIsNullError();
	}
	peerConnection.peer.on('stream', (stream) => {
		peerConnection.setUrlCallback(stream);

		if (isReceiverMode() && peerConnection.peer) {
			const pc = getPeerConnectionFromSimplePeer(peerConnection.peer);
			registerReceiverPeerConnection(pc);
			applyReceiverQualityBufferFromPreference();
		}

		let remoteTrackEndedTimeout: ReturnType<typeof setTimeout> | null = null;
		const trackEndedGraceMs = isReceiverMode()
			? RECEIVER_TRACK_ENDED_GRACE_MS
			: DEFAULT_TRACK_ENDED_GRACE_MS;

		const clearRemoteTrackEndedTimeout = () => {
			if (remoteTrackEndedTimeout) {
				clearTimeout(remoteTrackEndedTimeout);
				remoteTrackEndedTimeout = null;
			}
		};

		const scheduleRemoteTrackEndedDisconnect = () => {
			clearRemoteTrackEndedTimeout();
			remoteTrackEndedTimeout = setTimeout(() => {
				remoteTrackEndedTimeout = null;
				if (!peerConnection.isStreamStarted) {
					return;
				}
				const currentTrack = stream.getVideoTracks()[0];
				if (currentTrack && currentTrack.readyState === 'live') {
					return;
				}
				peerConnection.stopStream();
				peerConnection.UIHandler.setIsErrorDialogOpen(true);
				peerConnection.UIHandler.errorDialogMessage =
					ErrorMessage.DISCONNECTED;
			}, trackEndedGraceMs);
		};

		const bindRemoteVideoTrackHandlers = (track: MediaStreamTrack) => {
			track.onended = () => {
				console.error('remote video track ended');
				scheduleRemoteTrackEndedDisconnect();
			};

			track.onunmute = () => {
				clearRemoteTrackEndedTimeout();
			};

			track.onmute = () => {
				// Host may briefly mute during capture recovery; wait before disconnecting.
				scheduleRemoteTrackEndedDisconnect();
			};
		};

		const videoTrack = stream.getVideoTracks()[0];
		if (videoTrack) {
			bindRemoteVideoTrackHandlers(videoTrack);
		}

		stream.onaddtrack = (event) => {
			if (event.track.kind === 'video') {
				clearRemoteTrackEndedTimeout();
				bindRemoteVideoTrackHandlers(event.track);
			}
			if (isReceiverMode()) {
				applyReceiverQualityBufferFromPreference();
			}
		};

		// Canvas pixel-readback every second crashes Android WebView renderers.
		const skipAutoQualityOptimizer =
			isReceiverMode() || isMobilePlaybackDevice();

		if (!skipAutoQualityOptimizer) {
			setTimeout(() => {
				peerConnection.videoAutoQualityOptimizer.setGoodQualityCallback(() => {
					if (peerConnection.videoQuality === VideoQuality.Q_AUTO) {
						try {
							peerConnection.peer?.send(prepareDataMessageToChangeQuality(1));
						} catch (e) {
							console.log(e);
						}
					}
				});

				peerConnection.videoAutoQualityOptimizer.setHalfQualityCallbak(() => {
					if (peerConnection.videoQuality === VideoQuality.Q_AUTO) {
						try {
							peerConnection.peer?.send(
								prepareDataMessageToChangeQuality(0.5),
							);
						} catch (e) {
							console.log(e);
						}
					}
				});
			}, 1000);

			if (peerConnection.videoQuality === VideoQuality.Q_AUTO) {
				peerConnection.videoAutoQualityOptimizer.startOptimizationLoop();
			}
		}

		setTimeout(getSharingShourceType, 1000, peerConnection);

		if (isReceiverMode()) {
			applyReceiverQualityBufferFromPreference();
			const jitterBufferRefresh = window.setInterval(() => {
				applyReceiverQualityBufferFromPreference();
			}, 5000);
			stream.addEventListener('inactive', () => {
				window.clearInterval(jitterBufferRefresh);
			});

			const capabilityPoll = window.setInterval(() => {
				getSharingShourceType(peerConnection);
			}, 8000);
			stream.addEventListener('inactive', () => {
				window.clearInterval(capabilityPoll);
			});
		}

		peerConnection.isStreamStarted = true;

		// if any transient error dialog was shown earlier, close it now
		try {
			peerConnection.UIHandler.setIsErrorDialogOpen(false);
			peerConnection.UIHandler.errorDialogMessage = ErrorMessage.UNKNOWN_ERROR;
		} catch (_) {
			// ignore
		}
	});

	peerConnection.peer.on('signal', (data) => {
		// fired when webrtc done preparation to start call on peerConnection machine
		peerConnection.sendEncryptedMessage({
			type: 'CALL_ACCEPTED',
			payload: {
				signalData: data,
			},
		});
	});

	peerConnection.peer.on('data', (data) => {
		const dataJSON = JSON.parse(data);

		if (dataJSON.type === 'screen_sharing_source_type') {
			peerConnection.screenSharingSourceType = dataJSON.payload.value;
			if (
				peerConnection.screenSharingSourceType === ScreenSharingSource.SCREEN ||
				peerConnection.screenSharingSourceType === ScreenSharingSource.WINDOW
			) {
				peerConnection.UIHandler.setScreenSharingSourceTypeCallback(
					peerConnection.screenSharingSourceType,
				);
			}
		}

		if (dataJSON.type === 'remote_control_capability') {
			peerConnection.UIHandler.setRemoteControlCapabilityCallback(
				dataJSON.payload,
			);
		}

		if (dataJSON.type === 'remote_input_result') {
			peerConnection.UIHandler.setRemoteInputResultCallback?.(
				dataJSON.payload,
			);
		}

		if (dataJSON.type === 'karaoke_info') {
			window.dispatchEvent(
				new CustomEvent('deskreen-karaoke-info', {
					detail: dataJSON.payload,
				}),
			);
		}
	});

	// Auto-recreate the peer on close so the tablet is ready when
	// the Mac side sends a fresh CALL_USER for reconnection
	peerConnection.peer.on('close', () => {
		console.warn('[TABLET_RECONNECT] peer closed — recreating for possible reconnect');
		peerConnection.peer?.removeAllListeners();
		peerConnection.peer?.destroy();
		peerConnection.createPeer();
	});

	peerConnection.peer.on('error', (e: Error) => {
		console.error('[TABLET_RECONNECT] peer error:', e?.message);
		// Let the close handler (if any) clean up — SimplePeer fires 'close' after 'error'
	});
};
