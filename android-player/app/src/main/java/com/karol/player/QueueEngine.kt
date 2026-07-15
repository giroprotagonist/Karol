package com.karol.player

import android.content.Context
import android.net.Uri
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

class QueueEngine(context: Context) {
	private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

	var queue: MutableList<QueueItem> = mutableListOf()
		private set
	var currentIndex: Int = -1
		private set
	var mode: String = "queue"
		private set
	var shuffleEnabled: Boolean = false
		private set
	var isPlaying: Boolean = false
		private set
	var currentTitle: String = ""
		private set
	var currentThumbnail: String = ""
		set
	var currentTime: Double = 0.0
		private set
	var duration: Double = 0.0
		private set
	private var snapshotUpdatedAt: Long = 0L

	/** Queue indices visited in shuffle mode (for skip-prev). */
	private val shufflePlayHistory = mutableListOf<Int>()

	var lastAdvanceReason: String = ""
		private set

	var onLoadVideo: ((videoId: String) -> Unit)? = null
	var onSeekVideo: ((seconds: Double) -> Unit)? = null

	init {
		loadFromStorage()
	}

	data class QueueSnapshot(
		val queue: List<QueueItem>,
		val currentIndex: Int,
		val mode: String,
		val updatedAt: Long,
	)

	fun getQueueSnapshot(): QueueSnapshot =
		QueueSnapshot(
			queue = queue.toList(),
			currentIndex = currentIndex,
			mode = mode,
			updatedAt = snapshotUpdatedAt,
		)

	fun getKaraokeStateJson(): JSONObject = karaokeStateJson(this)

	fun setMode(newMode: String) {
		if (newMode != "queue" && newMode != "hotswap" && newMode != "manual") {
			return
		}
		mode = newMode
		persist()
	}

	fun setShuffleEnabled(enabled: Boolean) {
		shuffleEnabled = enabled
		if (!enabled) {
			shufflePlayHistory.clear()
		}
		persist()
	}

	fun shuffleUpcoming(): Boolean {
		if (queue.isEmpty()) {
			return false
		}
		val start =
			when {
				currentIndex < 0 -> 0
				currentIndex >= queue.lastIndex -> return false
				else -> currentIndex + 1
			}
		val tail = queue.subList(start, queue.size).toMutableList()
		tail.shuffle()
		tail.forEachIndexed { offset, item ->
			queue[start + offset] = item
		}
		persist()
		return true
	}

	private fun pickNextShuffleIndex(): Int? {
		val candidates =
			queue.indices.filter { idx ->
				idx != currentIndex && queue[idx].status != "ended"
			}
		if (candidates.isEmpty()) {
			return null
		}
		return candidates.random()
	}

	private fun shouldShuffleAdvance(): Boolean = shuffleEnabled && mode == "queue"

	private fun pushShuffleHistory(fromIndex: Int) {
		if (!shouldShuffleAdvance() || fromIndex < 0) {
			return
		}
		if (shufflePlayHistory.lastOrNull() == fromIndex) {
			return
		}
		shufflePlayHistory.add(fromIndex)
		while (shufflePlayHistory.size > 50) {
			shufflePlayHistory.removeAt(0)
		}
	}

	private fun advanceToIndex(
		nextIndex: Int,
		recordHistory: Boolean = true,
	): String {
		if (recordHistory && currentIndex >= 0) {
			pushShuffleHistory(currentIndex)
		}
		resetPlaybackClock()
		// Immediately populate thumbnail from the queue item's known URL
		currentTitle = queue[nextIndex].title
		currentThumbnail = queue[nextIndex].thumbnail.ifBlank {
			"https://i.ytimg.com/vi/${queue[nextIndex].videoId}/hqdefault.jpg"
		}
		currentIndex = nextIndex
		queue[nextIndex] = queue[nextIndex].copy(status = "loading")
		isPlaying = true
		persist()
		onLoadVideo?.invoke(queue[nextIndex].videoId)
		return queue[nextIndex].videoId
	}

	private fun resetPlaybackClock() {
		currentTime = 0.0
		duration = 0.0
		currentThumbnail = ""
		currentTitle = ""
	}

	private fun queuedIds(): MutableSet<String> {
		val ids = mutableSetOf<String>()
		for (item in queue) {
			if (item.status in listOf("queued", "loading", "playing")) {
				ids.add(item.videoId)
			}
		}
		return ids
	}

