import type { YouTubeDjNowPlaying } from '@common/YouTubeKaraokeTypes';

declare global {
	interface Window {
		DeskreenNative?: {
			onConnectionState: (healthy: boolean) => void;
			hapticLight: () => void;
			publishNowPlaying: (json: string) => void;
			setRemoteVolume: (level: number) => void;
			ctrlDbg: (hypothesisId: string, message: string, dataJson: string) => void;
		};
		__deskreenNativeVolume?: (level: number) => void;
		__deskreenNativeNowPlaying?: (nowPlaying: YouTubeDjNowPlaying) => void;
	}
}

export function isNativeAndroidController(): boolean {
	return Boolean(window.DeskreenNative);
}

export function notifyNativeConnection(healthy: boolean): void {
	window.DeskreenNative?.onConnectionState(healthy);
}

export function hapticLight(): void {
	window.DeskreenNative?.hapticLight?.();
}

/** Called from Android when hardware volume keys change tablet loudness. */
export function registerNativeVolumeListener(
	listener: (level: number) => void,
): () => void {
	window.__deskreenNativeVolume = (level: number) => {
		if (typeof level === 'number' && Number.isFinite(level)) {
			listener(Math.max(0, Math.min(1, level)));
		}
	};
	return () => {
		if (window.__deskreenNativeVolume) {
			delete window.__deskreenNativeVolume;
		}
	};
}

/** Push WebView now-playing to the Android notification service. */
export function publishNowPlayingToNative(nowPlaying: YouTubeDjNowPlaying): void {
	try {
		window.DeskreenNative?.publishNowPlaying?.(JSON.stringify(nowPlaying));
	} catch {
		/* ignore */
	}
}

/** Apply now-playing pushed from the notification service. */
export function registerNativeNowPlayingListener(
	listener: (nowPlaying: YouTubeDjNowPlaying) => void,
): () => void {
	window.__deskreenNativeNowPlaying = (nowPlaying: YouTubeDjNowPlaying) => {
		if (nowPlaying && typeof nowPlaying === 'object') {
			listener(nowPlaying);
		}
	};
	return () => {
		if (window.__deskreenNativeNowPlaying) {
			delete window.__deskreenNativeNowPlaying;
		}
	};
}
