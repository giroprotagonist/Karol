package com.deskreen.player

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

class PlaylistSyncManager(
	private val scope: CoroutineScope,
	private val preferences: PlayerPreferences,
	private val dataClient: YouTubeDataClient,
	private val queueEngine: QueueEngine,
) {
	private var pollJob: Job? = null
	var lastAddedCount: Int = 0
		private set

	fun startPollingIfEnabled() {
		stopPolling()
		if (!preferences.getPlaylistModeEnabled()) {
			return
		}
		pollJob =
			scope.launch(Dispatchers.IO) {
				while (isActive) {
					runSync()
					delay(PLAYLIST_SYNC_INTERVAL_MS)
				}
			}
	}

	fun stopPolling() {
		pollJob?.cancel()
		pollJob = null
	}

	fun runSync(): JSONObject {
		val syncedAt = System.currentTimeMillis()
		if (!preferences.getPlaylistModeEnabled()) {
			return syncErrorResult("playlist mode disabled", syncedAt)
		}
		val playlistId = preferences.getPlaylistId()
		if (playlistId.isBlank()) {
			return syncErrorResult("playlist mode disabled", syncedAt)
		}
		return try {
			val input = preferences.getPlaylistUrl().ifBlank { playlistId }
			val (resolvedId, videos) = dataClient.fetchPlaylistVideos(input)
			if (resolvedId != playlistId) {
				preferences.setPlaylist(resolvedId, preferences.getPlaylistUrl())
			}
			val syncedSet = preferences.getSyncedVideoIds().toMutableSet()
			val added = mutableListOf<SearchVideo>()
			for (video in videos) {
				if (!syncedSet.contains(video.videoId)) {
					added.add(video)
				}
				syncedSet.add(video.videoId)
			}
			preferences.setSyncedVideoIds(syncedSet.toList())
			preferences.setLastSyncAt(syncedAt)
			preferences.setLastSyncError(null)
			val queueAdded = queueEngine.addNewVideos(added, "playlist")
			lastAddedCount = queueAdded.size
			JSONObject()
				.put("added", JSONArray(added.map { it.toJson() }))
				.put("playlistId", resolvedId)
				.put("syncedAt", syncedAt)
		} catch (error: Exception) {
			val message = error.message ?: "playlist sync failed"
			preferences.setLastSyncError(message)
			lastAddedCount = 0
			syncErrorResult(message, syncedAt)
		}
	}

	fun setPlaylistMode(
		enabled: Boolean,
		playlistUrlOrId: String?,
	): PlaylistModeConfig {
		if (!enabled) {
			preferences.setPlaylistModeEnabled(false)
			stopPolling()
			return preferences.getPlaylistConfig(lastAddedCount)
		}
		val input =
			playlistUrlOrId?.trim()?.takeIf { it.isNotBlank() }
				?: preferences.getPlaylistUrl().ifBlank {
					"https://www.youtube.com/playlist?list=PLRxCSLihrLO4"
				}
		val playlistId =
			dataClient.extractPlaylistId(input)
				?: throw IllegalArgumentException("Invalid playlist URL or ID")
		val playlistUrl =
			if (input.contains("http")) {
				input
			} else {
				"https://www.youtube.com/playlist?list=$playlistId"
			}
		val previousId = preferences.getPlaylistId()
		val wasEnabled = preferences.getPlaylistModeEnabled()
		preferences.setPlaylistModeEnabled(true)
		preferences.setPlaylist(playlistId, playlistUrl)
		if (!wasEnabled) {
			preferences.setSyncedVideoIds(emptyList())
			preferences.setLastSyncAt(-1L)
			preferences.setLastSyncError(null)
			lastAddedCount = 0
		}
		if (playlistId != previousId) {
			preferences.setSyncedVideoIds(emptyList())
			preferences.setLastSyncAt(-1L)
			preferences.setLastSyncError(null)
			lastAddedCount = 0
			queueEngine.clearQueue()
		}
		runSync()
		startPollingIfEnabled()
		return preferences.getPlaylistConfig(lastAddedCount)
	}

	private fun syncErrorResult(
		message: String,
		syncedAt: Long,
	): JSONObject =
		JSONObject()
			.put("added", JSONArray())
			.put("playlistId", preferences.getPlaylistId())
			.put("syncedAt", syncedAt)
			.put("error", message)

	companion object {
		private const val PLAYLIST_SYNC_INTERVAL_MS = 180_000L
	}
}
