import { randomUUID } from 'crypto';
import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';
import { IpcEvents } from '../../common/IpcEvents.enum';
import { ElectronStoreKeys } from '../../common/ElectronStoreKeys.enum';
import type {
	YouTubeDjQueueSnapshot,
	YouTubeDjRemoteCommandPayload,
	YouTubeDjRemoteCommandType,
} from '../../common/YouTubeKaraokeTypes';
import { store } from '../../common/deskreen-electron-store';
import { deskreenApp } from '../index';
import { forwardQueueSnapshotToWindow } from './youtubeQueueWindow';

const COMMAND_TIMEOUT_MS = 8000;

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

let mainWindowRef: BrowserWindow | null = null;
let mainRendererWebContentsId: number | null = null;
const pendingRequests = new Map<string, PendingRequest>();

function resolveMainWindow(): BrowserWindow | null {
	const appWindow = deskreenApp.mainWindow;
	if (appWindow && !appWindow.isDestroyed()) {
		mainWindowRef = appWindow;
		mainRendererWebContentsId = appWindow.webContents.id;
		return appWindow;
	}
	if (
		mainWindowRef &&
		!mainWindowRef.isDestroyed() &&
		mainRendererWebContentsId !== null &&
		mainWindowRef.webContents.id === mainRendererWebContentsId
	) {
		return mainWindowRef;
	}
	return null;
}

async function waitForMainWindow(maxMs = 15000): Promise<BrowserWindow> {
	const started = Date.now();
	while (Date.now() - started < maxMs) {
		const win = resolveMainWindow();
		if (win) {
			return win;
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error('Deskreen main window is not available');
}

export function initYoutubeDjApiBridge(mainWindow: BrowserWindow): void {
	mainWindowRef = mainWindow;
	mainRendererWebContentsId = mainWindow.webContents.id;

	ipcMain.on(
		IpcEvents.YOUTUBE_DJ_REMOTE_RESPONSE,
		(
			_,
			payload: {
				requestId?: string;
				result?: unknown;
				error?: string;
			},
		) => {
			const requestId = payload?.requestId;
			if (!requestId) {
				return;
			}
			const pending = pendingRequests.get(requestId);
			if (!pending) {
				return;
			}
			clearTimeout(pending.timer);
			pendingRequests.delete(requestId);
			if (payload.error) {
				pending.reject(new Error(payload.error));
				return;
			}
			pending.resolve(payload.result);
		},
	);

	ipcMain.on(IpcEvents.YOUTUBE_DJ_QUEUE_SNAPSHOT, (_, snapshot: YouTubeDjQueueSnapshot) => {
		if (!snapshot || !Array.isArray(snapshot.queue)) {
			return;
		}
		try {
			store.set(ElectronStoreKeys.YouTubeDjQueueSnapshot, JSON.stringify(snapshot));
		} catch {
			// ignore store errors
		}
		forwardQueueSnapshotToWindow(snapshot);
	});
}

export function clearPendingDjApiRequests(): void {
	for (const pending of pendingRequests.values()) {
		clearTimeout(pending.timer);
		pending.reject(new Error('Deskreen is shutting down'));
	}
	pendingRequests.clear();
}

export function readQueueSnapshotFromStore(): YouTubeDjQueueSnapshot | null {
	const raw = store.get(ElectronStoreKeys.YouTubeDjQueueSnapshot);
	if (typeof raw !== 'string' || !raw.trim()) {
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as YouTubeDjQueueSnapshot;
		if (!Array.isArray(parsed.queue)) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

export async function invokeRendererCommand(
	type: YouTubeDjRemoteCommandType,
	args: Omit<YouTubeDjRemoteCommandPayload, 'requestId' | 'type'> = {},
): Promise<unknown> {
	const mainWindow = await waitForMainWindow();

	const requestId = randomUUID();
	const payload: YouTubeDjRemoteCommandPayload = {
		requestId,
		type,
		...args,
	};

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingRequests.delete(requestId);
			reject(new Error(`renderer command timed out: ${type}`));
		}, COMMAND_TIMEOUT_MS);

		pendingRequests.set(requestId, {
			resolve,
			reject,
			timer,
		});
		mainWindow.webContents.send(IpcEvents.YOUTUBE_DJ_REMOTE_COMMAND, payload);
	});
}

export async function getRendererQueueState(): Promise<YouTubeDjQueueSnapshot> {
	try {
		const result = (await invokeRendererCommand('getState')) as YouTubeDjQueueSnapshot;
		if (result && Array.isArray(result.queue)) {
			return result;
		}
	} catch {
		// fall through to store snapshot
	}

	return (
		readQueueSnapshotFromStore() ?? {
			queue: [],
			currentIndex: -1,
			mode: 'queue',
			currentTitle: '',
			currentTime: 0,
			duration: 0,
		}
	);
}
