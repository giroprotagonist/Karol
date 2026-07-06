/** Grace before tearing down an active cast when signaling socket drops. */
export const DEFAULT_SOCKET_DISCONNECT_GRACE_MS = 8000;

/** Longer grace for dedicated receiver / tablet WebView sessions. */
export const RECEIVER_SOCKET_DISCONNECT_GRACE_MS = 15000;

/** Grace before showing disconnect after remote video track ends. */
export const DEFAULT_TRACK_ENDED_GRACE_MS = 8000;

export const RECEIVER_TRACK_ENDED_GRACE_MS = 15000;

/** Socket ping health check: failures before disconnect (× interval). */
export const DEFAULT_DISCONNECT_STREAK_THRESHOLD = 3;

export const RECEIVER_DISCONNECT_STREAK_THRESHOLD = 6;

export const SOCKET_PING_TIMEOUT_MS = 5000;

export const SOCKET_HEALTH_CHECK_INTERVAL_MS = 5000;

/** Standard receiver playout buffer — pre-roll + playoutDelayHint target. */
export const RECEIVER_BUFFER_STANDARD_MS = 7000;

/** Chromium Android WebView caps jitterBufferTarget (ms) — match 7s pre-roll target. */
export const RECEIVER_JITTER_BUFFER_TARGET_MAX_MS = RECEIVER_BUFFER_STANDARD_MS;

/** Target playout delay when receiver quality buffer is enabled. */
export const RECEIVER_QUALITY_BUFFER_DELAY_MS = RECEIVER_BUFFER_STANDARD_MS;

/** Extra RTP playout delay on audio vs video — tuned via drift monitor. */
export const RECEIVER_AUDIO_PLAYOUT_OFFSET_MS = 0;

/** Longer frame-stall tolerance while quality buffer is filling. */
export const RECEIVER_QUALITY_BUFFER_FRAME_STALE_MS =
	RECEIVER_BUFFER_STANDARD_MS * 10 - 1000;

/** Longer frozen threshold before recovery kicks in with quality buffer. */
export const RECEIVER_QUALITY_BUFFER_FROZEN_THRESHOLD_MS =
	RECEIVER_BUFFER_STANDARD_MS * 7;

/** Max wait after pre-roll for first video frame before falling back to audio unlock. */
export const RECEIVER_AV_START_MAX_WAIT_MS = RECEIVER_BUFFER_STANDARD_MS + 3000;

/** Re-apply RTP jitter hints during pre-roll/priming (WebRTC may reset on track events). */
export const RECEIVER_PREROLL_JITTER_REAPPLY_MS = 2000;
