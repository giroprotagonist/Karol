import {
	Display,
	ipcMain,
	BrowserWindow,
	screen,
	clipboard,
	shell,
} from 'electron';
import i18n from '../configs/i18next.config';
import { ConnectedDevicesService } from '../../features/ConnectedDevicesService';
import SharingSession from '../../features/SharingSessionService/SharingSession';
import RoomIDService from '../../server/RoomIDService';
import { signalingServer } from '../../server';
import { onDeviceConnectedCallback } from '../../server/onDeviceConnectedCallback';
import SharingSessionStatusEnum from '../../features/SharingSessionService/SharingSessionStatusEnum';
import getMyLocalIpV4 from './getMyLocalIpV4';
import isWifiConnected from './isWifiConnected';
import { getDeskreenGlobal } from './getDeskreenGlobal';
import { IpcEvents } from '../../common/IpcEvents.enum';
import { ElectronStoreKeys } from '../../common/ElectronStoreKeys.enum';
import { store } from '../../common/deskreen-electron-store';
import DesktopCapturerSourceType from '../../common/DesktopCapturerSourceType';
import isLinuxWaylandSession from '../utils/isLinuxWaylandSession';
import getScreenCapturePermissionStatus from '../utils/getScreenCapturePermissionStatus';
import waitForPeerStreamReady from './waitForPeerStreamReady';
import {
	muteMacOutputVolume,
	restoreMacOutputVolume,
} from '../utils/macOutputVolume';
import {
	probeScreenCaptureAccess,
	setPreferredDesktopCapturerSourceId,
} from './configureScreenCaptureSession';
import {
	injectRemoteInputOnMac,
	isAccessibilityTrusted,
	isMacPlatform,
} from '../utils/macInputInjection';
import type { RemoteInputPayload } from '../../common/RemoteInputTypes';
import { initYouTubeKaraokeIpc } from './youtubeKaraokeIpc';

