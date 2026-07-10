package com.karol.player

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONArray
import org.json.JSONObject

class PlayerPreferences(context: Context) {
	private val masterKey =
		MasterKey.Builder(context)
			.setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
			.build()

	private val prefs =
		EncryptedSharedPreferences.create(
			context,
			"karol_player_secure",
			masterKey,
			EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
			EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
		)

	init {
		migrateLegacyPlaylistIfNeeded()
	}

	fun getYouTubeApiKey(): String? = prefs.getString(KEY_API, null)?.takeIf { it.isNotBlank() }

	fun setYouTubeApiKey(key: String?) {
		prefs.edit().putString(KEY_API, key?.trim() ?: "").apply()
	}

	fun getPlaylistModeEnabled(): Boolean = prefs.getBoolean(KEY_PLAYLIST_ENABLED, false)

	fun setPlaylistModeEnabled(enabled: Boolean) {
		prefs.edit().putBoolean(KEY_PLAYLIST_ENABLED, enabled).apply()
	}

	fun getPlaylists(): List<SavedPlaylist> {
		val raw = prefs.getString(KEY_PLAYLISTS_LIBRARY, "[]") ?: "[]"
		return try {
			val arr = JSONArray(raw)
			(0 until arr.length()).map { SavedPlaylist.fromJson(arr.getJSONObject(it)) }
		} catch (_: Exception) {
			emptyList()
		}
	}

	fun savePlaylists(playlists: List<SavedPlaylist>) {
		prefs
			.edit()
			.putString(
				KEY_PLAYLISTS_LIBRARY,
				JSONArray(playlists.map { it.toJson() }).toString(),
			)
			.apply()
	}

	fun getPlaylist(playlistId: String): SavedPlaylist? =
		getPlaylists().firstOrNull { it.playlistId == playlistId }

	fun upsertPlaylist(entry: SavedPlaylist) {
		val playlists = getPlaylists().toMutableList()
		val index = playlists.indexOfFirst { it.playlistId == entry.playlistId }
		if (index >= 0) {
			playlists[index] = entry
		} else {
			playlists.add(entry)
		}
		savePlaylists(playlists)
	}

	fun removePlaylist(playlistId: String): SavedPlaylist? {
		val playlists = getPlaylists().toMutableList()
		val removed = playlists.firstOrNull { it.playlistId == playlistId } ?: return null
		playlists.removeAll { it.playlistId == playlistId }
		savePlaylists(playlists)
		if (getActivePlaylistId() == playlistId) {
			setActivePlaylistId(playlists.firstOrNull()?.playlistId ?: "")
		}
		return removed
	}

	fun getActivePlaylistId(): String = prefs.getString(KEY_ACTIVE_PLAYLIST_ID, "") ?: ""

	fun setActivePlaylistId(playlistId: String) {
		prefs.edit().putString(KEY_ACTIVE_PLAYLIST_ID, playlistId).apply()
	}

	fun getActivePlaylist(): SavedPlaylist? {
		val activeId = getActivePlaylistId()
		if (activeId.isBlank()) {
			return getPlaylists().firstOrNull()
		}
		return getPlaylist(activeId) ?: getPlaylists().firstOrNull()
	}

	/** @deprecated Legacy single-playlist accessors — use library APIs */
	fun getPlaylistId(): String = getActivePlaylist()?.playlistId ?: ""

	fun getPlaylistUrl(): String = getActivePlaylist()?.playlistUrl ?: ""

	fun setPlaylist(playlistId: String, playlistUrl: String) {
		val existing = getPlaylist(playlistId)
		upsertPlaylist(
			SavedPlaylist(
				playlistId = playlistId,
				playlistUrl = playlistUrl,
				name = existing?.name ?: "Playlist",
				syncedVideoIds = existing?.syncedVideoIds ?: emptyList(),
				lastSyncAt = existing?.lastSyncAt,
				lastSyncError = existing?.lastSyncError,
			),
		)
		setActivePlaylistId(playlistId)
	}

