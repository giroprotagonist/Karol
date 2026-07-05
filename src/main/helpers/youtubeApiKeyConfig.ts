import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { ElectronStoreKeys } from '../../common/ElectronStoreKeys.enum';
import { store } from '../../common/deskreen-electron-store';

let inMemoryApiKey = '';

function readKeyFromFile(filePath: string): string {
	try {
		if (!fs.existsSync(filePath)) {
			return '';
		}
		const raw = fs.readFileSync(filePath, 'utf8').trim();
		if (!raw || raw.startsWith('#') || raw.includes('YOUR_YOUTUBE')) {
			return '';
		}
		if (raw.startsWith('{')) {
			const parsed = JSON.parse(raw) as { apiKey?: string };
			return typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
		}
		const firstLine = raw.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
		return firstLine.startsWith('#') ? '' : firstLine;
	} catch {
		return '';
	}
}

function getLocalKeyFileCandidates(): string[] {
	const candidates = [
		path.join(app.getPath('userData'), 'youtube-api-key.local'),
		path.join(process.cwd(), 'config/youtube-api-key.local'),
	];

	if (app.isPackaged) {
		candidates.push(path.join(process.resourcesPath, 'youtube-api-key.local'));
	} else {
		candidates.push(
			path.join(app.getAppPath(), '..', '..', 'config/youtube-api-key.local'),
		);
	}

	return candidates;
}

export function getPersistedYouTubeApiKey(): string {
	const key = store.get(ElectronStoreKeys.YouTubeDjApiKey);
	return typeof key === 'string' ? key.trim() : '';
}

export function setPersistedYouTubeApiKey(apiKey: string): void {
	const trimmed = apiKey.trim();
	if (trimmed) {
		store.set(ElectronStoreKeys.YouTubeDjApiKey, trimmed);
	} else {
		store.delete(ElectronStoreKeys.YouTubeDjApiKey as string);
	}
}

export function setInMemoryYouTubeApiKey(apiKey: string): void {
	inMemoryApiKey = apiKey.trim();
}

export function getInMemoryYouTubeApiKey(): string {
	return inMemoryApiKey || getPersistedYouTubeApiKey();
}

/** Load API key from store, then private local files. Never committed to git. */
export function bootstrapYouTubeApiKey(): string {
	const fromStore = getPersistedYouTubeApiKey();
	if (fromStore) {
		setInMemoryYouTubeApiKey(fromStore);
		return fromStore;
	}

	for (const candidate of getLocalKeyFileCandidates()) {
		const fromFile = readKeyFromFile(candidate);
		if (fromFile) {
			setInMemoryYouTubeApiKey(fromFile);
			setPersistedYouTubeApiKey(fromFile);
			return fromFile;
		}
	}

	return '';
}

export function hasYouTubeApiKey(): boolean {
	return getInMemoryYouTubeApiKey().length > 0;
}
