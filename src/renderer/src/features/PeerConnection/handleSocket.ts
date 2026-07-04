import handleSocketUserEnter from './handleSocketUserEnter';
import handleSocketUserExit from './handleSocketUserExit';

export default function handleSocket(peerConnection: PeerConnection): void {
	peerConnection.socket.removeAllListeners();

	let socketDisconnectGraceTimeout: ReturnType<typeof setTimeout> | null = null;

	peerConnection.socket.on('disconnect', (reason: string) => {
		console.warn('[HOST_SOCKET] disconnect — reason=', reason);
		// Match the client-viewer grace period: 15s for LAN sessions.
		// Do NOT selfDestroy immediately — the socket may reconnect.
		if (!peerConnection.isCallStarted) {
			// No active call yet, clean up
			peerConnection.selfDestroy();
			return;
		}
		if (socketDisconnectGraceTimeout) {
			clearTimeout(socketDisconnectGraceTimeout);
		}
		socketDisconnectGraceTimeout = setTimeout(() => {
			socketDisconnectGraceTimeout = null;
			// Grace expired — check if capture track is still alive
			const videoTrack = peerConnection.localStream?.getVideoTracks()[0];
			if (videoTrack && videoTrack.readyState !== 'ended') {
				console.warn('[HOST_SOCKET] grace expired but capture track still live — keeping session');
				return;
			}
			peerConnection.selfDestroy();
		}, 15000);
	});

	peerConnection.socket.on('connect', () => {
		if (socketDisconnectGraceTimeout) {
			clearTimeout(socketDisconnectGraceTimeout);
			socketDisconnectGraceTimeout = null;
			console.warn('[HOST_SOCKET] reconnected before grace expired');
		}
		peerConnection.emitUserEnter();
	});

	peerConnection.socket.on('error', (error: Error) => {
		console.error('[HOST_SOCKET] socket error:', error?.message);
		// Log only — let the disconnect handler decide whether to selfDestroy
	});

	peerConnection.socket.on(
		'USER_ENTER',
		(payload: { users: PartnerPeerUser[] }) => {
			handleSocketUserEnter(peerConnection, payload);
		},
	);

	peerConnection.socket.on('USER_EXIT', () => {
		handleSocketUserExit(peerConnection);
	});

	peerConnection.socket.on(
		'MESSAGE',
		(payload: ReceiveEncryptedMessagePayload) => {
			peerConnection.receiveEncryptedMessage(payload);
		},
	);

	peerConnection.socket.on('USER_DISCONNECT', () => {
		peerConnection.toggleLockRoom(false);
	});
}
