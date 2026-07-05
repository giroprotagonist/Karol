import { IpcEvents } from '@common/IpcEvents.enum';

export type StartDjSessionResult = {
	ok: boolean;
	sourceId?: string | null;
	connectedDevices?: number;
};

export async function startDjSession(): Promise<StartDjSessionResult> {
	const openResult = await window.electron.ipcRenderer.invoke(
		IpcEvents.YOUTUBE_DJ_START_SESSION,
	);
	return openResult as StartDjSessionResult;
}

export async function switchCaptureToYouTubeWindow(): Promise<{ ok: boolean; sourceId?: string | null }> {
	return window.electron.ipcRenderer.invoke(
		IpcEvents.YOUTUBE_DJ_SWITCH_SOURCE,
	) as Promise<{ ok: boolean; sourceId?: string | null }>;
}

export async function loadVideoInOutputPlayer(videoId: string): Promise<void> {
	await window.electron.ipcRenderer.invoke(IpcEvents.YOUTUBE_KARAOKE_LOAD_VIDEO, videoId);
}

export async function transportPlay(): Promise<void> {
	await window.electron.ipcRenderer.invoke(IpcEvents.YOUTUBE_DJ_PLAY);
}

export async function transportPause(): Promise<void> {
	await window.electron.ipcRenderer.invoke(IpcEvents.YOUTUBE_DJ_PAUSE);
}

export async function transportSeek(seconds: number): Promise<void> {
	await window.electron.ipcRenderer.invoke(IpcEvents.YOUTUBE_DJ_SEEK, seconds);
}

export async function transportSeekRelative(deltaSeconds: number): Promise<void> {
	await window.electron.ipcRenderer.invoke(
		IpcEvents.YOUTUBE_DJ_SEEK_RELATIVE,
		deltaSeconds,
	);
}

export async function transportSetVolume(level: number): Promise<void> {
	await window.electron.ipcRenderer.invoke(IpcEvents.YOUTUBE_DJ_SET_VOLUME, level);
}

export async function openYouTubeSignIn(): Promise<void> {
	await window.electron.ipcRenderer.invoke(IpcEvents.YOUTUBE_DJ_SIGN_IN);
}

export async function focusOutputPlayer(): Promise<void> {
	await window.electron.ipcRenderer.invoke(IpcEvents.YOUTUBE_DJ_FOCUS_PLAYER);
}

export function formatTime(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) {
		return '0:00';
	}
	const mins = Math.floor(seconds / 60);
	const secs = Math.floor(seconds % 60);
	return `${mins}:${secs.toString().padStart(2, '0')}`;
}
