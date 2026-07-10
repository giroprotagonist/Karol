package com.karol.controller

/**
 * Fan-out for VLC now-playing snapshots between notification service and in-app WebView.
 */
object VlcPlaybackRelay {
	enum class Source {
		NOTIFICATION,
		WEBVIEW,
	}

	@Volatile
	var latest: VlcNowPlayingData? = null

	private val listeners = mutableSetOf<(VlcNowPlayingData?, Source) -> Unit>()

	fun addListener(listener: (VlcNowPlayingData?, Source) -> Unit) {
		synchronized(listeners) { listeners.add(listener) }
	}

	fun removeListener(listener: (VlcNowPlayingData?, Source) -> Unit) {
		synchronized(listeners) { listeners.remove(listener) }
	}

	fun publish(
		data: VlcNowPlayingData?,
		source: Source,
	) {
		if (data != null && isSameSnapshot(data, latest)) return
		if (data != null) latest = data
		val snapshot = synchronized(listeners) { listeners.toList() }
		snapshot.forEach { it(data, source) }
	}

	fun publishPosition(resolved: VlcNowPlayingData) {
		latest = resolved
		val snapshot = synchronized(listeners) { listeners.toList() }
		snapshot.forEach { it(resolved, Source.NOTIFICATION) }
	}

	private fun isSameSnapshot(a: VlcNowPlayingData?, b: VlcNowPlayingData?): Boolean {
		if (a == null || b == null) return false
		return a.id == b.id &&
			a.state == b.state &&
			kotlin.math.abs(a.position - b.position) < 1.0
	}
}

data class VlcNowPlayingData(
	val title: String,
	val artist: String,
	val album: String,
	val duration: Double,
	val position: Double,
	val state: String, // "playing", "paused", "stopped"
	val filePath: String,
	val id: String,
	val coverUrl: String,
	val isPlaying: Boolean,
)
