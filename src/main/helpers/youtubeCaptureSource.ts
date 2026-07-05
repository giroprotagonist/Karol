import { store } from '../../common/deskreen-electron-store';
import { ElectronStoreKeys } from '../../common/ElectronStoreKeys.enum';
import {
	getPreferredDesktopCapturerSourceId,
	setPreferredDesktopCapturerSourceId,
} from './configureScreenCaptureSession';
import { getDeskreenGlobal } from './getDeskreenGlobal';
import {
	isYouTubeOutputCapturerSourceName,
	isYouTubeWindowOpen,
} from './youtubeOutputPlayer';

function resolveYouTubeCapturerSource(): {
	source: import('electron').DesktopCapturerSource;
	from: string;
} | null {
	const capturerService = getDeskreenGlobal().desktopCapturerSourcesService;
	const captureActive = capturerService.isCaptureSessionActive();

	const byName = capturerService.getYouTubeWindowSource();
	if (byName) {
		return { source: byName, from: 'name-match' };
	}

	if (captureActive) {
		const preferred = getPreferredDesktopCapturerSourceId();
		const cached = preferred
			? capturerService.getCachedCapturerSourceById(preferred)
			: null;
		if (cached && isYouTubeOutputCapturerSourceName(cached.name)) {
			return { source: cached, from: 'active-preferred' };
		}

		const savedId = store.get(ElectronStoreKeys.LastDesktopCapturerSourceId);
		if (typeof savedId === 'string' && savedId !== '') {
			const saved = capturerService.getCachedCapturerSourceById(savedId);
			if (saved && isYouTubeOutputCapturerSourceName(saved.name)) {
				return { source: saved, from: 'saved-id' };
			}
		}
	}

	return null;
}

export async function autoSelectYouTubeWindowSource(): Promise<string | null> {
	if (!isYouTubeWindowOpen()) {
		return null;
	}

	const deskreenGlobal = getDeskreenGlobal();
	const capturerService = deskreenGlobal.desktopCapturerSourcesService;
	const captureActive = capturerService.isCaptureSessionActive();

	if (!captureActive) {
		await capturerService.refreshDesktopCapturerSources();
	}

	let resolved = resolveYouTubeCapturerSource();
	if (!resolved && !captureActive) {
		await capturerService.refreshDesktopCapturerSources();
		resolved = resolveYouTubeCapturerSource();
	}

	if (!resolved) {
		return null;
	}

	const { source, from } = resolved;
	const id = source.id;

	capturerService.registerCachedWindowSource(source);
	setPreferredDesktopCapturerSourceId(id);
	store.set(ElectronStoreKeys.LastDesktopCapturerSourceId, id);

	if (!captureActive) {
		const waitingSession =
			deskreenGlobal.sharingSessionService.waitingForConnectionSharingSession;
		waitingSession?.setDesktopCapturerSourceID(id);

		const sessions = deskreenGlobal.sharingSessionService.sharingSessions;
		for (const [, session] of sessions) {
			session.setDesktopCapturerSourceID(id);
		}
	}

	console.log('[YT_DJ] auto-selected window source:', id, `(${from})`);
	return id;
}

export async function resolveYouTubeCapturerSourceId(): Promise<string | null> {
	if (!isYouTubeWindowOpen()) {
		return null;
	}

	const capturerService = getDeskreenGlobal().desktopCapturerSourcesService;
	if (!capturerService.isCaptureSessionActive()) {
		await capturerService.refreshDesktopCapturerSources();
	}

	return resolveYouTubeCapturerSource()?.source.id ?? null;
}
