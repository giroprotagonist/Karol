// override console early to catch all logs
import {
	overrideGlobalConsole,
	startConsoleRateLimiting,
} from '../common/rateLimitedConsole';
overrideGlobalConsole();
startConsoleRateLimiting();

import { app, shell, BrowserWindow, Notification, dialog, desktopCapturer } from 'electron';
import { join } from 'path';
import { is, optimizer } from '@electron-toolkit/utils';
import icon from '../../resources/icon.png?asset';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';

// function createWindow(): void {
//   // Create the browser window.
//   const mainWindow = new BrowserWindow({
//     width: 900,
//     height: 670,
//     show: false,
//     autoHideMenuBar: true,
//     ...(process.platform === 'linux' ? { icon } : {}),
//     webPreferences: {
//       preload: join(__dirname, '../preload/index.js'),
//       sandbox: false,
//     },
//   });
//
//   mainWindow.on('ready-to-show', () => {
//     mainWindow.show();
//   });
//
//   mainWindow.webContents.setWindowOpenHandler((details) => {
//     shell.openExternal(details.url);
//     return { action: 'deny' };
//   });
//
//   // HMR for renderer base on electron-vite cli.
//   // Load the remote URL for development or the local html file for production.
//   if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
//     mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
//   } else {
//     mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
//   }
// }
//
// // This method will be called when Electron has finished
// // initialization and is ready to create browser windows.
// // Some APIs can only be used after this event occurs.
// app.whenReady().then(() => {
//   // Set app user model id for windows
//   electronApp.setAppUserModelId('com.deskreen');
//
//   // Default open or close DevTools by F12 in development
//   // and ignore CommandOrControl + R in production.
//   // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
//   app.on('browser-window-created', (_, window) => {
//     optimizer.watchWindowShortcuts(window);
//   });
//
//   // IPC test
//   ipcMain.on('ping', () => console.log('pong'));
//
//   createWindow();
//
//   app.on('activate', function () {
//     // On macOS it's common to re-create a window in the app when the
//     // dock icon is clicked and there are no other windows open.
//     if (BrowserWindow.getAllWindows().length === 0) createWindow();
//   });
// });
//
// // Quit when all windows are closed, except on macOS. There, it's common
// // for applications and their menu bar to stay active until the user quits
// // explicitly with Cmd + Q.
// app.on('window-all-closed', () => {
//   if (process.platform !== 'darwin') {
//     app.quit();
//   }
// });

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

// import path from 'path';
// import { app, BrowserWindow } from 'electron';
import { store } from '../common/deskreen-electron-store';
// import i18n from './i18next.config';
import i18n from './configs/i18next.config';
import { signalingServer } from '../server';
import MenuBuilder from './menu';
import installExtensions from './utils/installExtensions';
import getNewVersionTag from './utils/getNewVersionTag';
import { initIpcMainHandlers } from './helpers/ipcMainHandlers';
import { initGlobals } from './helpers/initGlobals';
import { ElectronStoreKeys } from '../common/ElectronStoreKeys.enum';
import { getDeskreenGlobal } from './helpers/getDeskreenGlobal';
import { startLogBufferCleanup } from './utils/LoggerWithFilePrefix';
import {
	isDeskreenShutdownComplete,
	requestDeskreenQuit,
	shutdownDeskreen,
} from './helpers/appShutdown';
import configureScreenCaptureSession, {
	probeScreenCaptureAccess,
	requestScreenCaptureAccessOnStartup,
} from './helpers/configureScreenCaptureSession';
import getScreenCapturePermissionStatus from './utils/getScreenCapturePermissionStatus';

const resolvePreloadScriptPath = (entry: 'index' | 'helperRenderer'): string => {
	const baseDir = join(__dirname, '../preload');
	const candidates = [`${entry}.js`, `${entry}.mjs`, `${entry}.cjs`];
	for (const fileName of candidates) {
		const fullPath = join(baseDir, fileName);
		if (existsSync(fullPath)) {
			return fullPath;
		}
	}
	return join(baseDir, `${entry}.js`);
};

export default class DeskreenApp {
	mainWindow: BrowserWindow | null = null;

	menuBuilder: MenuBuilder | null = null;

	latestAppVersion = '';

	private isQuitting = false;

	isAppQuitting(): boolean {
		return this.isQuitting;
	}

	requestQuit(): void {
		this.isQuitting = true;
		requestDeskreenQuit();
	}

