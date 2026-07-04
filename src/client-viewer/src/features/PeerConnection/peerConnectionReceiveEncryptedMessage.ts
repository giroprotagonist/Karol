import { ErrorMessage } from '../../components/ErrorDialog/ErrorMessageEnum';
import { process as processMessage } from '../../utils/message';
import NullUser from './NullUser';
import PeerConnectionUserIsNotDefinedError from './errors/PeerConnectionUserIsNotDefinedError';
import setAndShowErrorDialogMessage from './setAndShowErrorDialogMessage';
import isReceiverMode from '../../utils/isReceiverMode';

export default async (
	peerConnection: PeerConnection,
	payload: ReceiveEncryptedMessagePayload,
) => {
	if (peerConnection.user === NullUser) {
		throw new PeerConnectionUserIsNotDefinedError();
	}
	const message = await processMessage(payload);
	// const message = payload as any;
	if (message.type === 'CALL_USER') {
		try {
			peerConnection.peer?.signal(message.payload.signalData);
		} catch (error) {
			console.warn('peer.signal failed during CALL_USER', error);
		}
	}
	if (message.type === 'DENY_TO_CONNECT') {
		setAndShowErrorDialogMessage(peerConnection, ErrorMessage.DENY_TO_CONNECT);
	}
	if (message.type === 'DISCONNECT_BY_HOST_MACHINE_USER') {
		// On the receiver (tablet), auto-reload to the root URL so
		// LAN auto‑discovery finds the new waiting session immediately.
		if (isReceiverMode()) {
			window.location.href = window.location.origin;
			return;
		}
		setAndShowErrorDialogMessage(peerConnection, ErrorMessage.DISCONNECTED);
	}
	if (message.type === 'ALLOWED_TO_CONNECT') {
		peerConnection.UIHandler.hostAllowedToConnectCallback();
	}
	if (message.type === 'APP_LANGUAGE') {
		peerConnection.UIHandler.setAppLanguageCallback(message.payload.value);
	}
};