export const initIpcMainHandlers = (mainWindow: BrowserWindow): void => {
	ipcMain.on('client-changed-language', async (_, newLangCode) => {
		i18n.changeLanguage(newLangCode);
		if (store.has(ElectronStoreKeys.AppLanguage)) {
			if (store.get(ElectronStoreKeys.AppLanguage) === newLangCode) {
				return;
			}
			store.delete(ElectronStoreKeys.AppLanguage);
		}
		store.set(ElectronStoreKeys.AppLanguage, newLangCode);
	});

	ipcMain.handle('get-signaling-server-port', () => {
		if (mainWindow === null) return;
		mainWindow.webContents.send('sending-port-from-main', signalingServer.port);
	});

	ipcMain.handle('get-all-displays', () => {
		return screen.getAllDisplays();
	});

	ipcMain.handle('get-display-size-by-display-id', (_, displayID: string) => {
		const display = screen.getAllDisplays().find((d: Display) => {
			return `${d.id}` === displayID;
		});

		if (display) {
			return display.size;
		}
		return undefined;
	});

	ipcMain.handle('get-display-logical-size-by-display-id', (_, displayID: string) => {
		const display = screen.getAllDisplays().find((d: Display) => {
			return `${d.id}` === displayID;
		});

		if (display) {
			return {
				width: display.bounds.width,
				height: display.bounds.height,
			};
		}
		return undefined;
	});

	ipcMain.handle(IpcEvents.GetIsLinuxWaylandSession, () => {
		return isLinuxWaylandSession;
	});

	ipcMain.handle(
		IpcEvents.RequestDesktopCapturerPortalSource,
		async (_, { mode }: { mode: 'screen' | 'window' }) => {
			const types =
				mode === 'window'
					? [DesktopCapturerSourceType.WINDOW]
					: [DesktopCapturerSourceType.SCREEN];

			if (!isLinuxWaylandSession) {
				await getDeskreenGlobal().desktopCapturerSourcesService.refreshDesktopCapturerSources();
				if (mode === 'window') {
					const sources =
						getDeskreenGlobal().desktopCapturerSourcesService.getAppWindowSources();
					return sources[0]?.id ?? null;
				}
				const sources =
					getDeskreenGlobal().desktopCapturerSourcesService.getScreenSources();
				return sources[0]?.id ?? null;
			}

			const source =
				await getDeskreenGlobal().desktopCapturerSourcesService.requestPortalSource(
					types,
				);
			return source?.id ?? null;
		},
	);

	ipcMain.handle('main-window-onbeforeunload', () => {
		const deskreenGlobal = getDeskreenGlobal();
		deskreenGlobal.connectedDevicesService = new ConnectedDevicesService();
		deskreenGlobal.roomIDService = new RoomIDService();
		deskreenGlobal.sharingSessionService.sharingSessions.forEach(
			(sharingSession: SharingSession) => {
				sharingSession.denyConnectionForPartner();
				sharingSession.destroy();
			},
		);

		deskreenGlobal.rendererWebrtcHelpersService.helpers.forEach(
			(helperWindow) => {
				helperWindow.close();
			},
		);

		deskreenGlobal.sharingSessionService.waitingForConnectionSharingSession =
			null;
		deskreenGlobal.rendererWebrtcHelpersService.helpers.clear();
		deskreenGlobal.sharingSessionService.sharingSessions.clear();
	});

	ipcMain.handle('get-latest-version', () => {
		return getDeskreenGlobal().latestAppVersion;
	});

	ipcMain.handle('get-current-version', () => {
		return getDeskreenGlobal().currentAppVersion;
	});

	ipcMain.handle('get-local-lan-ip', async () => {
		const deskreenGlobal = getDeskreenGlobal();
		if (deskreenGlobal.cliLocalIp) {
			return deskreenGlobal.cliLocalIp;
		}
		const ip = getMyLocalIpV4();
		return ip;
	});

	ipcMain.handle('check-wifi-connection', async () => {
		return isWifiConnected();
	});

	ipcMain.handle(IpcEvents.GetPort, () => {
		return signalingServer.port;
	});

	ipcMain.handle(IpcEvents.GetAppPath, () => {
		const deskreenGlobal = getDeskreenGlobal();
		return deskreenGlobal.appPath;
	});

	ipcMain.handle(IpcEvents.UnmarkRoomIDAsTaken, (_, roomID) => {
		const deskreenGlobal = getDeskreenGlobal();
		deskreenGlobal.roomIDService.unmarkRoomIDAsTaken(roomID);
	});

	async function createWaitingForConnectionSharingSession(
		roomID?: string,
	): Promise<void> {
		try {
			const deskreenGlobal = getDeskreenGlobal();
			if (
				deskreenGlobal.sharingSessionService
					.waitingForConnectionSharingSession !== null
			) {
				return;
			}
			const waitingSession =
				await deskreenGlobal.sharingSessionService.createWaitingForConnectionSharingSession(
					roomID,
				);
			waitingSession.setOnDeviceConnectedCallback(onDeviceConnectedCallback);
		} catch (error) {
			console.error('Failed to create waiting sharing session', error);
		}
	}

	ipcMain.handle(
		IpcEvents.CreateWaitingForConnectionSharingSession,
		async (_, roomID?: string) => {
			await createWaitingForConnectionSharingSession(roomID);
		},
	);

	function resetWaitingForConnectionSharingSession(): void {
		const sharingSession =
			getDeskreenGlobal().sharingSessionService
				.waitingForConnectionSharingSession;
		const roomID = sharingSession?.roomID;
		sharingSession?.denyConnectionForPartner();
		sharingSession?.disconnectByHostMachineUser();
		sharingSession?.destroy();
		sharingSession?.setStatus(SharingSessionStatusEnum.NOT_CONNECTED);
		getDeskreenGlobal().sharingSessionService.sharingSessions.delete(
			sharingSession?.id as string,
		);
		if (roomID) {
			getDeskreenGlobal().roomIDService.unmarkRoomIDAsTaken(roomID);
		}
		getDeskreenGlobal().sharingSessionService.waitingForConnectionSharingSession =
			null;
	}

	ipcMain.handle(IpcEvents.ResetWaitingForConnectionSharingSession, () => {
		resetWaitingForConnectionSharingSession();
	});

	const removeViewerAvailabilityListener =
		getDeskreenGlobal().connectedDevicesService.addAvailabilityListener(
			(state) => {
				const isAvailable = state === 'available';
				const targetWindow = mainWindow?.isDestroyed() ? null : mainWindow;
				if (targetWindow) {
					targetWindow.webContents.send(
						IpcEvents.ViewerConnectionAvailabilityChanged,
						{
							isAvailable,
						},
					);
				}
				if (isAvailable) {
					void createWaitingForConnectionSharingSession();
				}
			},
		);

	mainWindow.on('closed', () => {
		removeViewerAvailabilityListener();
	});

	ipcMain.handle(IpcEvents.SetDeviceConnectedStatus, () => {
		if (
			getDeskreenGlobal().sharingSessionService
				.waitingForConnectionSharingSession !== null
		) {
			const sharingSession =
				getDeskreenGlobal().sharingSessionService
					.waitingForConnectionSharingSession;
			sharingSession?.setStatus(SharingSessionStatusEnum.CONNECTED);
		}
	});

	ipcMain.handle(
		IpcEvents.GetSourceDisplayIDByDesktopCapturerSourceID,
		(_, sourceId) => {
			return getDeskreenGlobal().desktopCapturerSourcesService.getSourceDisplayIDByDisplayCapturerSourceID(
				sourceId,
			);
		},
	);

	ipcMain.handle(
		IpcEvents.DisconnectPeerAndDestroySharingSessionBySessionID,
		(_, sessionId) => {
			const sharingSession =
				getDeskreenGlobal().sharingSessionService.sharingSessions.get(
					sessionId,
				);
			if (sharingSession) {
				getDeskreenGlobal().connectedDevicesService.disconnectDeviceByID(
					sharingSession.deviceID,
				);
			}
			sharingSession?.disconnectByHostMachineUser();
			sharingSession?.destroy();
			getDeskreenGlobal().sharingSessionService.sharingSessions.delete(
				sessionId,
			);
		},
	);

	ipcMain.handle(
		IpcEvents.GetDesktopCapturerSourceIdBySharingSessionId,
		(_, sessionId) => {
			return getDeskreenGlobal().sharingSessionService.sharingSessions.get(
				sessionId,
			)?.desktopCapturerSourceID;
		},
	);

	ipcMain.handle(IpcEvents.GetConnectedDevices, () => {
		return getDeskreenGlobal().connectedDevicesService.getDevices();
	});

	ipcMain.handle(IpcEvents.GetViewerConnectionAvailability, () => {
		return getDeskreenGlobal().connectedDevicesService.isSlotAvailable();
	});

	ipcMain.handle(IpcEvents.DisconnectDeviceById, (_, id) => {
		getDeskreenGlobal().connectedDevicesService.disconnectDeviceByID(id);
	});

	ipcMain.handle(IpcEvents.DisconnectAllDevices, () => {
		getDeskreenGlobal().connectedDevicesService.disconnectAllDevices();
	});

	ipcMain.handle(IpcEvents.AppLanguageChanged, (_, newLang) => {
		if (store.has(ElectronStoreKeys.AppLanguage)) {
			store.delete(ElectronStoreKeys.AppLanguage);
		}
		store.set(ElectronStoreKeys.AppLanguage, newLang);
		getDeskreenGlobal().sharingSessionService.sharingSessions.forEach(
			(sharingSession) => {
				sharingSession?.appLanguageChanged();
			},
		);
		i18n.changeLanguage(newLang);
	});

	ipcMain.handle(IpcEvents.GetDesktopCapturerServiceSourcesMap, () => {
		const map =
			getDeskreenGlobal().desktopCapturerSourcesService.getSourcesMap();
		const res = {};

		for (const key of map.keys()) {
			const source = map.get(key);
			// eslint-disable-next-line @typescript-eslint/ban-ts-comment
			// @ts-ignore
			res[key] = {
				source: {
					thumbnail: source?.source.thumbnail?.toDataURL(),
					appIcon: source?.source.appIcon?.toDataURL(),
					name: source?.source.name,
				},
			};
		}
		return res;
	});

	ipcMain.handle(
		IpcEvents.GetDesktopCapturerServiceSourcesByIds,
		(_, ids: string[]) => {
			const map =
				getDeskreenGlobal().desktopCapturerSourcesService.getSourcesMap();
			const res = {};

			ids.forEach((id) => {
				const source = map.get(id);
				if (!source) return;
				// eslint-disable-next-line @typescript-eslint/ban-ts-comment
				// @ts-ignore
				res[id] = {
					source: {
						thumbnail: source?.source.thumbnail?.toDataURL(),
						appIcon: source?.source.appIcon?.toDataURL(),
						name: source?.source.name,
					},
				};
			});
			return res;
		},
	);

	ipcMain.handle(
		IpcEvents.GetWaitingForConnectionSharingSessionSourceId,
		() => {
			return getDeskreenGlobal().sharingSessionService
				.waitingForConnectionSharingSession?.desktopCapturerSourceID;
		},
	);

	function startSharingOnWaitingForConnectionSharingSession(): void {
		const deskreenGlobal = getDeskreenGlobal();
		const { connectedDevicesService, sharingSessionService, roomIDService } =
			deskreenGlobal;
		if (!connectedDevicesService.isSlotAvailable()) {
			const waitingSession =
				sharingSessionService.waitingForConnectionSharingSession;
			waitingSession?.denyConnectionForPartner();
			waitingSession?.setStatus(SharingSessionStatusEnum.NOT_CONNECTED);
			sharingSessionService.waitingForConnectionSharingSession = null;
			connectedDevicesService.resetPendingConnectionDevice();
			return;
		}

		const pendingDevice = connectedDevicesService.pendingConnectionDevice;
		if (!pendingDevice.id) {
			return;
		}

		const sharingSession =
			sharingSessionService.waitingForConnectionSharingSession;
		if (sharingSession !== null) {
			roomIDService.unmarkRoomIDAsTaken(sharingSession.roomID);
		}

		try {
			connectedDevicesService.addDevice(pendingDevice);
		} catch (error) {
			console.error('failed to occupy single viewer slot', error);
			if (sharingSession !== null) {
				sharingSession.setStatus(SharingSessionStatusEnum.ERROR);
				sharingSession.denyConnectionForPartner();
				sharingSessionService.waitingForConnectionSharingSession = null;
			}
			connectedDevicesService.resetPendingConnectionDevice();
			return;
		}

		if (sharingSession !== null) {
			sharingSession.setStatus(SharingSessionStatusEnum.SHARING);
			sharingSessionService.sharingSessions.set(
				sharingSession.id,
				sharingSession,
			);
			sharingSessionService.waitingForConnectionSharingSession = null;
			sharingSession.callPeer();
		}

		connectedDevicesService.resetPendingConnectionDevice();
	}

	ipcMain.handle(
		IpcEvents.StartSharingOnWaitingForConnectionSharingSession,
		async () => {
			const sharingSession =
				getDeskreenGlobal().sharingSessionService
					.waitingForConnectionSharingSession;
			if (!sharingSession?.desktopCapturerSourceID) {
				return { ok: false, reason: 'no-source' };
			}
			const ready = await waitForPeerStreamReady(sharingSession, 120000);
			if (!ready) {
				return { ok: false, reason: 'no-source' };
			}
			startSharingOnWaitingForConnectionSharingSession();
			return { ok: true };
		},
	);

	ipcMain.handle(IpcEvents.GetPendingConnectionDevice, () => {
		return getDeskreenGlobal().connectedDevicesService.pendingConnectionDevice;
	});

	ipcMain.handle(IpcEvents.GetWaitingForConnectionSharingSessionRoomId, () => {
		if (
			getDeskreenGlobal().sharingSessionService
				.waitingForConnectionSharingSession === null
		) {
			return undefined;
		}
		return getDeskreenGlobal().sharingSessionService
			.waitingForConnectionSharingSession?.roomID;
	});

	ipcMain.handle(
		IpcEvents.GetDesktopSharingSourceIds,
		async (_, { isEntireScreenToShareChosen }) => {
			if (isLinuxWaylandSession) {
				return { ids: [] as string[], captureWorking: false };
			}

			const screenCaptureStatus = getScreenCapturePermissionStatus();
			if (screenCaptureStatus !== 'granted') {
				return {
					ids: [] as string[],
					screenCaptureStatus,
					captureWorking: false,
				};
			}

			await getDeskreenGlobal().desktopCapturerSourcesService.refreshDesktopCapturerSources();

			const ids =
				isEntireScreenToShareChosen === true
					? getDeskreenGlobal()
							.desktopCapturerSourcesService.getScreenSources()
							.map((source) => source.id)
					: getDeskreenGlobal()
							.desktopCapturerSourcesService.getAppWindowSources()
							.map((source) => source.id);

			const refreshError =
				getDeskreenGlobal().desktopCapturerSourcesService.getLastRefreshError();

			const captureWorking =
				ids.length > 0 ||
				(await getDeskreenGlobal().desktopCapturerSourcesService.probeScreenCaptureAccess());

			return {
				ids,
				screenCaptureStatus,
				captureWorking,
				error: refreshError ?? undefined,
			};
		},
	);

	ipcMain.handle(IpcEvents.GetScreenCapturePermissionStatus, () => {
		return getScreenCapturePermissionStatus();
	});

	ipcMain.handle(IpcEvents.OpenScreenCaptureSettings, () => {
		if (process.platform === 'darwin') {
			void shell.openExternal(
				'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
			);
		}
	});

	ipcMain.handle(IpcEvents.SetDesktopCapturerSourceId, (_, id) => {
		setPreferredDesktopCapturerSourceId(id ?? '');
		getDeskreenGlobal().sharingSessionService.waitingForConnectionSharingSession?.setDesktopCapturerSourceID(
			id,
		);
		if (id) {
			store.set(ElectronStoreKeys.LastDesktopCapturerSourceId, id);
		}
	});

	ipcMain.handle(
		IpcEvents.SetPreferredCapturerSourceIdForDisplayMedia,
		(_, id: string) => {
			setPreferredDesktopCapturerSourceId(id ?? '');
		},
	);

	ipcMain.handle(IpcEvents.SetHostCaptureSessionActive, (_, active: boolean) => {
		getDeskreenGlobal().desktopCapturerSourcesService.setCaptureSessionActive(
			Boolean(active),
			active ? 'ipc-start' : 'ipc-stop',
		);
		if (!active) {
			restoreMacOutputVolume();
		}
	});

	ipcMain.handle(IpcEvents.GetMuteMacSpeakersWhileCasting, () => {
		if (store.has(ElectronStoreKeys.MuteMacSpeakersWhileCasting)) {
			return store.get(ElectronStoreKeys.MuteMacSpeakersWhileCasting) !== 'false';
		}
		return true;
	});

	ipcMain.handle(IpcEvents.SetMuteMacSpeakersWhileCasting, (_, enabled: boolean) => {
		store.set(
			ElectronStoreKeys.MuteMacSpeakersWhileCasting,
			enabled ? 'true' : 'false',
		);
		if (!enabled) {
			restoreMacOutputVolume();
		}
	});

	ipcMain.handle(IpcEvents.GetAllowTabletControlWhileCasting, () => {
		if (store.has(ElectronStoreKeys.AllowTabletControlWhileCasting)) {
			return (
				store.get(ElectronStoreKeys.AllowTabletControlWhileCasting) === 'true'
			);
		}
		return false;
	});

	ipcMain.handle(
		IpcEvents.SetAllowTabletControlWhileCasting,
		(_, enabled: boolean) => {
			store.set(
				ElectronStoreKeys.AllowTabletControlWhileCasting,
				enabled ? 'true' : 'false',
			);
			if (enabled && isMacPlatform()) {
				isAccessibilityTrusted(true);
			}
		},
	);

	ipcMain.handle(IpcEvents.CheckMacAccessibilityForRemoteControl, () => {
		if (!isMacPlatform()) {
			return false;
		}
		return isAccessibilityTrusted(true);
	});

	ipcMain.handle(
		IpcEvents.InjectRemoteInput,
		(
			_,
			args: {
				displayID: string;
				desktopCapturerSourceID?: string;
				payload: RemoteInputPayload;
			},
		) => {
			if (
				!store.has(ElectronStoreKeys.AllowTabletControlWhileCasting) ||
				store.get(ElectronStoreKeys.AllowTabletControlWhileCasting) !== 'true'
			) {
				return { ok: false, reason: 'disabled' };
			}
			return injectRemoteInputOnMac(
				args.displayID,
				args.desktopCapturerSourceID ?? '',
				args.payload,
			);
		},
	);

	ipcMain.on(IpcEvents.RemoteControlSessionActive, (_, active: boolean) => {
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send(IpcEvents.RemoteControlSessionActive, active);
		}
	});

	ipcMain.handle(IpcEvents.SyncMacCastAudioOutput, (_, shouldMuteMac: boolean) => {
		const muteEnabled =
			!store.has(ElectronStoreKeys.MuteMacSpeakersWhileCasting) ||
			store.get(ElectronStoreKeys.MuteMacSpeakersWhileCasting) !== 'false';
		if (shouldMuteMac && muteEnabled) {
			muteMacOutputVolume();
			return;
		}
		restoreMacOutputVolume();
	});

	ipcMain.handle(IpcEvents.GetOrPickDefaultSharingSourceId, async () => {
		await getDeskreenGlobal().desktopCapturerSourcesService.refreshDesktopCapturerSources();
		const sourcesMap =
			getDeskreenGlobal().desktopCapturerSourcesService.getSourcesMap();

		const savedId = store.get(ElectronStoreKeys.LastDesktopCapturerSourceId);
		if (typeof savedId === 'string' && savedId !== '' && sourcesMap.has(savedId)) {
			return savedId;
		}

		const screens =
			getDeskreenGlobal().desktopCapturerSourcesService.getScreenSources();
		if (screens.length > 0) {
			return screens[0].id;
		}

		const windows =
			getDeskreenGlobal().desktopCapturerSourcesService.getAppWindowSources();
		if (windows.length > 0) {
			return windows[0].id;
		}

		return null;
	});

	ipcMain.handle(IpcEvents.AutoConnectTrustedReceiver, async () => {
		const deskreenGlobal = getDeskreenGlobal();
		const pendingDevice = deskreenGlobal.connectedDevicesService.pendingConnectionDevice;
		console.error(
			'[auto-connect] start pendingDeviceId=',
			pendingDevice.id || '(none)',
		);
		if (!pendingDevice.id) {
			return { ok: false, reason: 'no-pending-device' };
		}

		const sharingSessions = [
			...deskreenGlobal.sharingSessionService.sharingSessions.values(),
		];
		const activeSession = sharingSessions.find(
			(session) => session.status === SharingSessionStatusEnum.SHARING,
		);
		if (activeSession) {
			const ready = await waitForPeerStreamReady(activeSession);
			if (ready) {
				activeSession.callPeer();
			}
			return { ok: ready, reason: ready ? 'already-sharing' : 'no-source' };
		}

		if (!deskreenGlobal.connectedDevicesService.isSlotAvailable()) {
			deskreenGlobal.connectedDevicesService.disconnectAllDevices();
		}

		if (getScreenCapturePermissionStatus() !== 'granted') {
			const canUseDisplayMedia = await probeScreenCaptureAccess();
			if (!canUseDisplayMedia) {
				console.error(
					'[auto-connect] blocked: screen recording permission not granted',
				);
				return { ok: false, reason: 'no-permission' };
			}
		}

		await deskreenGlobal.desktopCapturerSourcesService.refreshDesktopCapturerSources();
		const savedId = store.get(ElectronStoreKeys.LastDesktopCapturerSourceId);
		const sourcesMap =
			deskreenGlobal.desktopCapturerSourcesService.getSourcesMap();

		if (typeof savedId !== 'string' || savedId === '' || !sourcesMap.has(savedId)) {
			const screens =
				deskreenGlobal.desktopCapturerSourcesService.getScreenSources();
			if (screens.length === 0) {
				const canUseDisplayMedia = await probeScreenCaptureAccess();
				if (!canUseDisplayMedia) {
					return { ok: false, reason: 'no-source' };
				}
			}
		}

		const waitingSession =
			deskreenGlobal.sharingSessionService.waitingForConnectionSharingSession;
		if (!waitingSession) {
			return { ok: false, reason: 'no-waiting-session' };
		}

		let pickedSourceId = '';
		// When YouTube Karaoke mode is active, prefer the YouTube player window
		const karaokeActive =
			store.has(ElectronStoreKeys.YouTubeKaraokeActive) &&
			store.get(ElectronStoreKeys.YouTubeKaraokeActive) === 'true';
		if (
			typeof savedId === 'string' &&
			savedId !== '' &&
			sourcesMap.has(savedId) &&
			!karaokeActive  // don't use stale saved ID when karaoke mode is on
		) {
			pickedSourceId = savedId;
		} else {
			if (karaokeActive) {
				// Look for the YouTube window first
				const ytSource =
					deskreenGlobal.desktopCapturerSourcesService.getYouTubeWindowSource();
				if (ytSource) {
					pickedSourceId = ytSource.id;
					console.error('[auto-connect] using YouTube window source', pickedSourceId);
				} else {
					console.error(
						'[auto-connect] YouTube DJ active but output window not in capturer sources',
					);
					return { ok: false, reason: 'youtube-window-not-found' };
				}
			} else if (!pickedSourceId) {
				const screens =
					deskreenGlobal.desktopCapturerSourcesService.getScreenSources();
				if (screens.length > 0) {
					pickedSourceId = screens[0].id;
				} else {
					const windows =
						deskreenGlobal.desktopCapturerSourcesService.getAppWindowSources();
					if (windows.length > 0) {
						pickedSourceId = windows[0].id;
					}
				}
			}
			// Persist this pick for future connects
			if (pickedSourceId) {
				store.set(ElectronStoreKeys.LastDesktopCapturerSourceId, pickedSourceId);
			}
		}

		waitingSession.setDesktopCapturerSourceID(pickedSourceId);

		const ready = await waitForPeerStreamReady(waitingSession, 120000);
		if (!ready) {
			const screenCount =
				deskreenGlobal.desktopCapturerSourcesService.getScreenSources().length;
			console.error(
				`[auto-connect] stream not ready sourceId=${pickedSourceId || 'display-media'} screens=${screenCount} permission=${getScreenCapturePermissionStatus()}`,
			);
			return {
				ok: false,
				reason: pickedSourceId === '' ? 'no-source' : 'pick-required',
			};
		}

		waitingSession.setStatus(SharingSessionStatusEnum.CONNECTED);

		if (pickedSourceId !== '') {
			store.set(ElectronStoreKeys.LastDesktopCapturerSourceId, pickedSourceId);
		}

		startSharingOnWaitingForConnectionSharingSession();

		console.error(
			`[auto-connect] success sourceId=${pickedSourceId || 'display-media'}`,
		);

		return { ok: true, sourceId: pickedSourceId || 'display-media' };
	});

	ipcMain.handle(IpcEvents.GetIsFirstTimeAppStart, () => {
		if (store.has(ElectronStoreKeys.IsNotFirstTimeAppStart)) {
			return false;
		}
		return true;
	});

	ipcMain.handle(IpcEvents.SetAppStartedOnce, () => {
		if (store.has(ElectronStoreKeys.IsNotFirstTimeAppStart)) {
			store.delete(ElectronStoreKeys.IsNotFirstTimeAppStart);
		}
		store.set(ElectronStoreKeys.IsNotFirstTimeAppStart, 'true');
	});

	ipcMain.handle(IpcEvents.GetAppLanguage, () => {
		if (store.has(ElectronStoreKeys.AppLanguage)) {
			return store.get(ElectronStoreKeys.AppLanguage);
		}
		return 'en';
	});

	ipcMain.handle(IpcEvents.DestroySharingSessionById, (_, id) => {
		if (
			getDeskreenGlobal().sharingSessionService
				.waitingForConnectionSharingSession?.id === id
		) {
			getDeskreenGlobal().sharingSessionService.waitingForConnectionSharingSession =
				null;
		}
		const sharingSession =
			getDeskreenGlobal().sharingSessionService.sharingSessions.get(id);
		sharingSession?.setStatus(SharingSessionStatusEnum.DESTROYED);
		sharingSession?.destroy();
		getDeskreenGlobal().sharingSessionService.sharingSessions.delete(id);
	});

	ipcMain.handle(IpcEvents.OpenExternalLink, (_, url: string) => {
		if (typeof url !== 'string') {
			return;
		}
		shell.openExternal(url);
	});

	ipcMain.handle(IpcEvents.WriteTextToClipboard, (_, text) => {
		clipboard.writeText(text);
	});

	void createWaitingForConnectionSharingSession();
	initYouTubeKaraokeIpc(mainWindow);

	// Forward karaoke info from the host UI to all active peer connections
	ipcMain.on(IpcEvents.YOUTUBE_KARAOKE_SEND_INFO, (_, data: { title: string }) => {
		const sessions = getDeskreenGlobal().sharingSessionService.sharingSessions;
		for (const [, session] of sessions) {
			try {
				session.peerConnectionHelperRenderer?.webContents.send(
					'send-karaoke-info',
					data,
				);
			} catch (_) {}
		}
	});
};
