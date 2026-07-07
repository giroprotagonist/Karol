package com.deskreen.player

import android.util.Log
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
		if (preferences.getActivePlaylist() == null) {
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
		val active = preferences.getActivePlaylist()
		if (active == null) {
			return syncErrorResult("no active playlist", System.currentTimeMillis())
		}
		return runSyncForPlaylist(active.playlistId)
	}

	fun runSyncForPlaylist(playlistId: String): JSONObject {
		val syncedAt = System.currentTimeMillis()
		if (!preferences.getPlaylistModeEnabled()) {
			return syncErrorResult("playlist sync disabled", syncedAt, playlistId)
		}
		val entry = preferences.getPlaylist(playlistId)
		if (entry == null) {
			return syncErrorResult("playlist not found", syncedAt, playlistId)
		}
		return try {
			val (resolvedId, videos) = dataClient.fetchPlaylistVideos(entry.playlistUrl)
			val normalized = normalizeVideoMetadata(videos)
			preferences.cachePlaylistMetadata(resolvedId, normalized)
			val playlistUrl =
				if (entry.playlistUrl.contains("http")) {
					entry.playlistUrl
				} else {
					"https://www.youtube.com/playlist?list=$resolvedId"
				}
			val title =
				if (entry.name == "Playlist" || entry.name == "My Playlist") {
					dataClient.fetchPlaylistTitle(resolvedId, playlistUrl)
				} else {
					entry.name
				}
			val syncedSet = entry.syncedVideoIds.toMutableSet()
			val added = mutableListOf<SearchVideo>()
			for (video in normalized) {
				if (!syncedSet.contains(video.videoId)) {
					added.add(video)
				}
				syncedSet.add(video.videoId)
			}
			val updated =
				entry.copy(
					playlistId = resolvedId,
					playlistUrl = playlistUrl,
					name = title,
					syncedVideoIds = syncedSet.toList(),
					lastSyncAt = syncedAt,
					lastSyncError = null,
				)
			preferences.upsertPlaylist(updated)
			if (resolvedId == preferences.getActivePlaylistId()) {
				val queueAdded = queueEngine.addNewVideos(added, "playlist")
				lastAddedCount = queueAdded.size
			} else {
				lastAddedCount = 0
			}
			JSONObject()
				.put("added", JSONArray(added.map { it.toJson() }))
				.put("playlistId", resolvedId)
				.put("syncedAt", syncedAt)
		} catch (error: Exception) {
			val message = error.message ?: "playlist sync failed"
			preferences.upsertPlaylist(entry.copy(lastSyncError = message))
			lastAddedCount = 0
			syncErrorResult(message, syncedAt, playlistId)
		}
	}

	fun addPlaylist(playlistUrlOrId: String): SavedPlaylist {
		val input = playlistUrlOrId.trim()
		val playlistId =
			dataClient.extractPlaylistId(input)
				?: throw IllegalArgumentException("Invalid playlist URL or ID")
		val playlistUrl =
			if (input.contains("http")) {
				input
			} else {
				"https://www.youtube.com/playlist?list=$playlistId"
			}
		val existing = preferences.getPlaylist(playlistId)
		if (existing != null) {
			return existing
		}
		val name = dataClient.fetchPlaylistTitle(playlistId, playlistUrl)
		val entry =
			SavedPlaylist(
				playlistId = playlistId,
				playlistUrl = playlistUrl,
				name = name,
			)
		preferences.upsertPlaylist(entry)
		if (preferences.getActivePlaylistId().isBlank()) {
			preferences.setActivePlaylistId(playlistId)
		}
		return entry
	}

	fun activatePlaylist(
		playlistId: String,
		playFirst: Boolean = false,
	): PlaylistModeConfig {
		val entry =
			preferences.getPlaylist(playlistId)
				?: throw IllegalArgumentException("Playlist not found")
		preferences.setActivePlaylistId(playlistId)
		queueEngine.clearQueue()
		val (resolvedId, videos) = dataClient.fetchPlaylistVideos(entry.playlistUrl)
		val normalized = normalizeVideoMetadata(videos)
		preferences.cachePlaylistMetadata(resolvedId, normalized)
		val playlistUrl =
			if (entry.playlistUrl.contains("http")) {
				entry.playlistUrl
			} else {
				"https://www.youtube.com/playlist?list=$resolvedId"
			}
		val name = dataClient.fetchPlaylistTitle(resolvedId, playlistUrl)
		val syncedAt = System.currentTimeMillis()
		preferences.upsertPlaylist(
			entry.copy(
				playlistId = resolvedId,
				playlistUrl = playlistUrl,
				name = name,
				syncedVideoIds = videos.map { it.videoId },
				lastSyncAt = syncedAt,
				lastSyncError = null,
			),
		)
		queueEngine.addNewVideos(normalized, "playlist")
		lastAddedCount = videos.size
		if (playFirst && videos.isNotEmpty()) {
			val first =
				queueEngine.getQueueSnapshot().queue.firstOrNull {
					it.videoId == videos.first().videoId
				}
			if (first != null) {
				queueEngine.playNow(first.id, "playlist-activate")
			}
		}
		if (preferences.getPlaylistModeEnabled()) {
			startPollingIfEnabled()
		}
		return preferences.getPlaylistConfig(lastAddedCount)
	}

	fun enrichQueueMetadataForSort() {
		val playlistId = preferences.getActivePlaylistId()
		if (playlistId.isBlank()) {
			return
		}
		val cached = preferences.loadPlaylistMetadataCache(playlistId)
		if (cached.isNotEmpty()) {
			queueEngine.enrichFromVideos(cached)
			return
		}
		val entry = preferences.getActivePlaylist() ?: return
		try {
			val (resolvedId, videos) = dataClient.fetchPlaylistVideos(entry.playlistUrl)
			val normalized = normalizeVideoMetadata(videos)
			preferences.cachePlaylistMetadata(resolvedId, normalized)
			queueEngine.enrichFromVideos(normalized)
		} catch (error: Exception) {
			Log.w(TAG, "sort metadata refresh failed", error)
		}
	}

	private fun normalizeVideoMetadata(videos: List<SearchVideo>): List<SearchVideo> =
		videos.mapIndexed { index, video ->
			video.copy(playlistPosition = video.playlistPosition ?: (index + 1))
		}

	fun removePlaylist(playlistId: String): PlaylistModeConfig {
		val wasActive = preferences.getActivePlaylistId() == playlistId
		preferences.removePlaylist(playlistId)
		if (wasActive) {
			queueEngine.clearQueue()
			val next = preferences.getActivePlaylist()
			if (next != null && preferences.getPlaylistModeEnabled()) {
				activatePlaylist(next.playlistId, playFirst = false)
			}
		}
		lastAddedCount = 0
		return preferences.getPlaylistConfig(lastAddedCount)
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
				?: preferences.getActivePlaylist()?.playlistUrl
		if (input.isNullOrBlank()) {
			throw IllegalArgumentException("Add a playlist before enabling sync")
		}
		val entry = addPlaylist(input)
		val previousActive = preferences.getActivePlaylistId()
		val wasEnabled = preferences.getPlaylistModeEnabled()
		preferences.setPlaylistModeEnabled(true)
		if (previousActive != entry.playlistId || !wasEnabled) {
			return activatePlaylist(entry.playlistId, playFirst = false)
		}
		runSync()
		startPollingIfEnabled()
		return preferences.getPlaylistConfig(lastAddedCount)
	}

	private fun syncErrorResult(
		message: String,
		syncedAt: Long,
		playlistId: String = preferences.getActivePlaylistId(),
	): JSONObject =
		JSONObject()
			.put("added", JSONArray())
			.put("playlistId", playlistId)
			.put("syncedAt", syncedAt)
			.put("error", message)

	companion object {
		private const val TAG = "PlaylistSyncManager"
		private const val PLAYLIST_SYNC_INTERVAL_MS = 180_000L
	}
}
