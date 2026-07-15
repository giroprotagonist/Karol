import { describe, expect, it } from 'vitest';
import { formatTime, normalizePlaylistConfig } from './api';

describe('formatTime', () => {
	it('formats minutes and zero-padded seconds', () => {
		expect(formatTime(65)).toBe('1:05');
		expect(formatTime(0)).toBe('0:00');
		expect(formatTime(3599)).toBe('59:59');
	});

	it('handles invalid values', () => {
		expect(formatTime(-1)).toBe('0:00');
		expect(formatTime(Number.NaN)).toBe('0:00');
	});
});

describe('normalizePlaylistConfig', () => {
	it('passes through multi-playlist configs', () => {
		const config = {
			enabled: true,
			playlistId: '',
			playlistUrl: '',
			activePlaylistId: 'p1',
			playlists: [
				{
					playlistId: 'p1',
					playlistUrl: 'https://youtube.com/playlist?list=abc',
					name: 'Show',
					syncedVideoIds: ['a'],
					lastSyncAt: null,
					lastSyncError: null,
					videoCount: 1,
				},
			],
			syncedVideoIds: [],
			lastSyncAt: null,
			lastSyncError: null,
			lastAddedCount: 0,
		};
		expect(normalizePlaylistConfig(config).playlists).toHaveLength(1);
	});

	it('migrates legacy single-playlist fields', () => {
		const config = normalizePlaylistConfig({
			enabled: true,
			playlistId: 'legacy-id',
			playlistUrl: 'https://youtube.com/playlist?list=legacy',
			activePlaylistId: '',
			playlists: [],
			syncedVideoIds: ['v1', 'v2'],
			lastSyncAt: 1,
			lastSyncError: null,
			lastAddedCount: 0,
		});
		expect(config.playlists).toHaveLength(1);
		expect(config.playlists[0].playlistId).toBe('legacy-id');
		expect(config.activePlaylistId).toBe('legacy-id');
		expect(config.playlists[0].videoCount).toBe(2);
	});
});
