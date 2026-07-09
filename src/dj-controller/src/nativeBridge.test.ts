import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	isNativeAndroidController,
	publishNowPlayingToNative,
	registerNativeNowPlayingListener,
	registerNativeVolumeListener,
} from './nativeBridge';

type DeskreenWindow = typeof globalThis & {
	KarolNative?: {
		onConnectionState: (healthy: boolean) => void;
		hapticLight: () => void;
		publishNowPlaying: (json: string) => void;
		setRemoteVolume: (level: number) => void;
		ctrlDbg: (hypothesisId: string, message: string, dataJson: string) => void;
	};
	__karolNativeVolume?: (level: number) => void;
	__karolNativeNowPlaying?: (nowPlaying: {
		title: string;
		videoId: string;
		currentTime: number;
		duration: number;
		state: number;
	}) => void;
};

function deskreenWindow(): DeskreenWindow {
	return globalThis as DeskreenWindow;
}

describe('nativeBridge', () => {
	beforeEach(() => {
		delete deskreenWindow().KarolNative;
		delete deskreenWindow().__karolNativeVolume;
		delete deskreenWindow().__karolNativeNowPlaying;
	});

	afterEach(() => {
		delete deskreenWindow().KarolNative;
		delete deskreenWindow().__karolNativeVolume;
		delete deskreenWindow().__karolNativeNowPlaying;
	});

	it('detects native Android controller', () => {
		expect(isNativeAndroidController()).toBe(false);
		deskreenWindow().KarolNative = {
			onConnectionState: vi.fn(),
			hapticLight: vi.fn(),
			publishNowPlaying: vi.fn(),
			setRemoteVolume: vi.fn(),
			ctrlDbg: vi.fn(),
		};
		expect(isNativeAndroidController()).toBe(true);
	});

	it('publishNowPlayingToNative forwards JSON to KarolNative', () => {
		const publish = vi.fn();
		deskreenWindow().KarolNative = {
			onConnectionState: vi.fn(),
			hapticLight: vi.fn(),
			publishNowPlaying: publish,
			setRemoteVolume: vi.fn(),
			ctrlDbg: vi.fn(),
		};
		publishNowPlayingToNative({
			title: 'A',
			videoId: 'aaaaaaaaaaa',
			currentTime: 3,
			duration: 90,
			state: 1,
		});
		expect(publish).toHaveBeenCalledOnce();
		const payload = JSON.parse(publish.mock.calls[0][0] as string);
		expect(payload.videoId).toBe('aaaaaaaaaaa');
	});

	it('registerNativeVolumeListener clamps and forwards levels', () => {
		const listener = vi.fn();
		const cleanup = registerNativeVolumeListener(listener);
		deskreenWindow().__karolNativeVolume?.(1.5);
		expect(listener).toHaveBeenCalledWith(1);
		deskreenWindow().__karolNativeVolume?.(-0.2);
		expect(listener).toHaveBeenLastCalledWith(0);
		cleanup();
		expect(deskreenWindow().__karolNativeVolume).toBeUndefined();
	});

	it('registerNativeNowPlayingListener receives notification pushes', () => {
		const listener = vi.fn();
		const cleanup = registerNativeNowPlayingListener(listener);
		deskreenWindow().__karolNativeNowPlaying?.({
			title: 'B',
			videoId: 'bbbbbbbbbbb',
			currentTime: 1,
			duration: 60,
			state: 2,
		});
		expect(listener).toHaveBeenCalledWith(
			expect.objectContaining({ videoId: 'bbbbbbbbbbb', state: 2 }),
		);
		cleanup();
	});
});
