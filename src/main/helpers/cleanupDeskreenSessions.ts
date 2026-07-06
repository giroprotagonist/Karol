import { ConnectedDevicesService } from '../../features/ConnectedDevicesService';
import RoomIDService from '../../server/RoomIDService';
import type SharingSession from '../../features/SharingSessionService/SharingSession';
import { getDeskreenGlobal } from './getDeskreenGlobal';

export function cleanupDeskreenSessions(): void {
	const deskreenGlobal = getDeskreenGlobal();
	deskreenGlobal.connectedDevicesService = new ConnectedDevicesService();
	deskreenGlobal.roomIDService = new RoomIDService();
	deskreenGlobal.sharingSessionService.sharingSessions.forEach(
		(sharingSession: SharingSession) => {
			sharingSession.denyConnectionForPartner();
			sharingSession.destroy();
		},
	);

	deskreenGlobal.rendererWebrtcHelpersService.helpers.forEach((helperWindow) => {
		if (!helperWindow.isDestroyed()) {
			helperWindow.removeAllListeners('close');
			helperWindow.close();
		}
	});

	deskreenGlobal.sharingSessionService.waitingForConnectionSharingSession =
		null;
	deskreenGlobal.rendererWebrtcHelpersService.helpers.clear();
	deskreenGlobal.sharingSessionService.sharingSessions.clear();
}
