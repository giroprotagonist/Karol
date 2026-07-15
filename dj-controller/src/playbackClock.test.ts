import { describe, expect, it } from 'vitest';
import { syncPlaybackAnchor, estimatedAnchorTime } from '../src/playbackClock';

describe('syncPlaybackAnchor', () => {
	const baseAnchor = {
		time: 10,
		at: Date.now() - 1000,
		playing: true,
		videoId: 'vid1',
		duration: 200,
	};

	it('resets clock on track change', () => {
		const result = syncPlaybackAnchor({
			anchor: baseAnchor,
			lastVideoId: 'vid1',
			videoId: 'vid2',
			time: 5,
			duration: 100,
			playing: true,
		});
		expect(result.lastVideoId).toBe('vid2');
		expect(result.displayTime).toBe(0);
		expect(result.keptLocalClock).toBe(false);
	});

	it('keeps local clock when server reports 0 while playing', () => {
		const result = syncPlaybackAnchor({
			anchor: baseAnchor,
			lastVideoId: 'vid1',
			videoId: 'vid1',
			time: 0,
			duration: 200,
			playing: true,
		});
		expect(result.keptLocalClock).toBe(true);
		expect(result.displayTime).toBeNull();
	});

	it('accepts server time when ahead of estimate', () => {
		const result = syncPlaybackAnchor({
			anchor: { ...baseAnchor, time: 5, at: Date.now() - 5000 },
			lastVideoId: 'vid1',
			videoId: 'vid1',
			time: 30,
			duration: 200,
			playing: true,
		});
		expect(result.keptLocalClock).toBe(false);
		expect(result.displayTime).toBe(30);
	});
});

describe('estimatedAnchorTime', () => {
	it('returns frozen time when paused', () => {
		const anchor = {
			time: 42,
			at: Date.now() - 10_000,
			playing: false,
			videoId: 'v',
			duration: 100,
		};
		expect(estimatedAnchorTime(anchor)).toBe(42);
	});

	it('extrapolates elapsed time while playing', () => {
		const anchor = {
			time: 10,
			at: Date.now() - 2000,
			playing: true,
			videoId: 'v',
			duration: 100,
		};
		const est = estimatedAnchorTime(anchor);
		expect(est).toBeGreaterThan(11);
		expect(est).toBeLessThan(13);
	});
});