	fun addNewVideos(videos: List<SearchVideo>, source: String): List<QueueItem> {
		val ids = queuedIds()
		val added = mutableListOf<QueueItem>()
		val now = System.currentTimeMillis()
		videos.forEachIndexed { index, video ->
			if (ids.contains(video.videoId)) {
				return@forEachIndexed
			}
			ids.add(video.videoId)
			val item =
				QueueItem(
					id = "$source-$now-$index-${video.videoId}",
					url = video.url,
					videoId = video.videoId,
					title = video.title,
					thumbnail = video.thumbnailUrl,
					status = "queued",
					durationSec = video.durationSec,
					playlistPosition = video.playlistPosition ?: (index + 1),
					addedAtMs = video.addedAtMs,
					publishedAtMs = video.publishedAtMs,
					viewCount = video.viewCount,
					channelTitle = video.channelTitle.ifBlank { null },
				)
			queue.add(item)
			added.add(item)
		}
		if (added.isNotEmpty()) {
			persist()
		}
		return added
	}

	fun removeFromQueue(id: String) {
		val removedIndex = queue.indexOfFirst { it.id == id }
		queue.removeAll { it.id == id }
		if (removedIndex >= 0 && removedIndex < currentIndex) {
			currentIndex -= 1
		}
		if (currentIndex >= queue.size) {
			currentIndex = queue.size - 1
		}
		if (queue.isEmpty()) {
			currentIndex = -1
			isPlaying = false
			currentTitle = ""
		}
		persist()
	}

	fun enrichFromVideos(videos: List<SearchVideo>) {
		if (videos.isEmpty() || queue.isEmpty()) {
			return
		}
		val byVideoId = videos.associateBy { it.videoId }
		var changed = false
		for (i in queue.indices) {
			val item = queue[i]
			val meta = byVideoId[item.videoId] ?: continue
			val updated = item.enrichFrom(meta)
			if (updated != item) {
				queue[i] = updated
				changed = true
			}
		}
		if (changed) {
			persist()
		}
	}

	fun sortQueue(mode: String): Boolean {
		if (queue.size < 2 || mode.isBlank() || mode == "custom") {
			return false
		}
		val currentId = queue.getOrNull(currentIndex)?.id
		val originalOrder = queue.map { it.id }
		val sorted =
			when (mode) {
				"date-added-newest" ->
					queue.sortedWith(
						compareByDescending<QueueItem> { it.addedAtMs ?: Long.MIN_VALUE }
							.thenBy { it.playlistPosition ?: Int.MAX_VALUE },
					)
				"date-added-oldest" ->
					queue.sortedWith(
						compareBy<QueueItem> { it.addedAtMs ?: Long.MAX_VALUE }
							.thenByDescending { it.playlistPosition ?: Int.MIN_VALUE },
					)
				"published-newest" ->
					queue.sortedWith(
						compareByDescending<QueueItem> { it.publishedAtMs ?: Long.MIN_VALUE }
							.thenBy { it.title.lowercase() },
					)
				"published-oldest" ->
					queue.sortedWith(
						compareBy<QueueItem> { it.publishedAtMs ?: Long.MAX_VALUE }
							.thenBy { it.title.lowercase() },
					)
				"popular" ->
					queue.sortedWith(
						compareByDescending<QueueItem> { it.viewCount ?: Long.MIN_VALUE }
							.thenBy { it.title.lowercase() },
					)
				"duration-longest" ->
					queue.sortedWith(
						compareByDescending<QueueItem> { it.durationSec ?: Int.MIN_VALUE }
							.thenBy { it.title.lowercase() },
					)
				"duration-shortest" ->
					queue.sortedWith(
						compareBy<QueueItem> { it.durationSec ?: Int.MAX_VALUE }
							.thenBy { it.title.lowercase() },
					)
				"title-asc" ->
					queue.sortedWith(
						compareBy(String.CASE_INSENSITIVE_ORDER) { it.title },
					)
				"title-desc" ->
					queue.sortedWith(
						compareByDescending(String.CASE_INSENSITIVE_ORDER) { it.title },
					)
				"playlist-order" ->
					queue.sortedWith(
						compareBy<QueueItem> { it.playlistPosition ?: Int.MAX_VALUE },
					)
				else -> return false
			}
		if (sorted.map { it.id } == originalOrder) {
			return true
		}
		queue.clear()
		queue.addAll(sorted)
		if (currentId != null) {
			currentIndex = queue.indexOfFirst { it.id == currentId }
		}
		persist()
		return true
	}

