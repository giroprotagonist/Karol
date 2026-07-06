package com.deskreen.player

import android.content.Context
import android.net.Uri
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
	var isPlaying: Boolean = false
		private set
	var currentTitle: String = ""
		private set
	var currentThumbnail: String = ""
		private set
	var currentTime: Double = 0.0
		private set
	var duration: Double = 0.0
		private set
	private var snapshotUpdatedAt: Long = 0L

	var onLoadVideo: ((videoId: String) -> Unit)? = null

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
		isPlaying = false
		currentTitle = ""
		currentThumbnail = ""
		currentTime = 0.0
		duration = 0.0
		persist()
	}

	fun playNow(id: String): String? {
		val index = queue.indexOfFirst { it.id == id }
		if (index < 0) {
			return null
		}
		currentIndex = index
		queue[index] = queue[index].copy(status = "loading")
		isPlaying = true
		persist()
		val videoId = queue[index].videoId
		onLoadVideo?.invoke(videoId)
		return videoId
	}

	fun skipNext(): String? {
		if (queue.isEmpty()) {
			return null
		}
		val nextIndex =
			if (currentIndex < 0) 0 else minOf(currentIndex + 1, queue.size - 1)
		currentIndex = nextIndex
		queue[nextIndex] = queue[nextIndex].copy(status = "loading")
		isPlaying = true
		persist()
		onLoadVideo?.invoke(queue[nextIndex].videoId)
		return queue[nextIndex].videoId
	}

	fun skipPrev(): String? {
		if (queue.isEmpty()) {
			return null
		}
		val prevIndex = maxOf(0, if (currentIndex <= 0) 0 else currentIndex - 1)
		currentIndex = prevIndex
		queue[prevIndex] = queue[prevIndex].copy(status = "loading")
		isPlaying = true
		persist()
		onLoadVideo?.invoke(queue[prevIndex].videoId)
		return queue[prevIndex].videoId
	}

	fun onVideoEnded(): String? {
		if (currentIndex in queue.indices) {
			queue[currentIndex] = queue[currentIndex].copy(status = "ended")
		}
		if (mode == "manual") {
			isPlaying = false
			persist()
			return null
		}
		if (mode == "queue") {
			val nextIndex = currentIndex + 1
			if (nextIndex < queue.size) {
				currentIndex = nextIndex
				queue[nextIndex] = queue[nextIndex].copy(status = "loading")
				persist()
				onLoadVideo?.invoke(queue[nextIndex].videoId)
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

	fun addFromUrl(url: String, action: String): String? {
		val videoId = extractVideoId(url) ?: return null
		val item =
			QueueItem(
				id = "manual-${System.currentTimeMillis()}-$videoId",
				url = "https://www.youtube.com/watch?v=$videoId",
				videoId = videoId,
				title = "YouTube: $videoId",
				thumbnail = "https://i.ytimg.com/vi/$videoId/default.jpg",
				status = if (action == "play-now") "loading" else "queued",
			)
		queue.add(item)
		if (action == "play-now") {
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
		private const val PREFS = "deskreen_player_queue"
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
