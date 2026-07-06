package com.deskreen.player

import org.json.JSONArray
import org.json.JSONObject

data class QueueItem(
	val id: String,
	val url: String,
	val videoId: String,
	val title: String,
	val thumbnail: String,
	val status: String = "queued",
	val errorReason: String? = null,
) {
	fun toJson(): JSONObject =
		JSONObject()
			.put("id", id)
			.put("url", url)
			.put("videoId", videoId)
			.put("title", title)
			.put("thumbnail", thumbnail)
			.put("status", status)
			.put("errorReason", errorReason)

	companion object {
		fun fromJson(obj: JSONObject): QueueItem =
			QueueItem(
				id = obj.optString("id"),
				url = obj.optString("url"),
				videoId = obj.optString("videoId"),
				title = obj.optString("title"),
				thumbnail = obj.optString("thumbnail"),
				status = obj.optString("status", "queued"),
				errorReason = obj.optString("errorReason").ifBlank { null },
			)
	}
}

data class SearchVideo(
	val videoId: String,
	val title: String,
	val channelTitle: String,
	val thumbnailUrl: String,
	val url: String,
) {
	fun toJson(): JSONObject =
		JSONObject()
			.put("videoId", videoId)
			.put("title", title)
			.put("channelTitle", channelTitle)
			.put("thumbnailUrl", thumbnailUrl)
			.put("url", url)
}

data class PlayerSnapshot(
	val state: Int,
	val videoId: String,
	val title: String,
	val currentTime: Double,
	val duration: Double,
	val paused: Boolean = false,
	val ended: Boolean = false,
	val hasVideo: Boolean = false,
)

data class PlaylistModeConfig(
	val enabled: Boolean,
	val playlistId: String,
	val playlistUrl: String,
	val syncedVideoIds: List<String>,
	val lastSyncAt: Long?,
	val lastSyncError: String?,
	val lastAddedCount: Int,
) {
	fun toJson(): JSONObject =
		JSONObject()
			.put("enabled", enabled)
			.put("playlistId", playlistId)
			.put("playlistUrl", playlistUrl)
			.put("syncedVideoIds", JSONArray(syncedVideoIds))
			.put("lastSyncAt", lastSyncAt ?: JSONObject.NULL)
			.put("lastSyncError", lastSyncError ?: JSONObject.NULL)
			.put("lastAddedCount", lastAddedCount)
}

fun queueSnapshotJson(
	queue: List<QueueItem>,
	currentIndex: Int,
	mode: String,
	currentTitle: String,
	currentTime: Double,
	duration: Double,
	updatedAt: Long,
	isPlaying: Boolean,
	currentThumbnail: String,
): JSONObject =
	JSONObject()
		.put("ok", true)
		.put("queue", JSONArray(queue.map { it.toJson() }))
		.put("currentIndex", currentIndex)
		.put("mode", mode)
		.put("currentTitle", currentTitle)
		.put("currentThumbnail", currentThumbnail)
		.put("currentTime", currentTime)
		.put("duration", duration)
		.put("isPlaying", isPlaying)
		.put("updatedAt", updatedAt)

fun karaokeStateJson(engine: QueueEngine): JSONObject {
	val snap = engine.getQueueSnapshot()
	return queueSnapshotJson(
		queue = snap.queue,
		currentIndex = snap.currentIndex,
		mode = snap.mode,
		currentTitle = engine.currentTitle,
		currentTime = engine.currentTime,
		duration = engine.duration,
		updatedAt = snap.updatedAt,
		isPlaying = engine.isPlaying,
		currentThumbnail = engine.currentThumbnail,
	)
}
