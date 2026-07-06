import { app, BrowserWindow } from 'electron';
import { store } from '../../common/deskreen-electron-store';
import { ElectronStoreKeys } from '../../common/ElectronStoreKeys.enum';
import { IpcEvents } from '../../common/IpcEvents.enum';
import { signalingServer } from '../../server';
import { stopLogBufferCleanup } from '../utils/LoggerWithFilePrefix';
import { closeYouTubePlayerWindow } from './youtubeOutputPlayer';
import { stopPlaylistSyncPolling } from './youtubePlaylistSync';
import { cleanupDeskreenSessions } from './cleanupDeskreenSessions';
import { closeYouTubeQueueWindow } from './youtubeQueueWindow';
import { clearPendingDjApiRequests } from './youtubeDjApiBridge';
import { getDeskreenGlobal } from './getDeskreenGlobal';

const SHUTDOWN_HARD_TIMEOUT_MS = 6000;

let shutdownStarted = false;
let shutdownComplete = false;

export function isDeskreenShutdownComplete(): boolean {
	return shutdownComplete;
}

export function requestDeskreenQuit(): void {
	app.quit();
}

export async function shutdownDeskreen(reason: string): Promise<void> {
	if (shutdownStarted) {
		return;
	}
	shutdownStarted = true;

	console.info(`[deskreen-shutdown] starting (${reason})`);

	const hardTimeout = setTimeout(() => {
		console.warn('[deskreen-shutdown] hard timeout — forcing exit');
		app.exit(0);
	}, SHUTDOWN_HARD_TIMEOUT_MS);

	try {
		store.delete(ElectronStoreKeys.YouTubeKaraokeActive as string);
		clearPendingDjApiRequests();
		closeYouTubeQueueWindow();
		closeYouTubePlayerWindow();
		stopPlaylistSyncPolling();

		await notifyHelperRenderersToShutdownPeers();

		cleanupDeskreenSessions();

		signalingServer.stop();
		stopLogBufferCleanup();

		for (const win of BrowserWindow.getAllWindows()) {
			if (!win.isDestroyed()) {
				win.removeAllListeners('close');
				win.close();
			}
		}

		shutdownComplete = true;
		console.info('[deskreen-shutdown] complete');
	} catch (error) {
		console.error('[deskreen-shutdown] error during teardown', error);
		shutdownComplete = true;
	} finally {
		clearTimeout(hardTimeout);
	}
}

async function notifyHelperRenderersToShutdownPeers(): Promise<void> {
	const deskreenGlobal = getDeskreenGlobal();
	const helpers: BrowserWindow[] = [];

	for (const sharingSession of deskreenGlobal.sharingSessionService
		.sharingSessions.values()) {
		const helper = sharingSession.peerConnectionHelperRenderer;
		if (helper && !helper.isDestroyed()) {
			helpers.push(helper);
		}
	}
	const waiting =
		deskreenGlobal.sharingSessionService.waitingForConnectionSharingSession;
	const waitingHelper = waiting?.peerConnectionHelperRenderer;
	if (waitingHelper && !waitingHelper.isDestroyed()) {
		helpers.push(waitingHelper);
	}

	for (const helper of helpers) {
		helper.webContents.send(IpcEvents.DeskreenShutdownPeers);
	}

	await new Promise((resolve) => setTimeout(resolve, 800));
}