	fun reorderQueue(fromIndex: Int, toIndex: Int) {
		if (
			fromIndex < 0 ||
			toIndex < 0 ||
			fromIndex >= queue.size ||
			toIndex >= queue.size ||
			fromIndex == toIndex
		) {
			return
		}
		val item = queue.removeAt(fromIndex)
		queue.add(toIndex, item)
		currentIndex =
			when {
				currentIndex == fromIndex -> toIndex
				fromIndex < currentIndex && toIndex >= currentIndex -> currentIndex - 1
				fromIndex > currentIndex && toIndex <= currentIndex -> currentIndex + 1
				else -> currentIndex
			}
		persist()
	}

	fun clearQueue() {
		queue.clear()
		currentIndex = -1
		shufflePlayHistory.clear()
		isPlaying = false
		currentTitle = ""
		currentThumbnail = ""
		currentTime = 0.0
		duration = 0.0
		persist()
	}

	fun logAdvance(reason: String) {
		Log.i("KarolAdvance", reason)
		lastAdvanceReason = reason
	}

	fun playNow(
		id: String,
		reason: String = "play-now",
	): String? {
		val index = queue.indexOfFirst { it.id == id }
		if (index < 0) {
			return null
		}
		logAdvance(reason)
		resetPlaybackClock()
		currentIndex = index
		queue[index] = queue[index].copy(status = "loading")
		isPlaying = true
		persist()
		val videoId = queue[index].videoId
		onLoadVideo?.invoke(videoId)
		return videoId
	}

	fun skipNext(reason: String = "user-skip"): String? {
		if (queue.isEmpty()) {
			return null
		}
		logAdvance(reason)
		val nextIndex =
			if (shouldShuffleAdvance()) {
				pickNextShuffleIndex()
			} else if (currentIndex < 0) {
				0
			} else {
				minOf(currentIndex + 1, queue.size - 1)
			}
		if (nextIndex == null) {
			return null
		}
		return advanceToIndex(nextIndex)
	}

	fun skipPrev(reason: String = "user-skip-prev"): String? {
		if (queue.isEmpty()) {
			return null
		}
		logAdvance(reason)
		if (currentIndex in queue.indices && currentTime > 3.0) {
			resetPlaybackClock()
			isPlaying = true
			persist()
			onSeekVideo?.invoke(0.0)
			return queue[currentIndex].videoId
		}
		if (shouldShuffleAdvance() && shufflePlayHistory.isNotEmpty()) {
			val prevIndex = shufflePlayHistory.removeLast()
			if (prevIndex in queue.indices) {
				return advanceToIndex(prevIndex, recordHistory = false)
			}
		}
		val prevIndex = maxOf(0, if (currentIndex <= 0) 0 else currentIndex - 1)
		resetPlaybackClock()
		currentIndex = prevIndex
		queue[prevIndex] = queue[prevIndex].copy(status = "loading")
		isPlaying = true
		persist()
		onLoadVideo?.invoke(queue[prevIndex].videoId)
		return queue[prevIndex].videoId
	}

	fun onVideoEnded(reason: String = "ended-confirmed"): String? {
		logAdvance(reason)
		if (currentIndex in queue.indices) {
			queue[currentIndex] = queue[currentIndex].copy(status = "ended")
		}
		if (mode == "manual") {
			isPlaying = false
			persist()
			return null
		}
		if (mode == "queue") {
			val nextIndex =
				if (shouldShuffleAdvance()) {
					pickNextShuffleIndex()
				} else {
					val sequential = currentIndex + 1
					if (sequential < queue.size) sequential else null
				}
			if (nextIndex != null) {
				advanceToIndex(nextIndex)
				return queue[nextIndex].videoId
			}
		}
		isPlaying = false
		currentTitle = ""
		currentTime = 0.0
		duration = 0.0
		persist()
		return null
	}

	fun markCurrentError(reason: String) {
		if (currentIndex in queue.indices) {
			queue[currentIndex] =
				queue[currentIndex].copy(status = "error", errorReason = reason)
		}
		isPlaying = false
		persist()
	}

	fun clearCurrentError() {
		if (currentIndex !in queue.indices) {
			return
		}
		val item = queue[currentIndex]
		if (item.status == "error" || item.errorReason != null) {
			queue[currentIndex] =
				item.copy(
					status = if (item.status == "error") "loading" else item.status,
					errorReason = null,
				)
		}
		if (!isPlaying) {
			isPlaying = true
			persist()
		}
	}

