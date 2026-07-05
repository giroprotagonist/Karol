import NullSimplePeer from './NullSimplePeer';

export default (peerConnection: PeerConnection): void => {
	if (peerConnection.isSocketRoomLocked) {
		peerConnection.toggleLockRoom(false);
		if (peerConnection.isCallStarted) {
			const videoTrack = peerConnection.localStream?.getVideoTracks()[0];
			if (videoTrack && videoTrack.readyState !== 'ended') {
				// Capture track is still live — the peer died but the stream is fine.
				// Reset peer state and mark the room for reconnection instead of destroying.
				console.warn('[RECONNECT] user exited but capture track is live — awaiting reconnect');
				peerConnection.awaitingReconnect = true;
				// clean up dead peer
				if (peerConnection.peer !== NullSimplePeer) {
					try {
						peerConnection.peer.removeAllListeners();
						peerConnection.peer.destroy();
					} catch (e) {
						console.error('[RECONNECT] error cleaning up dead peer:', e);
					}
					peerConnection.peer = NullSimplePeer;
				}
				peerConnection.isCallStarted = false;
				peerConnection.pendingCallPeer = false;
				peerConnection.signalsDataToCallUser = [];
				peerConnection.sentCallSignalCount = 0;
				return;
			}
			peerConnection.selfDestroy();
		}
	}
};
