import type { YouTubeDjNowPlaying } from '@common/YouTubeKaraokeTypes';

declare global {
	interface Window {
		KarolNative?: {
			onConnectionState: (healthy: boolean) => void;
			hapticLight: () => void;
			publishNowPlaying: (json: string) => void;
			setRemoteVolume: (level: number) => void;
			ctrlDbg: (hypothesisId: string, message: string, dataJson: string) => void;
		};
		__karolNativeVolume?: (level: number) => void;
		__karolNativeNowPlaying?: (nowPlaying: YouTubeDjNowPlaying) => void;
	}
}

export function isNativeAndroidController(): boolean {
	return Boolean(window.KarolNative);
}

export function notifyNativeConnection(healthy: boolean): void {
	window.KarolNative?.onConnectionState(healthy);
}

export function hapticLight(): void {
	window.KarolNative?.hapticLight?.();
}

/** Called from Android when hardware volume keys change tablet loudness. */
export function registerNativeVolumeListener(
	listener: (level: number) => void,
): () => void {
	window.__karolNativeVolume = (level: number) => {
		if (typeof level === 'number' && Number.isFinite(level)) {
			listener(Math.max(0, Math.min(1, level)));
		}
	};
	return () => {
		if (window.__karolNativeVolume) {
			delete window.__karolNativeVolume;
		}
	};
}

/** Push WebView now-playing to the Android notification service. */
export function publishNowPlayingToNative(nowPlaying: YouTubeDjNowPlaying): void {
	try {
		window.KarolNative?.publishNowPlaying?.(JSON.stringify(nowPlaying));
	} catch {
		/* ignore */
	}
}

/** Apply now-playing pushed from the notification service. */
export function registerNativeNowPlayingListener(
	listener: (nowPlaying: YouTubeDjNowPlaying) => void,
): () => void {
	window.__karolNativeNowPlaying = (nowPlaying: YouTubeDjNowPlaying) => {
		if (nowPlaying && typeof nowPlaying === 'object') {
			listener(nowPlaying);
		}
	};
	return () => {
		if (window.__karolNativeNowPlaying) {
			delete window.__karolNativeNowPlaying;
		}
	};
}
