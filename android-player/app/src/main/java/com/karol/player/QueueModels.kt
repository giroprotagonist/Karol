package com.karol.player

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
	val durationSec: Int? = null,
	val playlistPosition: Int? = null,
	val addedAtMs: Long? = null,
	val publishedAtMs: Long? = null,
	val viewCount: Long? = null,
	val channelTitle: String? = null,
	val requester: String? = null,
) {
	fun toJson(): JSONObject =
		JSONObject()
			.put("id", id)
			.put("url", url)
			.put("videoId", videoId)
			.put("title", title)
			.put("thumbnail", thumbnail)
			.put("status", status)
			.put("errorReason", errorReason ?: JSONObject.NULL)
			.put("durationSec", durationSec ?: JSONObject.NULL)
			.put("playlistPosition", playlistPosition ?: JSONObject.NULL)
			.put("addedAtMs", addedAtMs ?: JSONObject.NULL)
			.put("publishedAtMs", publishedAtMs ?: JSONObject.NULL)
			.put("viewCount", viewCount ?: JSONObject.NULL)
			.put("channelTitle", channelTitle ?: JSONObject.NULL)
			.put("requester", requester ?: JSONObject.NULL)

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
				durationSec = obj.optionalInt("durationSec"),
				playlistPosition = obj.optionalInt("playlistPosition"),
				addedAtMs = obj.optionalLong("addedAtMs"),
				publishedAtMs = obj.optionalLong("publishedAtMs"),
				viewCount = obj.optionalLong("viewCount"),
				channelTitle = obj.optString("channelTitle").ifBlank { null },
				requester = obj.optString("requester").ifBlank { null },
			)
	}
}

data class SearchVideo(
	val videoId: String,
	val title: String,
	val channelTitle: String,
	val thumbnailUrl: String,
	val url: String,
	val playlistPosition: Int? = null,
	val addedAtMs: Long? = null,
	val publishedAtMs: Long? = null,
	val durationSec: Int? = null,
	val viewCount: Long? = null,
) {
	fun toJson(): JSONObject =
		JSONObject()
			.put("videoId", videoId)
			.put("title", title)
			.put("channelTitle", channelTitle)
			.put("thumbnailUrl", thumbnailUrl)
			.put("url", url)
			.put("playlistPosition", playlistPosition ?: JSONObject.NULL)
			.put("addedAtMs", addedAtMs ?: JSONObject.NULL)
			.put("publishedAtMs", publishedAtMs ?: JSONObject.NULL)
			.put("durationSec", durationSec ?: JSONObject.NULL)
			.put("viewCount", viewCount ?: JSONObject.NULL)

	companion object {
		fun fromJson(obj: JSONObject): SearchVideo =
			SearchVideo(
				videoId = obj.optString("videoId"),
				title = obj.optString("title"),
				channelTitle = obj.optString("channelTitle"),
				thumbnailUrl = obj.optString("thumbnailUrl"),
				url = obj.optString("url"),
				playlistPosition = obj.optionalInt("playlistPosition"),
				addedAtMs = obj.optionalLong("addedAtMs"),
				publishedAtMs = obj.optionalLong("publishedAtMs"),
				durationSec = obj.optionalInt("durationSec"),
				viewCount = obj.optionalLong("viewCount"),
			)
	}
}

private fun JSONObject.optionalInt(key: String): Int? {
	if (isNull(key)) {
		return null
	}
	return optInt(key)
}

private fun JSONObject.optionalLong(key: String): Long? {
	if (isNull(key)) {
		return null
	}
	return optLong(key)
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
	val layoutOk: Boolean = true,
	val videoTopPx: Int = 0,
	val thumbnail: String = "",
)

data class SavedPlaylist(
	val playlistId: String,
	val playlistUrl: String,
	val name: String,
	val syncedVideoIds: List<String> = emptyList(),
	val lastSyncAt: Long? = null,
	val lastSyncError: String? = null,
) {
	fun toJson(): JSONObject =
		JSONObject()
			.put("playlistId", playlistId)
			.put("playlistUrl", playlistUrl)
			.put("name", name)
			.put("syncedVideoIds", JSONArray(syncedVideoIds))
			.put("lastSyncAt", lastSyncAt ?: JSONObject.NULL)
			.put("lastSyncError", lastSyncError ?: JSONObject.NULL)
			.put("videoCount", syncedVideoIds.size)

	companion object {
		fun fromJson(obj: JSONObject): SavedPlaylist =
			SavedPlaylist(
				playlistId = obj.optString("playlistId"),
				playlistUrl = obj.optString("playlistUrl"),
				name = obj.optString("name", "Playlist"),
				syncedVideoIds =
					obj.optJSONArray("syncedVideoIds")?.let { arr ->
						(0 until arr.length()).map { arr.getString(it) }
					} ?: emptyList(),
				lastSyncAt =
					obj.optLong("lastSyncAt", -1L).takeIf { it >= 0 },
				lastSyncError =
					if (obj.isNull("lastSyncError")) {
						null
					} else {
						obj.optString("lastSyncError").ifBlank { null }
					},
			)
	}
}

data class PlaylistModeConfig(
	val enabled: Boolean,
	val activePlaylistId: String,
	val playlists: List<SavedPlaylist>,
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
			.put("activePlaylistId", activePlaylistId)
			.put(
				"playlists",
				JSONArray(playlists.map { it.toJson() }),
			)
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
	shuffleEnabled: Boolean,
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
		.put("shuffleEnabled", shuffleEnabled)
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
		shuffleEnabled = engine.shuffleEnabled,
		currentTitle = engine.currentTitle,
		currentTime = engine.currentTime,
		duration = engine.duration,
		updatedAt = snap.updatedAt,
		isPlaying = engine.isPlaying,
		currentThumbnail = engine.currentThumbnail,
	)
}
