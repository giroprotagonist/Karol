package com.deskreen.player

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.webkit.CookieManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException

/**
 * Export/import YouTube WebView cookies so testers don't re-auth after reinstall.
 * Survives uninstall when saved to public Downloads/Deskreen/.
 */
object YouTubeSessionBackup {
	private const val TAG = "YouTubeSessionBackup"
	private const val BACKUP_NAME = "deskreen-youtube-session.json"
	private const val DOWNLOADS_SUBDIR = "Download/Deskreen"
	private const val COOKIE_EXPORT_VERSION = 1

	private val COOKIE_URLS =
		listOf(
			"https://www.youtube.com",
			"https://youtube.com",
			"https://accounts.google.com",
			"https://www.google.com",
			"https://google.com",
		)

	fun exportJson(): String {
		val entries = JSONArray()
		val manager = CookieManager.getInstance()
		for (url in COOKIE_URLS) {
			val value = manager.getCookie(url)?.trim().orEmpty()
			if (value.isNotBlank()) {
				entries.put(
					JSONObject()
						.put("url", url)
						.put("value", value),
				)
			}
		}
		return JSONObject()
			.put("version", COOKIE_EXPORT_VERSION)
			.put("exportedAt", System.currentTimeMillis())
			.put("cookies", entries)
			.toString()
	}

	fun importJson(raw: String): Boolean {
		if (raw.isBlank()) {
			return false
		}
		return try {
			val root = JSONObject(raw)
			val cookies = root.optJSONArray("cookies") ?: return false
			val manager = CookieManager.getInstance()
			manager.setAcceptCookie(true)
			var imported = 0
			for (i in 0 until cookies.length()) {
				val entry = cookies.getJSONObject(i)
				val url = entry.optString("url")
				val value = entry.optString("value")
				if (url.isNotBlank() && value.isNotBlank()) {
					manager.setCookie(url, value)
					imported++
				}
			}
			YouTubeSessionHelper.flush()
			imported > 0
		} catch (e: Exception) {
			Log.w(TAG, "import failed", e)
			false
		}
	}

	/** Save to public Downloads/Deskreen (survives app uninstall). */
	fun saveToDevice(context: Context): File? {
		if (!YouTubeSessionHelper.isSignedIn()) {
			return null
		}
		return try {
			val encoded = encode(exportJson())
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
				writeMediaStoreBackup(context, encoded)
				Log.i(TAG, "saved session backup to $DOWNLOADS_SUBDIR/$BACKUP_NAME")
				null
			} else {
				val file = legacyBackupFile()
				file.parentFile?.mkdirs()
				file.writeText(encoded)
				context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
					.edit()
					.putString(KEY_BACKUP_PATH, file.absolutePath)
					.apply()
				Log.i(TAG, "saved session backup to ${file.absolutePath}")
				file
			}
		} catch (e: Exception) {
			Log.w(TAG, "saveToDevice failed", e)
			null
		}
	}

	/** Restore from public backup if cookies are missing. */
	fun tryRestoreOnStartup(context: Context): Boolean {
		if (YouTubeSessionHelper.isSignedIn()) {
			return true
		}
		val encoded =
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
				readMediaStoreBackup(context)
			} else {
				val file = legacyBackupFile()
				if (!file.exists() || file.length() == 0L) {
					return false
				}
				file.readText()
			} ?: return false

		return try {
			val ok = importJson(decode(encoded))
			if (ok && YouTubeSessionHelper.isSignedIn()) {
				YouTubeSessionHelper.markSignedIn(
					(context.applicationContext as PlayerApp).preferences,
				)
				Log.i(TAG, "restored YouTube session from $DOWNLOADS_SUBDIR/$BACKUP_NAME")
				true
			} else {
				ok
			}
		} catch (e: Exception) {
			Log.w(TAG, "restore failed", e)
			false
		}
	}

	fun legacyBackupFile(): File {
		val downloads =
			Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
		return File(File(downloads, "Deskreen"), BACKUP_NAME)
	}

	private fun writeMediaStoreBackup(context: Context, encoded: String) {
		val resolver = context.contentResolver
		deleteMediaStoreBackup(resolver)
		val values =
			ContentValues().apply {
				put(MediaStore.Downloads.DISPLAY_NAME, BACKUP_NAME)
				put(MediaStore.Downloads.MIME_TYPE, "application/json")
				put(MediaStore.Downloads.RELATIVE_PATH, DOWNLOADS_SUBDIR)
				put(MediaStore.Downloads.IS_PENDING, 1)
			}
		val uri =
			resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
				?: throw IOException("MediaStore insert failed")
		resolver.openOutputStream(uri)?.use { it.write(encoded.toByteArray(Charsets.UTF_8)) }
			?: throw IOException("MediaStore openOutputStream failed")
		values.clear()
		values.put(MediaStore.Downloads.IS_PENDING, 0)
		resolver.update(uri, values, null, null)
	}

	private fun readMediaStoreBackup(context: Context): String? {
		val resolver = context.contentResolver
		val projection = arrayOf(MediaStore.Downloads._ID)
		val selection = "${MediaStore.Downloads.DISPLAY_NAME}=?"
		val args = arrayOf(BACKUP_NAME)
		resolver.query(
			MediaStore.Downloads.EXTERNAL_CONTENT_URI,
			projection,
			selection,
			args,
			"${MediaStore.Downloads.DATE_MODIFIED} DESC",
		)?.use { cursor ->
			if (!cursor.moveToFirst()) {
				return null
			}
			val id = cursor.getLong(0)
			val uri = ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, id)
			return resolver.openInputStream(uri)?.use { stream ->
				stream.bufferedReader().readText()
			}
		}
		return null
	}

	private fun deleteMediaStoreBackup(resolver: android.content.ContentResolver) {
		val projection = arrayOf(MediaStore.Downloads._ID)
		val selection = "${MediaStore.Downloads.DISPLAY_NAME}=?"
		val args = arrayOf(BACKUP_NAME)
		resolver.query(
			MediaStore.Downloads.EXTERNAL_CONTENT_URI,
			projection,
			selection,
			args,
			null,
		)?.use { cursor ->
			while (cursor.moveToNext()) {
				val id = cursor.getLong(0)
				val uri = ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, id)
				resolver.delete(uri, null, null)
			}
		}
	}

	private fun encode(plain: String): String =
		Base64.encodeToString(plain.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)

	private fun decode(stored: String): String =
		String(Base64.decode(stored.trim(), Base64.DEFAULT), Charsets.UTF_8)

	private const val PREFS = "youtube_session_backup"
	private const val KEY_BACKUP_PATH = "backup_path"
}
