import { join } from 'path';
import { existsSync } from 'node:fs';
import { BrowserWindow } from 'electron';
import { is } from '@electron-toolkit/utils';
import { IpcEvents } from '../../common/IpcEvents.enum';
import type { YouTubeDjQueueSnapshot } from '../../common/YouTubeKaraokeTypes';
import { store } from '../../common/deskreen-electron-store';
import { ElectronStoreKeys } from '../../common/ElectronStoreKeys.enum';
import { deskreenApp } from '../index';

const QUEUE_WINDOW_TITLE = 'Deskreen DJ Queue';
const QUEUE_WINDOW_WIDTH = 380;
const QUEUE_WINDOW_HEIGHT = 520;

let queueWindow: BrowserWindow | null = null;

function readCachedQueueSnapshot(): YouTubeDjQueueSnapshot | null {
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

function resolvePreloadScriptPath(): string {
	const baseDir = join(__dirname, '../preload');
	const candidates = ['index.js', 'index.mjs', 'index.cjs'];
	for (const fileName of candidates) {
		const fullPath = join(baseDir, fileName);
		if (existsSync(fullPath)) {
			return fullPath;
		}
	}
	return join(baseDir, 'index.js');
}

function pickQueueWindowPosition(): { x: number; y: number } {
	const mainWindow = deskreenApp.mainWindow;
	if (mainWindow && !mainWindow.isDestroyed()) {
		const bounds = mainWindow.getBounds();
		return {
			x: bounds.x + bounds.width + 12,
			y: bounds.y + 48,
		};
	}
	return { x: 80, y: 80 };
}

function loadQueueWindowUrl(win: BrowserWindow): void {
	if (is.dev && process.env.ELECTRON_RENDERER_URL) {
		void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/queueWindowIndex.html`);
		return;
	}
	void win.loadFile(join(__dirname, '../renderer/queueWindowIndex.html'));
}

function pushSnapshotToWindow(snapshot: YouTubeDjQueueSnapshot): void {
	if (!queueWindow || queueWindow.isDestroyed()) {
		return;
	}
	queueWindow.webContents.send(IpcEvents.YOUTUBE_DJ_QUEUE_SNAPSHOT_PUSH, snapshot);
}

export function forwardQueueSnapshotToWindow(snapshot: YouTubeDjQueueSnapshot): void {
	pushSnapshotToWindow(snapshot);
}

export function openYouTubeQueueWindow(): BrowserWindow {
	if (queueWindow && !queueWindow.isDestroyed()) {
		queueWindow.show();
		queueWindow.focus();
		const cached = readCachedQueueSnapshot();
		if (cached) {
			pushSnapshotToWindow(cached);
		}
		return queueWindow;
	}

	const { x, y } = pickQueueWindowPosition();

	queueWindow = new BrowserWindow({
		x,
		y,
		width: QUEUE_WINDOW_WIDTH,
		height: QUEUE_WINDOW_HEIGHT,
		minWidth: 320,
		minHeight: 360,
		title: QUEUE_WINDOW_TITLE,
		autoHideMenuBar: true,
		show: false,
		backgroundColor: '#f5f8fa',
		webPreferences: {
			preload: resolvePreloadScriptPath(),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	});

	queueWindow.on('ready-to-show', () => {
		queueWindow?.show();
	});

	queueWindow.on('closed', () => {
		queueWindow = null;
	});

	loadQueueWindowUrl(queueWindow);

	queueWindow.webContents.on('did-finish-load', () => {
		const cached = readCachedQueueSnapshot();
		if (cached) {
			pushSnapshotToWindow(cached);
		}
	});

	return queueWindow;
}

export function closeYouTubeQueueWindow(): void {
	if (queueWindow && !queueWindow.isDestroyed()) {
		queueWindow.close();
	}
	queueWindow = null;
}

export function isYouTubeQueueWindowOpen(): boolean {
	return queueWindow !== null && !queueWindow.isDestroyed();
}
