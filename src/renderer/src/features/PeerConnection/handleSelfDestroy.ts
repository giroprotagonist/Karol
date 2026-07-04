import { IpcEvents } from '../../../../common/IpcEvents.enum';
import NullSimplePeer from './NullSimplePeer';
import NullUser from './NullUser';
import setHostCaptureSessionActive from './setHostCaptureSessionActive';
import syncHostCastAudioOutput from './syncHostCastAudioOutput';
import { resetRemoteControlSessionNotification } from './handlePeerOnData';

export default function handleSelfDestroy(
	peerConnection: PeerConnection,
): void {
	console.warn('[SELF_DESTROY] called — capturing stack for diagnostics', new Error().stack);
	resetRemoteControlSessionNotification();
	peerConnection.partner = NullUser;
	window.electron.ipcRenderer.invoke(
		IpcEvents.DisconnectDeviceById,
		peerConnection.partnerDeviceDetails.id,
	);

	// remove window event listener
	if (peerConnection.beforeunloadHandler) {
		window.removeEventListener(
			'beforeunload',
			peerConnection.beforeunloadHandler,
		);
		peerConnection.beforeunloadHandler = null;
	}

	// cleanup peer connection and remove all event listeners
	if (peerConnection.peer !== NullSimplePeer) {
		try {
			// remove all event listeners before destroying
			peerConnection.peer.removeAllListeners();
			peerConnection.peer.destroy();
		} catch (error) {
			console.error('Error destroying peer:', error);
		}
		peerConnection.peer = NullSimplePeer;
	}

	// cleanup media stream
	if (peerConnection.localStream) {
		void syncHostCastAudioOutput(null, false);
		void setHostCaptureSessionActive(false);
		peerConnection.localStream.getTracks().forEach((track) => {
			track.stop();
		});
		peerConnection.localStream = null;
	}

	// cleanup socket
	peerConnection.socket.removeAllListeners();
	peerConnection.socket.disconnect();

	window.electron.ipcRenderer.invoke(
		IpcEvents.DestroySharingSessionById,
		peerConnection.sharingSessionID,
	);
	peerConnection.onDeviceConnectedCallback = () => {
		// reset callback after destruction
	};
	peerConnection.isCallStarted = false;
	peerConnection.pendingCallPeer = false;
	peerConnection.sentCallSignalCount = 0;
	peerConnection.signalsDataToCallUser = [];

	window.electron.ipcRenderer.invoke(
		IpcEvents.UnmarkRoomIDAsTaken,
		peerConnection.roomID,
	);
}