	fun getSyncedVideoIds(): List<String> = getActivePlaylist()?.syncedVideoIds ?: emptyList()

	fun setSyncedVideoIds(ids: List<String>) {
		val active = getActivePlaylist() ?: return
		upsertPlaylist(active.copy(syncedVideoIds = ids))
	}

	fun getLastSyncAt(): Long? = getActivePlaylist()?.lastSyncAt

	fun setLastSyncAt(ts: Long) {
		val active = getActivePlaylist() ?: return
		upsertPlaylist(active.copy(lastSyncAt = ts))
	}

	fun getLastSyncError(): String? = getActivePlaylist()?.lastSyncError

	fun setLastSyncError(error: String?) {
		val active = getActivePlaylist() ?: return
		upsertPlaylist(active.copy(lastSyncError = error))
	}

	fun getPlaylistConfig(lastAddedCount: Int): PlaylistModeConfig {
		val playlists = getPlaylists()
		val active = getActivePlaylist()
		val activeId = active?.playlistId ?: ""
		return PlaylistModeConfig(
			enabled = getPlaylistModeEnabled(),
			activePlaylistId = activeId,
			playlists = playlists,
			playlistId = activeId,
			playlistUrl = active?.playlistUrl ?: "",
			syncedVideoIds = active?.syncedVideoIds ?: emptyList(),
			lastSyncAt = active?.lastSyncAt,
			lastSyncError = active?.lastSyncError,
			lastAddedCount = lastAddedCount,
		)
	}

	fun getAutoStartOnBoot(): Boolean = prefs.getBoolean(KEY_AUTO_BOOT, false)

	fun setAutoStartOnBoot(enabled: Boolean) {
		prefs.edit().putBoolean(KEY_AUTO_BOOT, enabled).apply()
	}

	fun cachePlaylistMetadata(
		playlistId: String,
		videos: List<SearchVideo>,
	) {
		if (playlistId.isBlank() || videos.isEmpty()) {
			return
		}
		prefs
			.edit()
			.putString(
				"$KEY_PLAYLIST_META_PREFIX$playlistId",
				JSONArray(videos.map { it.toJson() }).toString(),
			)
			.apply()
	}

	fun loadPlaylistMetadataCache(playlistId: String): List<SearchVideo> {
		if (playlistId.isBlank()) {
			return emptyList()
		}
		val raw = prefs.getString("$KEY_PLAYLIST_META_PREFIX$playlistId", null) ?: return emptyList()
		return try {
			val arr = JSONArray(raw)
			(0 until arr.length()).map { SearchVideo.fromJson(arr.getJSONObject(it)) }
		} catch (_: Exception) {
			emptyList()
		}
	}

	fun hasAskedRuntimePermissions(): Boolean = prefs.getBoolean(KEY_ASKED_PERMS, false)

	fun setAskedRuntimePermissions() {
		prefs.edit().putBoolean(KEY_ASKED_PERMS, true).apply()
	}

	fun setYouTubeSessionVerified(verified: Boolean) {
		prefs.edit().putBoolean(KEY_YT_SESSION_VERIFIED, verified).apply()
	}

	fun isYouTubeSessionVerified(): Boolean = prefs.getBoolean(KEY_YT_SESSION_VERIFIED, false)

	fun setYouTubeSignedInAt(timestampMs: Long) {
		prefs.edit().putLong(KEY_YT_SIGNED_IN_AT, timestampMs).apply()
	}

	fun getYouTubeSignedInAt(): Long = prefs.getLong(KEY_YT_SIGNED_IN_AT, 0L)

	fun setYouTubePremiumVerified(verified: Boolean) {
		prefs.edit().putBoolean(KEY_YT_PREMIUM_VERIFIED, verified).apply()
	}

	fun isYouTubePremiumVerified(): Boolean = prefs.getBoolean(KEY_YT_PREMIUM_VERIFIED, false)

	fun getTrustedUserAgentVersion(): Int = prefs.getInt(KEY_TRUSTED_UA_VERSION, 0)

