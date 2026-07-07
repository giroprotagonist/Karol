package com.deskreen.controller

/**
 * Fan-out for now-playing snapshots between the notification service and in-app WebView.
 * Avoids each UI waiting on its own poll interval to reflect transport from the other.
 */
object PlaybackStateRelay {
	enum class Source {
		NOTIFICATION,
		WEBVIEW,
	}

	@Volatile
	var latest: DjNowPlaying? = null

	private val listeners = mutableSetOf<(DjNowPlaying?, Source) -> Unit>()

	private fun isSameSnapshot(
		a: DjNowPlaying?,
		b: DjNowPlaying?,
	): Boolean {
		if (a == null || b == null) {
			return false
		}
		return a.videoId == b.videoId &&
			a.state == b.state &&
			kotlin.math.abs(a.currentTimeSec - b.currentTimeSec) < 1.0
	}

	fun addListener(listener: (DjNowPlaying?, Source) -> Unit) {
		synchronized(listeners) { listeners.add(listener) }
	}

	fun removeListener(listener: (DjNowPlaying?, Source) -> Unit) {
		synchronized(listeners) { listeners.remove(listener) }
	}

	fun publish(
		nowPlaying: DjNowPlaying?,
		source: Source,
	) {
		if (nowPlaying != null && isSameSnapshot(nowPlaying, latest)) {
			return
		}
		if (nowPlaying != null) {
			latest = nowPlaying
		}
		val snapshot = synchronized(listeners) { listeners.toList() }
		snapshot.forEach { it(nowPlaying, source) }
	}

	/** Position tick / resolved time — always forward so WebView stays in sync with notification. */
	fun publishPosition(resolved: DjNowPlaying) {
		latest = resolved
		val snapshot = synchronized(listeners) { listeners.toList() }
		snapshot.forEach { it(resolved, Source.NOTIFICATION) }
	}
}
