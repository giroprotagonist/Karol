/** Console diagnostics for S8/tablet receiver — captured via adb logcat. */
export function receiverPlaybackDebug(
	message: string,
	data: Record<string, unknown> = {},
): void {
	if (typeof console === 'undefined') {
		return;
	}
	console.warn('[S8_PLAYBACK]', message, JSON.stringify(data));
}