	fun setTrustedUserAgentVersion(version: Int) {
		prefs.edit().putInt(KEY_TRUSTED_UA_VERSION, version).apply()
	}

	fun getMacHostIp(): String = prefs.getString(KEY_MAC_HOST_IP, DEFAULT_MAC_HOST_IP) ?: DEFAULT_MAC_HOST_IP

	fun setMacHostIp(host: String) {
		prefs.edit().putString(KEY_MAC_HOST_IP, host.trim()).apply()
	}

	fun getMacProxyBaseUrl(): String {
		val ip = getMacHostIp()
		return "http://$ip:3131"
	}

	fun getVolumeLevel(): Double =
		prefs.getFloat(KEY_VOLUME_LEVEL, 1f).toDouble().coerceIn(0.0, 1.0)

	fun setVolumeLevel(level: Double) {
		prefs.edit().putFloat(KEY_VOLUME_LEVEL, level.coerceIn(0.0, 1.0).toFloat()).apply()
	}

	private fun migrateLegacyPlaylistIfNeeded() {
		if (prefs.contains(KEY_PLAYLISTS_LIBRARY)) {
			return
		}
		val legacyId = prefs.getString(KEY_PLAYLIST_ID, "") ?: ""
		if (legacyId.isBlank()) {
			prefs.edit().putString(KEY_PLAYLISTS_LIBRARY, "[]").apply()
			return
		}
		val legacyUrl = prefs.getString(KEY_PLAYLIST_URL, "") ?: ""
		val legacySynced =
			try {
				val arr = JSONArray(prefs.getString(KEY_SYNCED_IDS, "[]") ?: "[]")
				(0 until arr.length()).map { arr.getString(it) }
			} catch (_: Exception) {
				emptyList()
			}
		val lastSync = prefs.getLong(KEY_LAST_SYNC, -1L).takeIf { it >= 0 }
		val lastError = prefs.getString(KEY_LAST_SYNC_ERROR, null)
		val entry =
			JSONObject()
				.put("playlistId", legacyId)
				.put("playlistUrl", legacyUrl)
				.put("name", "My Playlist")
				.put("syncedVideoIds", JSONArray(legacySynced))
				.put("lastSyncAt", lastSync ?: JSONObject.NULL)
				.put("lastSyncError", lastError ?: JSONObject.NULL)
		prefs
			.edit()
			.putString(KEY_PLAYLISTS_LIBRARY, JSONArray().put(entry).toString())
			.putString(KEY_ACTIVE_PLAYLIST_ID, legacyId)
			.apply()
	}

	companion object {
		private const val KEY_API = "youtube_api_key"
		private const val KEY_MAC_HOST_IP = "mac_host_ip"
		private const val DEFAULT_MAC_HOST_IP = "192.168.68.51"
		private const val KEY_PLAYLIST_ENABLED = "playlist_enabled"
		private const val KEY_PLAYLISTS_LIBRARY = "playlists_library"
		private const val KEY_ACTIVE_PLAYLIST_ID = "active_playlist_id"
		private const val KEY_PLAYLIST_ID = "playlist_id"
		private const val KEY_PLAYLIST_URL = "playlist_url"
		private const val KEY_SYNCED_IDS = "synced_video_ids"
		private const val KEY_LAST_SYNC = "last_sync_at"
		private const val KEY_LAST_SYNC_ERROR = "last_sync_error"
		private const val KEY_AUTO_BOOT = "auto_start_boot"
		private const val KEY_ASKED_PERMS = "asked_runtime_perms"
		private const val KEY_VOLUME_LEVEL = "volume_level"
		private const val KEY_YT_SESSION_VERIFIED = "youtube_session_verified"
		private const val KEY_YT_SIGNED_IN_AT = "youtube_signed_in_at"
		private const val KEY_YT_PREMIUM_VERIFIED = "youtube_premium_verified"
		private const val KEY_TRUSTED_UA_VERSION = "trusted_ua_version"
		private const val KEY_PLAYLIST_META_PREFIX = "playlist_meta_"
	}
}