	fun setNowPlaying(
		title: String,
		thumbnail: String,
		time: Double,
		dur: Double,
	) {
		currentTitle = title
		currentThumbnail = thumbnail
		currentTime = time
		duration = dur
		isPlaying = true
		if (currentIndex in queue.indices) {
			queue[currentIndex] =
				queue[currentIndex].copy(
					status = "playing",
					title = title.ifBlank { queue[currentIndex].title },
				)
		}
	}

	fun setPlaybackProgress(time: Double, dur: Double) {
		currentTime = time
		duration = dur
	}

	fun setTransportPlaying(playing: Boolean) {
		isPlaying = playing
	}

	fun addFromUrl(url: String, action: String, requester: String? = null, songTitle: String? = null): String? {
		val videoId = extractVideoId(url) ?: return null
		val displayTitle = songTitle ?: "YouTube: $videoId"
		val item =
			QueueItem(
				id = "manual-${System.currentTimeMillis()}-$videoId",
				url = "https://www.youtube.com/watch?v=$videoId",
				videoId = videoId,
				title = displayTitle,
				thumbnail = "https://i.ytimg.com/vi/$videoId/maxresdefault.jpg",
				status = if (action == "play-now") "loading" else "queued",
				requester = requester,
			)
		queue.add(item)
		if (action == "play-now") {
			logAdvance("play-now-url")
			currentIndex = queue.size - 1
			isPlaying = true
			persist()
			onLoadVideo?.invoke(videoId)
		} else {
			persist()
		}
		return videoId
	}

	fun getCurrentVideoId(): String? =
		if (currentIndex in queue.indices) queue[currentIndex].videoId else null

	private fun persist() {
		snapshotUpdatedAt = System.currentTimeMillis()
		val json =
			JSONObject()
				.put("queue", JSONArray(queue.map { it.toJson() }))
				.put("currentIndex", currentIndex)
				.put("mode", mode)
				.put("shuffleEnabled", shuffleEnabled)
				.put("currentTitle", currentTitle)
				.put("currentThumbnail", currentThumbnail)
				.put("currentTime", currentTime)
				.put("duration", duration)
				.put("updatedAt", snapshotUpdatedAt)
		prefs.edit().putString(KEY_QUEUE, json.toString()).apply()
	}

	private fun loadFromStorage() {
		val raw = prefs.getString(KEY_QUEUE, null) ?: return
		try {
			val data = JSONObject(raw)
			val arr = data.optJSONArray("queue") ?: return
			queue =
				(0 until arr.length())
					.map { QueueItem.fromJson(arr.getJSONObject(it)) }
					.toMutableList()
			currentIndex = data.optInt("currentIndex", -1)
			mode = data.optString("mode", "queue")
			shuffleEnabled = data.optBoolean("shuffleEnabled", false)
			currentTitle = data.optString("currentTitle", "")
			currentThumbnail = data.optString("currentThumbnail", "")
			currentTime = data.optDouble("currentTime", 0.0)
			duration = data.optDouble("duration", 0.0)
			snapshotUpdatedAt = data.optLong("updatedAt", 0L)
		} catch (_: Exception) {
			// ignore corrupt storage
		}
	}

	companion object {
		private const val PREFS = "karol_player_queue"
		private const val KEY_QUEUE = "queue_snapshot"

		fun extractVideoId(url: String): String? {
			val trimmed = url.trim()
			if (Regex("^[a-zA-Z0-9_-]{11}$").matches(trimmed)) {
				return trimmed
			}
			return try {
				val uri = Uri.parse(trimmed)
				when {
					uri.host?.contains("youtube.com") == true -> uri.getQueryParameter("v")
					uri.host?.contains("youtu.be") == true ->
						uri.pathSegments.firstOrNull()?.takeIf { it.isNotBlank() }
					else -> null
				}
			} catch (_: Exception) {
				null
			}
		}
	}
}

private fun QueueItem.enrichFrom(meta: SearchVideo): QueueItem =
	copy(
		playlistPosition = meta.playlistPosition ?: playlistPosition,
		addedAtMs = meta.addedAtMs ?: addedAtMs,
		publishedAtMs = meta.publishedAtMs ?: publishedAtMs,
		durationSec = meta.durationSec ?: durationSec,
		viewCount = meta.viewCount ?: viewCount,
		channelTitle = meta.channelTitle.ifBlank { null } ?: channelTitle,
		title =
			if (title.startsWith("YouTube:") && !meta.title.startsWith("YouTube:")) {
				meta.title
			} else {
				title
			},
	)
