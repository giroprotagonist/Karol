import getDesktopSourceStreamBySourceID from './getDesktopSourceStreamBySourceID';
import getDisplayMediaStream from './getDisplayMediaStream';
import DesktopCapturerSourceType from '../../../../common/DesktopCapturerSourceType';
import { IpcEvents } from '../../../../common/IpcEvents.enum';

async function captureWithSourceId(
	peerConnection: PeerConnection,
	sourceID: string,
): Promise<MediaStream> {
	if (sourceID.includes(DesktopCapturerSourceType.SCREEN)) {
		return getDesktopSourceStreamBySourceID(
			sourceID,
			peerConnection.sourceDisplaySize?.width,
			peerConnection.sourceDisplaySize?.height,
			0.5,
			1,
		);
	}

	return getDesktopSourceStreamBySourceID(sourceID);
}

export default async function createDesktopCapturerStream(
	peerConnection: PeerConnection,
	sourceID: string,
): Promise<void> {
	if (process.env.RUN_MODE === 'test') return;

	const trimmedSourceId = sourceID.trim();

	try {
		if (trimmedSourceId !== '') {
			peerConnection.localStream = await captureWithSourceId(
				peerConnection,
				trimmedSourceId,
			);
			return;
		}
	} catch (error) {
		console.warn(
			'desktop capturer source capture failed, trying alternate sources',
			error,
		);
	}

	if (trimmedSourceId.includes(DesktopCapturerSourceType.WINDOW)) {
		try {
			const { sourceId: ytSourceId } = (await window.electron.ipcRenderer.invoke(
				IpcEvents.YOUTUBE_DJ_GET_CAPTURER_SOURCE_ID,
			)) as { sourceId: string | null };
			if (ytSourceId && ytSourceId !== trimmedSourceId) {
				peerConnection.localStream = await captureWithSourceId(
					peerConnection,
					ytSourceId,
				);
				return;
			}
		} catch (ytResolveError) {
			console.warn('youtube capturer resolve failed', ytResolveError);
		}
	}

	try {
		const isEntireScreenToShareChosen =
			trimmedSourceId === '' ||
			trimmedSourceId.includes(DesktopCapturerSourceType.SCREEN);
		const { ids } = await window.electron.ipcRenderer.invoke(
			IpcEvents.GetDesktopSharingSourceIds,
			{ isEntireScreenToShareChosen },
		);
		for (const sourceId of ids as string[]) {
			if (sourceId === trimmedSourceId) {
				continue;
			}
			try {
				peerConnection.localStream = await captureWithSourceId(
					peerConnection,
					sourceId,
				);
				return;
			} catch (alternateSourceError) {
				console.warn(
					'alternate desktop capturer source failed',
					sourceId,
					alternateSourceError,
				);
			}
		}
	} catch (listSourcesError) {
		console.warn('failed to list alternate screen sources', listSourcesError);
	}

	peerConnection.localStream = await getDisplayMediaStream(true);
}
