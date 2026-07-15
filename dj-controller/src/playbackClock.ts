export type PlaybackAnchor = {
	time: number;
	at: number;
	playing: boolean;
	videoId: string;
	duration: number;
};

export function estimatedAnchorTime(anchor: PlaybackAnchor): number {
	if (!anchor.playing) {
		return anchor.time;
	}
	return anchor.time + (Date.now() - anchor.at) / 1000;
}

export type SyncPlaybackAnchorResult = {
	anchor: PlaybackAnchor;
	lastVideoId: string;
	/** When null, caller should not overwrite displayTime (clock keeps extrapolating). */
	displayTime: number | null;
	keptLocalClock: boolean;
};

/**
 * Merge tablet now-playing samples into the local extrapolation clock.
 * The player API often reports currentTime=0 while audio is playing; blindly
 * resetting the anchor on every poll freezes the in-app scrubber.
 */
export function syncPlaybackAnchor(args: {
	anchor: PlaybackAnchor;
	lastVideoId: string;
	videoId: string;
	time: number;
	duration: number;
	playing: boolean;
}): SyncPlaybackAnchorResult {
	const { anchor: prev, videoId, time, duration, playing } = args;
	let lastVideoId = args.lastVideoId;

	if (videoId && videoId !== lastVideoId) {
		lastVideoId = videoId;
		return {
			anchor: {
				time: 0,
				at: Date.now(),
				playing: false,
				videoId,
				duration: duration || 0,
			},
			lastVideoId,
			displayTime: 0,
			keptLocalClock: false,
		};
	}

	const resolvedVideoId = videoId || lastVideoId || prev.videoId;

	if (!playing) {
		return {
			anchor: {
				time,
				at: Date.now(),
				playing: false,
				videoId: resolvedVideoId,
				duration,
			},
			lastVideoId,
			displayTime: time,
			keptLocalClock: false,
		};
	}

	const estimated = estimatedAnchorTime(prev);
	let nextTime = time;
	let nextAt = Date.now();
	let keptLocalClock = false;

	if (time <= 0 && estimated > 0.5) {
		nextTime = prev.time;
		nextAt = prev.at;
		keptLocalClock = true;
	} else if (time > estimated + 0.35) {
		nextTime = time;
		nextAt = Date.now();
	} else if (time < estimated - 2) {
		nextTime = time;
		nextAt = Date.now();
	} else if (estimated > time + 0.5) {
		nextTime = prev.time;
		nextAt = prev.at;
		keptLocalClock = true;
	} else if (time > 0) {
		nextTime = time;
		nextAt = Date.now();
	} else {
		nextTime = prev.time;
		nextAt = prev.at;
		keptLocalClock = true;
	}

	return {
		anchor: {
			time: nextTime,
			at: nextAt,
			playing: true,
			videoId: resolvedVideoId,
			duration,
		},
		lastVideoId,
		displayTime: keptLocalClock ? null : nextTime,
		keptLocalClock,
	};
}
