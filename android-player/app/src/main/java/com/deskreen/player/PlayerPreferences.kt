package com.deskreen.player

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONArray

class PlayerPreferences(context: Context) {
	private val masterKey =
		MasterKey.Builder(context)
			.setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
			.build()

	private val prefs =
		EncryptedSharedPreferences.create(
			context,
			"deskreen_player_secure",
			masterKey,
			EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
			EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
		)

	fun getYouTubeApiKey(): String? = prefs.getString(KEY_API, null)?.takeIf { it.isNotBlank() }

	fun setYouTubeApiKey(key: String?) {
		prefs.edit().putString(KEY_API, key?.trim() ?: "").apply()
	}

	fun getPlaylistModeEnabled(): Boolean = prefs.getBoolean(KEY_PLAYLIST_ENABLED, false)

	fun setPlaylistModeEnabled(enabled: Boolean) {
		prefs.edit().putBoolean(KEY_PLAYLIST_ENABLED, enabled).apply()
	}

	fun getPlaylistId(): String = prefs.getString(KEY_PLAYLIST_ID, "") ?: ""

	fun getPlaylistUrl(): String = prefs.getString(KEY_PLAYLIST_URL, "") ?: ""

	fun setPlaylist(playlistId: String, playlistUrl: String) {
		prefs
			.edit()
			.putString(KEY_PLAYLIST_ID, playlistId)
			.putString(KEY_PLAYLIST_URL, playlistUrl)
			.apply()
	}

	fun getSyncedVideoIds(): List<String> {
		val raw = prefs.getString(KEY_SYNCED_IDS, "[]") ?: "[]"
		return try {
			val arr = JSONArray(raw)
			(0 until arr.length()).map { arr.getString(it) }
		} catch (_: Exception) {
			emptyList()
		}
	}

	fun setSyncedVideoIds(ids: List<String>) {
		prefs.edit().putString(KEY_SYNCED_IDS, JSONArray(ids).toString()).apply()
	}

	fun getLastSyncAt(): Long? {
		val v = prefs.getLong(KEY_LAST_SYNC, -1L)
		return if (v < 0) null else v
	}

	fun setLastSyncAt(ts: Long) {
		prefs.edit().putLong(KEY_LAST_SYNC, ts).apply()
	}

	fun getLastSyncError(): String? = prefs.getString(KEY_LAST_SYNC_ERROR, null)

	fun setLastSyncError(error: String?) {
		prefs.edit().putString(KEY_LAST_SYNC_ERROR, error).apply()
	}

	fun getPlaylistConfig(lastAddedCount: Int): PlaylistModeConfig =
		PlaylistModeConfig(
			enabled = getPlaylistModeEnabled(),
			playlistId = getPlaylistId(),
			playlistUrl = getPlaylistUrl(),
			syncedVideoIds = getSyncedVideoIds(),
			lastSyncAt = getLastSyncAt(),
			lastSyncError = getLastSyncError(),
			lastAddedCount = lastAddedCount,
		)

	companion object {
		private const val KEY_API = "youtube_api_key"
		private const val KEY_PLAYLIST_ENABLED = "playlist_enabled"
		private const val KEY_PLAYLIST_ID = "playlist_id"
		private const val KEY_PLAYLIST_URL = "playlist_url"
		private const val KEY_SYNCED_IDS = "synced_video_ids"
		private const val KEY_LAST_SYNC = "last_sync_at"
		private const val KEY_LAST_SYNC_ERROR = "last_sync_error"
	}
}
