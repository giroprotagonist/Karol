import { session } from 'electron';
import type { DesktopCapturerSource } from 'electron';
import getScreenCapturePermissionStatus from '../utils/getScreenCapturePermissionStatus';
import DesktopCapturerSourceType from '../../common/DesktopCapturerSourceType';
import { getDeskreenGlobal } from './getDeskreenGlobal';

let preferredCapturerSourceId = '';

export function setPreferredDesktopCapturerSourceId(sourceId: string): void {
	preferredCapturerSourceId = sourceId.trim();
}

export function getPreferredDesktopCapturerSourceId(): string {
	return preferredCapturerSourceId;
}

async function pickDesktopCapturerSource(
	audioRequested: boolean,
): Promise<DesktopCapturerSource | null> {
	const capturerService = getDeskreenGlobal()?.desktopCapturerSourcesService;

	if (preferredCapturerSourceId !== '' && capturerService) {
		const cached = capturerService.getCachedCapturerSourceById(
			preferredCapturerSourceId,
		);
		if (cached) {
			return cached;
		}
	}

	if (capturerService?.isCaptureSessionActive()) {
		console.error(
			'display media handler: capture already active and source not cached',
			preferredCapturerSourceId || '(none)',
		);
		return null;
	}

	const types =
		preferredCapturerSourceId.includes(DesktopCapturerSourceType.WINDOW)
			? [DesktopCapturerSourceType.WINDOW, DesktopCapturerSourceType.SCREEN]
			: [DesktopCapturerSourceType.SCREEN, DesktopCapturerSourceType.WINDOW];

	const sources = capturerService
		? await capturerService.safeGetSourcesList(
				{
					types,
					thumbnailSize: { width: 1, height: 1 },
				},
				'displayMediaHandler',
			)
		: [];

	if (sources.length === 0) {
		return null;
	}

	if (preferredCapturerSourceId !== '') {
		const preferred = sources.find(
			(source) => source.id === preferredCapturerSourceId,
		);
		if (preferred) {
			return preferred;
		}
		// Do not silently fall back to another source when the user (or session)
		// explicitly chose one — that made window picks share the entire screen.
		return null;
	}

	const firstScreen = sources.find((source) =>
		source.id.includes(DesktopCapturerSourceType.SCREEN),
	);
	return firstScreen ?? sources[0] ?? null;
}

export default function configureScreenCaptureSession(): void {
	const defaultSession = session.defaultSession;

	defaultSession.setPermissionRequestHandler(
		(_webContents, permission, callback) => {
			if (
				permission === 'display-capture' ||
				permission === 'media' ||
				permission === 'audioCapture'
			) {
				callback(true);
				return;
			}
			callback(false);
		},
	);

	defaultSession.setPermissionCheckHandler((_webContents, permission) => {
		return (
			permission === 'display-capture' ||
			permission === 'media' ||
			permission === 'audioCapture'
		);
	});

	defaultSession.setDisplayMediaRequestHandler(
		async (request, callback) => {
			const capturerService = getDeskreenGlobal()?.desktopCapturerSourcesService;
			const hadActiveCapture = capturerService?.isCaptureSessionActive() ?? false;
			try {
				const selected = await pickDesktopCapturerSource(
					request.audioRequested,
				);
				if (!selected) {
					if (!hadActiveCapture) {
						capturerService?.setCaptureSessionActive(false);
					}
					callback({});
					return;
				}

				if (!hadActiveCapture) {
					capturerService?.setCaptureSessionActive(true);
				}
				callback({
					video: selected,
					audio: 'loopback',
				});
			} catch (error) {
				if (!hadActiveCapture) {
					capturerService?.setCaptureSessionActive(false);
				}
				console.error('display media request handler failed', error);
				callback({});
			}
		},
		{ useSystemPicker: false },
	);
}

export async function probeScreenCaptureAccess(): Promise<boolean> {
	if (process.platform !== 'darwin') {
		return true;
	}

	const status = getScreenCapturePermissionStatus();
	if (status === 'granted') {
		return true;
	}

	const capturerService = getDeskreenGlobal()?.desktopCapturerSourcesService;
	if (capturerService) {
		const ok = await capturerService.probeScreenCaptureAccess();
		return ok || getScreenCapturePermissionStatus() === 'granted';
	}

	return false;
}

export async function requestScreenCaptureAccessOnStartup(): Promise<void> {
	if (process.platform !== 'darwin') {
		return;
	}

	if (getScreenCapturePermissionStatus() === 'granted') {
		return;
	}

	await probeScreenCaptureAccess();
}
