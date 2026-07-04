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

/** Target playout delay when receiver quality buffer is enabled. */
export const RECEIVER_QUALITY_BUFFER_DELAY_MS = 5000;

/** Longer frame-stall tolerance while quality buffer is filling. */
export const RECEIVER_QUALITY_BUFFER_FRAME_STALE_MS = 25000;

/** Longer frozen threshold before recovery kicks in with quality buffer. */
export const RECEIVER_QUALITY_BUFFER_FROZEN_THRESHOLD_MS = 20000;
