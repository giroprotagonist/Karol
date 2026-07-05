// import SimplePeer from 'simple-peer';
import createDesktopCapturerStream from './createDesktopCapturerStream';
import handlePeerOnData from './handlePeerOnData';
import NullSimplePeer from './NullSimplePeer';
import getDesktopSourceStreamBySourceID from './getDesktopSourceStreamBySourceID';
import DesktopCapturerSourceType from '../../../../common/DesktopCapturerSourceType';
import setHostCaptureSessionActive from './setHostCaptureSessionActive';
import syncHostCastAudioOutput from './syncHostCastAudioOutput';
import { releaseHostMonoAudioMix } from './hostMonoAudioMix';
import simplePeerHandleSdpTransform from './simplePeerHandleSdpTransform';
import { applyHostStreamEncodingPreferences } from './applyHostStreamEncoding';

const MAX_CAPTURE_RECOVERY_ATTEMPTS = 8;

export function attachCaptureTrackEndedHandler(
	peerConnection: PeerConnection,
	videoTrack: MediaStreamTrack,
): void {
	let recoveryAttempts = 0;

	const recoverCapture = async (endedTrack: MediaStreamTrack): Promise<void> => {
		console.warn('[RECOVER] attempt', recoveryAttempts + 1, 'of', MAX_CAPTURE_RECOVERY_ATTEMPTS);
		if (peerConnection.peer === NullSimplePeer || !peerConnection.localStream) {
			console.warn('[RECOVER] bail — peer is null or no localStream');
			return;
		}

		recoveryAttempts += 1;
		if (recoveryAttempts > MAX_CAPTURE_RECOVERY_ATTEMPTS) {
			console.error(
				'desktop capture track ended and recovery attempts exhausted',
			);
			console.warn('[RECOVER] exhaustion -> selfDestroy');
			void setHostCaptureSessionActive(false);
			peerConnection.selfDestroy();
			return;
		}

		try {
			const sourceId = peerConnection.desktopCapturerSourceID;
			const newStream = sourceId.includes(DesktopCapturerSourceType.SCREEN)
				? await getDesktopSourceStreamBySourceID(
						sourceId,
						peerConnection.sourceDisplaySize?.width,
						peerConnection.sourceDisplaySize?.height,
						0.5,
						1,
					)
				: await getDesktopSourceStreamBySourceID(sourceId);
			const newTrack = newStream.getVideoTracks()[0];
			if (!newTrack) {
				throw new Error('recovered stream has no video track');
			}

			const oldStream = peerConnection.localStream;
			if (!oldStream) {
				return;
			}

			releaseHostMonoAudioMix(oldStream);

			await peerConnection.peer.replaceTrack(
				endedTrack,
				newTrack,
				oldStream,
			);
			endedTrack.stop();
			peerConnection.localStream = newStream;
			recoveryAttempts = 0;
			void syncHostCastAudioOutput(newStream, true);
			attachCaptureTrackEndedHandler(peerConnection, newTrack);
		} catch (error) {
			console.error(
				`failed to recover desktop capture after track ended (attempt ${recoveryAttempts}/${MAX_CAPTURE_RECOVERY_ATTEMPTS})`,
				error,
			);
			if (recoveryAttempts >= MAX_CAPTURE_RECOVERY_ATTEMPTS) {
				void setHostCaptureSessionActive(false);
				peerConnection.selfDestroy();
				return;
			}
			setTimeout(() => {
				void recoverCapture(endedTrack);
			}, 1500 * recoveryAttempts);
		}
	};

	videoTrack.onended = () => {
		console.error('[RECOVER] desktop capture track ended unexpectedly — starting recovery');
		void recoverCapture(videoTrack);
	};
}

