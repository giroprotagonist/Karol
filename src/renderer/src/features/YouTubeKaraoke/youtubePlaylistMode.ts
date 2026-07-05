import { IpcEvents } from '@common/IpcEvents.enum';
import type {
	YouTubeDjPlaylistModeConfig,
	YouTubeDjPlaylistSyncResult,
	YouTubeDjSetPlaylistModeInput,
} from '@common/YouTubeKaraokeTypes';

export async function getPlaylistModeConfig(): Promise<YouTubeDjPlaylistModeConfig> {
	return window.electron.ipcRenderer.invoke(
		IpcEvents.YOUTUBE_DJ_GET_PLAYLIST_MODE,
	) as Promise<YouTubeDjPlaylistModeConfig>;
}

export async function setPlaylistMode(
	input: YouTubeDjSetPlaylistModeInput,
): Promise<YouTubeDjPlaylistModeConfig> {
	const result = (await window.electron.ipcRenderer.invoke(
		IpcEvents.YOUTUBE_DJ_SET_PLAYLIST_MODE,
		input,
	)) as { ok?: boolean; config?: YouTubeDjPlaylistModeConfig; error?: string };
	if (result.error) {
		throw new Error(result.error);
	}
	return result.config ?? (await getPlaylistModeConfig());
}

export async function syncPlaylistNow(): Promise<YouTubeDjPlaylistSyncResult> {
	return window.electron.ipcRenderer.invoke(
		IpcEvents.YOUTUBE_DJ_SYNC_PLAYLIST_NOW,
	) as Promise<YouTubeDjPlaylistSyncResult>;
}

export async function setYouTubeApiKey(apiKey: string, persist: boolean): Promise<void> {
	await window.electron.ipcRenderer.invoke(IpcEvents.YOUTUBE_DJ_SET_API_KEY, {
		apiKey,
		persist,
	});
}

export async function getYouTubeApiKey(): Promise<string> {
	const result = (await window.electron.ipcRenderer.invoke(
		IpcEvents.YOUTUBE_DJ_GET_API_KEY,
	)) as { apiKey?: string };
	return result?.apiKey ?? '';
}

export function subscribeToPlaylistSyncResult(
	handler: (result: YouTubeDjPlaylistSyncResult) => void,
): () => void {
	const listener = (_event: unknown, result: YouTubeDjPlaylistSyncResult) => {
		handler(result);
	};
	window.electron.ipcRenderer.on(IpcEvents.YOUTUBE_DJ_PLAYLIST_SYNC_RESULT, listener);
	return () => {
		window.electron.ipcRenderer.removeListener(
			IpcEvents.YOUTUBE_DJ_PLAYLIST_SYNC_RESULT,
			listener,
		);
	};
}

export function formatPlaylistSyncTime(timestamp: number | null): string {
	if (!timestamp) {
		return 'Never';
	}
	return new Date(timestamp).toLocaleTimeString();
}
