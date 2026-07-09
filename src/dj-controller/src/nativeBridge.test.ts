import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	isNativeAndroidController,
	publishNowPlayingToNative,
	registerNativeNowPlayingListener,
	registerNativeVolumeListener,
} from './nativeBridge';

type DeskreenWindow = typeof globalThis & {
	DeskreenNative?: {
		onConnectionState: (healthy: boolean) => void;
		hapticLight: () => void;
		publishNowPlaying: (json: string) => void;
		setRemoteVolume: (level: number) => void;
		ctrlDbg: (hypothesisId: string, message: string, dataJson: string) => void;
	};
	__deskreenNativeVolume?: (level: number) => void;
	__deskreenNativeNowPlaying?: (nowPlaying: {
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
		delete deskreenWindow().DeskreenNative;
		delete deskreenWindow().__deskreenNativeVolume;
		delete deskreenWindow().__deskreenNativeNowPlaying;
	});

	afterEach(() => {
		delete deskreenWindow().DeskreenNative;
		delete deskreenWindow().__deskreenNativeVolume;
		delete deskreenWindow().__deskreenNativeNowPlaying;
	});

	it('detects native Android controller', () => {
		expect(isNativeAndroidController()).toBe(false);
		deskreenWindow().DeskreenNative = {
			onConnectionState: vi.fn(),
			hapticLight: vi.fn(),
			publishNowPlaying: vi.fn(),
			setRemoteVolume: vi.fn(),
			ctrlDbg: vi.fn(),
		};
		expect(isNativeAndroidController()).toBe(true);
	});

	it('publishNowPlayingToNative forwards JSON to DeskreenNative', () => {
		const publish = vi.fn();
		deskreenWindow().DeskreenNative = {
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
		deskreenWindow().__deskreenNativeVolume?.(1.5);
		expect(listener).toHaveBeenCalledWith(1);
		deskreenWindow().__deskreenNativeVolume?.(-0.2);
		expect(listener).toHaveBeenLastCalledWith(0);
		cleanup();
		expect(deskreenWindow().__deskreenNativeVolume).toBeUndefined();
	});

	it('registerNativeNowPlayingListener receives notification pushes', () => {
		const listener = vi.fn();
		const cleanup = registerNativeNowPlayingListener(listener);
		deskreenWindow().__deskreenNativeNowPlaying?.({
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
