import { BrowserWindow } from 'electron';
import { IpcEvents } from '../../common/IpcEvents.enum';

const YOUTUBE_WINDOW_TITLE = 'Deskreen YouTube Player';

let youtubeWindow: BrowserWindow | null = null;

export function getYouTubeWindowTitle(): string {
	return YOUTUBE_WINDOW_TITLE;
}

export function isYouTubeWindowOpen(): boolean {
	return youtubeWindow !== null && !youtubeWindow.isDestroyed();
}

export function openYouTubePlayerWindow(serverPort: number): BrowserWindow {
	if (youtubeWindow && !youtubeWindow.isDestroyed()) {
		youtubeWindow.show();
		return youtubeWindow;
	}

	youtubeWindow = new BrowserWindow({
		width: 1280,
		height: 720,
		title: YOUTUBE_WINDOW_TITLE,
		show: true,
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
		},
	});

	// Load from the Koa server for a proper origin (YouTube blocks data: URLs)
	youtubeWindow.loadURL(`http://localhost:${serverPort}/youtube-player`);

	// Capture console messages to track YouTube player state changes
	youtubeWindow.webContents.on('console-message', (event) => {
		const msg = event.message;
		if (msg.startsWith('[YT_STATE]')) {
			try {
				const data = JSON.parse(msg.slice(10));
				const windows = BrowserWindow.getAllWindows();
				for (const win of windows) {
					if (
						win.title !== YOUTUBE_WINDOW_TITLE &&
						!win.isDestroyed()
					) {
						win.webContents.send(
							IpcEvents.YOUTUBE_KARAOKE_STATE_CHANGE,
							data,
						);
					}
				}
			} catch (_) {
				// ignore parse errors
			}
		}
	});

	youtubeWindow.on('closed', () => {
		youtubeWindow = null;
	});

	return youtubeWindow;
}

export function closeYouTubePlayerWindow(): void {
	if (youtubeWindow && !youtubeWindow.isDestroyed()) {
		youtubeWindow.close();
	}
	youtubeWindow = null;
}

/**
 * Returns the desktopCapturer source ID for the YouTube player window.
 * Use this instead of DesktopCapturerSourcesService when a capture is
 * already active (the service skips refreshes during active capture).
 */
export function getYouTubeWindowSourceId(): string | null {
	if (!youtubeWindow || youtubeWindow.isDestroyed()) return null;
	try {
		const nativeHandle = youtubeWindow.getNativeWindowHandle();
		if (!nativeHandle || nativeHandle.length === 0) return null;
		// On macOS, the native handle is a pointer-sized integer stored as a Buffer
		let windowId: number;
		if (nativeHandle.length >= 4) {
			windowId = nativeHandle.readUInt32LE(0);
		} else {
			return null;
		}
		return `window:${windowId}:0`;
	} catch {
		return null;
	}
}

export function loadYouTubeVideo(videoId: string, serverPort: number): void {
	if (!youtubeWindow || youtubeWindow.isDestroyed()) {
		openYouTubePlayerWindow(serverPort);
	}
	youtubeWindow?.webContents.executeJavaScript(
		`window.postMessage({ type: 'loadVideo', videoId: '${videoId.replace(/'/g, "\\'")}' }, '*');`,
	);
}

export function pauseYouTubeVideo(): void {
	youtubeWindow?.webContents.executeJavaScript(
		`window.postMessage({ type: 'pauseVideo' }, '*');`,
	);
}

export function playYouTubeVideo(): void {
	youtubeWindow?.webContents.executeJavaScript(
		`window.postMessage({ type: 'playVideo' }, '*');`,
	);
}

export function seekYouTubeVideo(seconds: number): void {
	youtubeWindow?.webContents.executeJavaScript(
		`window.postMessage({ type: 'seekTo', seconds: ${seconds} }, '*');`,
	);
}

export function getYouTubePlayerInfo(): Promise<{
	currentTime: number;
	duration: number;
	state: number;
} | null> {
	return new Promise((resolve) => {
		if (!youtubeWindow || youtubeWindow.isDestroyed()) {
			resolve(null);
			return;
		}
		const handler = (_event: Electron.Event, message: string) => {
			if (message.startsWith('[YT_INFO]')) {
				try {
					const data = JSON.parse(message.slice(10));
					youtubeWindow?.webContents.removeListener(
						'console-message',
						handler,
					);
					resolve(data);
				} catch (_) {
					resolve(null);
				}
			}
		};
		let resolved = false;
		const timeout = setTimeout(() => {
			if (!resolved) {
				youtubeWindow?.webContents.removeListener(
					'console-message',
					handler,
				);
				resolve(null);
			}
		}, 2000);
		const origResolve = (val: unknown) => {
			resolved = true;
			clearTimeout(timeout);
			resolve(val as { currentTime: number; duration: number; state: number } | null);
		};
		youtubeWindow.webContents.on('console-message', handler);
		youtubeWindow.webContents.executeJavaScript(
			`window.postMessage({ type: 'getInfo' }, '*');`,
		);
	});
}