export default function handleCreatePeer(
	peerConnection: PeerConnection,
): Promise<void> {
	return new Promise((resolve, reject) => {
		// cleanup existing peer before creating new one
		if (peerConnection.peer !== NullSimplePeer) {
			try {
				peerConnection.peer.removeAllListeners();
				peerConnection.peer.destroy();
			} catch (error) {
				console.error('Error cleaning up existing peer:', error);
			}
			peerConnection.peer = NullSimplePeer;
		}

		// cleanup existing stream before creating new one
		if (peerConnection.localStream) {
			void syncHostCastAudioOutput(null, false);
			void setHostCaptureSessionActive(false);
			releaseHostMonoAudioMix(peerConnection.localStream);
			peerConnection.localStream.getTracks().forEach((track) => {
				track.stop();
			});
			peerConnection.localStream = null;
		}

		// clear old signals when recreating peer; keep pendingCallPeer so a
		// callPeer that arrived before capture finished still goes out afterward
		peerConnection.signalsDataToCallUser = [];
		peerConnection.sentCallSignalCount = 0;
		peerConnection.isCallStarted = false;

		createDesktopCapturerStream(
			peerConnection,
			peerConnection.desktopCapturerSourceID,
		)
			.then(() => {
				if (peerConnection.localStream === null) {
					reject(new Error('Failed to capture desktop source stream'));
					return;
				}

				// if (peerConnection.peer === NullSimplePeer) {
				// eslint-disable-next-line @typescript-eslint/ban-ts-comment
				// @ts-ignore
				peerConnection.peer = new SimplePeer({
					initiator: true,
					config: {
						iceServers: [
							{ urls: 'stun:stun.l.google.com:19302' },
							{ urls: 'stun:stun1.l.google.com:19302' },
						],
					},
					sdpTransform: simplePeerHandleSdpTransform,
				});
				// }

				// TODO: basically here we need a client side simple peer, but we get a nodejs side simple peer
				if (peerConnection.localStream !== null) {
					peerConnection.peer.addStream(peerConnection.localStream);
					void syncHostCastAudioOutput(
						peerConnection.localStream,
						true,
					);
					const videoTrack =
						peerConnection.localStream.getVideoTracks()[0];
					if (videoTrack) {
						attachCaptureTrackEndedHandler(peerConnection, videoTrack);
					}
				}

				peerConnection.peer.on('signal', (data: string) => {
					// fired when simple peer and webrtc done preparation to start call on peerConnection machine
					peerConnection.signalsDataToCallUser.push(data);
					peerConnection.flushPendingCallSignals();
				});

				peerConnection.peer.on('data', (data) => {
					handlePeerOnData(peerConnection, data);
				});

				peerConnection.peer.on('connect', () => {
					applyHostStreamEncodingPreferences(peerConnection);
				});

		// ensure cleanup on peer end/error — but ONLY if the capture track
		// is actually dead.  A transient ICE disconnection (WiFi blip) will
		// fire 'close' even though the capture stream is still fine.
		// Track lifecycle (onended → recovery) is the authority.
		peerConnection.peer.on('close', () => {
			const videoTrack = peerConnection.localStream?.getVideoTracks()[0];
			console.warn('[SELF_DESTROY] peer.close fired — videoTrack=', !!videoTrack, 'readyState=', videoTrack?.readyState);
			if (!videoTrack || videoTrack.readyState === 'ended') {
				// Track is dead — clean up
				peerConnection.selfDestroy();
				return;
			}
			// Track is still live — keep the session alive
			// The capture track onended handler is the authority on session lifetime
			console.warn('[SELF_DESTROY] keeping session alive — capture track is still live');
		});

		peerConnection.peer.on('error', (e: Error) => {
			const videoTrack = peerConnection.localStream?.getVideoTracks()[0];
			console.error('[SELF_DESTROY] peer.error fired:', e?.message, 'readyState=', videoTrack?.readyState);
			if (!videoTrack || videoTrack.readyState === 'ended') {
				peerConnection.selfDestroy();
				return;
			}
			console.warn('[SELF_DESTROY] keeping session alive despite peer error — capture track is still live');
		});
				resolve(undefined);
			})
			.catch((e) => {
				console.error(e);
				reject();
			});
	});
}

/** Recreate the WebRTC peer using the existing localStream (no capture restart). */
export function warmReconnectPeer(peerConnection: PeerConnection): Promise<void> {
	return new Promise((resolve, reject) => {
		const stream = peerConnection.localStream;
		if (!stream) {
			reject(new Error('warmReconnectPeer: no existing localStream'));
			return;
		}

		// cleanup old peer
		if (peerConnection.peer !== NullSimplePeer) {
			try {
				peerConnection.peer.removeAllListeners();
				peerConnection.peer.destroy();
			} catch (error) {
				console.error('warmReconnectPeer: error cleaning up existing peer:', error);
			}
			peerConnection.peer = NullSimplePeer;
		}

		// reset signal state for fresh handshake
		peerConnection.signalsDataToCallUser = [];
		peerConnection.sentCallSignalCount = 0;
		peerConnection.isCallStarted = false;

		// @ts-ignore
		const newPeer = new SimplePeer({
			initiator: true,
			config: {
				iceServers: [
					{ urls: 'stun:stun.l.google.com:19302' },
					{ urls: 'stun:stun1.l.google.com:19302' },
				],
			},
			sdpTransform: simplePeerHandleSdpTransform,
		});

		newPeer.addStream(stream);

		newPeer.on('signal', (data: string) => {
			peerConnection.signalsDataToCallUser.push(data);
			peerConnection.flushPendingCallSignals();
		});

		newPeer.on('data', (data) => {
			handlePeerOnData(peerConnection, data);
		});

		newPeer.on('close', () => {
			const videoTrack = peerConnection.localStream?.getVideoTracks()[0];
			console.warn('[RECONNECT] warmReconnect peer.close — readyState=', videoTrack?.readyState);
			if (!videoTrack || videoTrack.readyState === 'ended') {
				peerConnection.selfDestroy();
				return;
			}
			console.warn('[RECONNECT] keeping session alive — capture track is still live');
		});

		newPeer.on('error', (e: Error) => {
			const videoTrack = peerConnection.localStream?.getVideoTracks()[0];
			console.error('[RECONNECT] warmReconnect peer.error:', e?.message, 'readyState=', videoTrack?.readyState);
			if (!videoTrack || videoTrack.readyState === 'ended') {
				peerConnection.selfDestroy();
				return;
			}
			console.warn('[RECONNECT] keeping session alive despite peer error');
		});

		peerConnection.peer = newPeer;
		console.warn('[RECONNECT] warm peer created, ready for new handshake');
		resolve(undefined);
	});
}
