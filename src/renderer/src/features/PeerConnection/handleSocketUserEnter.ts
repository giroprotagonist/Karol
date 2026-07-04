import { warmReconnectPeer } from './handleCreatePeer';

export default (
	peerConnection: PeerConnection,
	payload: { users: PartnerPeerUser[] },
): void => {
	const filteredPartner = payload.users.filter((user: PartnerPeerUser) => {
		return peerConnection.user.username !== user.username;
	});

	if (filteredPartner[0] === undefined) return;

	[peerConnection.partner] = filteredPartner;

	if (peerConnection.partner.username !== '') {
		peerConnection.toggleLockRoom(true);
		peerConnection.emitUserEnter();

		// Auto-reconnect: if we were waiting for the tablet to come back
		if (peerConnection.awaitingReconnect) {
			peerConnection.awaitingReconnect = false;
			console.warn('[RECONNECT] device re-entered — warm reconnecting peer');
			warmReconnectPeer(peerConnection).then(() => {
				peerConnection.pendingCallPeer = true;
				peerConnection.flushPendingCallSignals();
			}).catch((e) => {
				console.error('[RECONNECT] warm reconnect failed:', e);
				peerConnection.selfDestroy();
			});
		}
	}
};