	initElectronAppObject(): void {
		/**
		 * Add event listeners...
		 */
		app.on('window-all-closed', () => {
			// TODO: when app will be set to auto start on login, this will be not required,
			// TODO: the app will run until user didn't kill it in system tray
			// Respect the OSX convention of having the application in memory even
			// after all windows have been closed
			if (process.platform !== 'darwin') {
				app.quit();
			}
		});

		app.whenReady().then(async () => {
			app.setAppUserModelId('com.deskreen-ce.app');
			if (process.platform === 'darwin') {
				app.setActivationPolicy('regular');
			}

			configureScreenCaptureSession();
			await requestScreenCaptureAccessOnStartup();

			// start log buffer cleanup to prevent memory bloat
			startLogBufferCleanup();

			await this.createWindow();
			await this.ensureScreenCapturePermissionPrompt();

			void this.checkForLatestVersionAndNotify();
		});

		app.on('browser-window-created', (_, window) => {
			optimizer.watchWindowShortcuts(window);
		});

		app.on('before-quit', (event) => {
			if (isDeskreenShutdownComplete()) {
				return;
			}
			event.preventDefault();
			this.isQuitting = true;
			void shutdownDeskreen('before-quit').then(() => {
				app.quit();
			});
		});

		app.on('activate', (e) => {
			e.preventDefault();
			// On macOS it's common to re-create a window in the app when the
			// dock icon is clicked and there are no other windows open.
			if (this.mainWindow === null) {
				this.createWindow();
			} else if (!this.mainWindow.isDestroyed() && !this.mainWindow.isVisible()) {
				this.mainWindow.show();
				this.mainWindow.focus();
			}
		});

		app.commandLine.appendSwitch(
			'webrtc-max-cpu-consumption-percentage',
			'100',
		);
	}

	private async ensureScreenCapturePermissionPrompt(): Promise<void> {
		if (process.platform !== 'darwin' || !this.mainWindow) {
			return;
		}

		const hasAccess = await probeScreenCaptureAccess();
		if (hasAccess || getScreenCapturePermissionStatus() === 'granted') {
			return;
		}

		const { response } = await dialog.showMessageBox(this.mainWindow, {
			type: 'warning',
			title: i18n.t('screen-recording-permission-required'),
			message: i18n.t('screen-recording-permission-instructions'),
			detail: i18n.t('screen-recording-restart-instructions'),
			buttons: [
				i18n.t('open-screen-recording-settings'),
				i18n.t('continue'),
			],
			defaultId: 0,
			cancelId: 1,
		});

		if (response === 0) {
			await shell.openExternal(
				'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
			);
		}
	}

	private async checkForLatestVersionAndNotify(): Promise<void> {
		try {
			const latestAppVersion = await getNewVersionTag();
			const deskreenGlobal = getDeskreenGlobal();
			deskreenGlobal.latestAppVersion = latestAppVersion;
			this.latestAppVersion = latestAppVersion;

			if (
				latestAppVersion === '' ||
				latestAppVersion === deskreenGlobal.currentAppVersion ||
				!Notification.isSupported()
			) {
				return;
			}

			this.showUpdateNotification(latestAppVersion);
		} catch (error) {
			console.error('Failed to check for Deskreen updates', error);
		}
	}

	private showUpdateNotification(latestAppVersion: string): void {
		const deskreenGlobal = getDeskreenGlobal();
		const notification = new Notification({
			title: i18n.t('deskreen-ce-update-is-available'),
			body: `${i18n.t('your-current-version-is')} ${deskreenGlobal.currentAppVersion} | ${i18n.t(
				'click-to-download-new-updated-version',
			)} ${latestAppVersion}`,
		});

		notification.on('click', () => {
			void shell.openExternal('https://deskreen.com/download');
		});

		notification.show();
	}

	async createWindow(): Promise<void> {
		if (
			process.env.NODE_ENV === 'development' ||
			process.env.DEBUG_PROD === 'true'
		) {
			await installExtensions();
		}

		this.mainWindow = new BrowserWindow({
			show: false,
			width: 940,
			height: 640,
			minHeight: 460,
			minWidth: 640,
			titleBarStyle: 'hiddenInset',
			frame: process.platform === 'darwin' ? false : true,
			useContentSize: true,
			title: 'Deskreen CE',
			// useContentSize: true,
			autoHideMenuBar: true,
			...(process.platform === 'linux' ? { icon } : {}),
			webPreferences: {
				preload: resolvePreloadScriptPath('index'),
				sandbox: false,
			},
		});

		// this.mainWindow.loadURL(`file://${__dirname}/app.html`);

		// @TODO: Use 'ready-to-show' event
		//        https://github.com/electron/electron/blob/master/docs/api/browser-window.md#using-ready-to-show-event
		this.mainWindow.on('ready-to-show', () => {
			if (!this.mainWindow) {
				throw new Error('"mainWindow" is not defined');
			}
			// Don't show the window automatically — the server runs headless.
			// The user can click the dock icon or menu bar to bring up the UI.
		});

		this.mainWindow.webContents.setWindowOpenHandler((details) => {
			shell.openExternal(details.url);
			return { action: 'deny' };
		});

		// HMR for renderer base on electron-vite cli.
		// Load the remote URL for development or the local html file for production.
		if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
			this.mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
		} else {
			this.mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
		}

		this.mainWindow.on('closed', () => {
			this.mainWindow = null;
			// TODO: when app will be set to auto start on login, this will be not required,
			// TODO: the app will run until user didn't kill it in system tray
			if (process.platform !== 'darwin') {
				app.quit();
			}
		});

		this.mainWindow.on('close', (event) => {
			if (this.isQuitting) {
				return;
			}
			const djActive =
				store.has(ElectronStoreKeys.YouTubeKaraokeActive) &&
				store.get(ElectronStoreKeys.YouTubeKaraokeActive) === 'true';
			if (djActive && this.mainWindow && !this.mainWindow.isDestroyed()) {
				event.preventDefault();
				this.mainWindow.hide();
			}
		});

		if (process.env.NODE_ENV === 'dev') {
			this.mainWindow.webContents.toggleDevTools();
		}

		this.menuBuilder = new MenuBuilder(this.mainWindow, i18n);
		this.menuBuilder.buildMenu();

		this.initI18n();

		initIpcMainHandlers(this.mainWindow);
	}

	initI18n(): void {
		i18n.on('loaded', () => {
			i18n.changeLanguage('en');
			i18n.off('loaded');
		});

		i18n.on('languageChanged', (lng) => {
			if (this.mainWindow === null) return;
			this.menuBuilder = new MenuBuilder(this.mainWindow, i18n);
			this.menuBuilder.buildMenu();
			setTimeout(async () => {
				if (lng !== 'en' && i18n.language !== lng) {
					i18n.changeLanguage(lng);
					if (store.has(ElectronStoreKeys.AppLanguage)) {
						store.delete(ElectronStoreKeys.AppLanguage);
					}
					store.set(ElectronStoreKeys.AppLanguage, lng);
				}
			}, 400);
		});
	}

	start(): void {
		// ensure only one instance of the app can run
		const gotTheLock = app.requestSingleInstanceLock();

		if (!gotTheLock) {
			// another instance is already running, quit this one
			app.quit();
			return;
		}

		// handle second instance attempts (e.g., clicking taskbar icon on windows)
		app.on('second-instance', () => {
			// Don't steal focus — the server is running headless.
			// User can click the dock icon to show the window.
		});

		const cliLocalIp = this.parseCliLocalIp();
		initGlobals(join(__dirname, '..'), cliLocalIp);
		signalingServer.start();

		this.ensureVlcRunning();

		this.initElectronAppObject();
	}

	private parseCliLocalIp(): string | undefined {
		const args = process.argv;
		const localIpIndex = args.findIndex(
			(arg) => arg === '--local-ip' || arg === '--ip',
		);
		if (localIpIndex !== -1 && localIpIndex + 1 < args.length) {
			const ip = args[localIpIndex + 1];
			if (ip && !ip.startsWith('--')) {
				return ip;
			}
		}
		return undefined;
	}

	private ensureVlcRunning(): void {
		const VLC_PATH = '/Applications/VLC.app/Contents/MacOS/VLC';
		if (!existsSync(VLC_PATH)) return;

		// Quick health check – if VLC is already answering HTTP, skip launch
		const check = http.get(
			{
				hostname: '127.0.0.1',
				port: 8080,
				path: '/requests/status.json',
				auth: ':karol',
				timeout: 2000,
			},
			() => {
				check.destroy();
			},
		);
		check.on('error', () => {
			// VLC not running – launch it detached
			try {
				const proc = spawn(VLC_PATH, [
					'--extraintf', 'http',
					'--http-password', 'karol',
					'--http-host', '127.0.0.1',
					'--http-port', '8080',
				], { detached: true, stdio: 'ignore' });
				proc.unref();
			} catch { /* VLC may not be installed */ }
		});
	}
}

export const deskreenApp = new DeskreenApp();

if (process.argv.includes('--probe-screen-capture')) {
	configureScreenCaptureSession();
	void app.whenReady().then(async () => {
		process.stdout.write(
			`[deskreen-probe] screen-permission: ${getScreenCapturePermissionStatus()}\n`,
		);
		try {
			const sources = await desktopCapturer.getSources({
				types: ['screen', 'window'],
				thumbnailSize: { width: 100, height: 100 },
			});
			process.stdout.write(
				`[deskreen-probe] sources-count: ${sources.length}\n`,
			);
			for (const source of sources.slice(0, 8)) {
				process.stdout.write(`[deskreen-probe] source: ${source.name}\n`);
			}
		} catch (error) {
			process.stdout.write(`[deskreen-probe] getSources-error: ${error}\n`);
		}
		app.exit(0);
	});
	setTimeout(() => {
		process.stdout.write('[deskreen-probe] timed out waiting for app ready\n');
		app.exit(1);
	}, 15000);
} else {
	deskreenApp.start();
}
