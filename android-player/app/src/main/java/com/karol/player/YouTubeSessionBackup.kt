package com.karol.player

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
 * Survives uninstall when saved to public Downloads/Karol/.
 */
object YouTubeSessionBackup {
	private const val TAG = "YouTubeSessionBackup"
	private const val BACKUP_NAME = "karol-youtube-session.json"
	private const val DOWNLOADS_SUBDIR = "Download/Karol"
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
			// Pre-inject consent cookie so YouTube doesn't block with the dialog
			manager.setCookie("https://www.youtube.com", "CONSENT=YES+; Domain=.youtube.com; Path=/")
			manager.setCookie("https://youtube.com", "CONSENT=YES+; Domain=.youtube.com; Path=/")
			manager.setCookie("https://m.youtube.com", "CONSENT=YES+; Domain=.youtube.com; Path=/")
			var imported = 0
			for (i in 0 until cookies.length()) {
				val entry = cookies.getJSONObject(i)
				val url = entry.optString("url")
				val value = entry.optString("value")
				if (url.isNotBlank() && value.isNotBlank()) {
					manager.setCookie(url, value)
					// Also set on m.youtube.com for mobile redirect
					if (url.contains("www.youtube.com") || url.contains("youtube.com")) {
						val mobileUrl = url.replace("www.youtube.com", "m.youtube.com")
							.replace("https://youtube.com", "https://m.youtube.com")
						if (mobileUrl != url) {
							manager.setCookie(mobileUrl, value)
						}
					}
					imported++
				}
			}
			YouTubeSessionHelper.flush()
			// #region agent log H4: cookie state after restore
			val ytCookies = manager.getCookie("https://www.youtube.com").orEmpty()
			val hasLoginInfo = ytCookies.contains("LOGIN_INFO=")
			val hasSid = ytCookies.contains("SID=") || ytCookies.contains("SAPISID=")
			Log.i(TAG, "cookiesAfterRestore: imported=$imported loginInfo=$hasLoginInfo sid=$hasSid")
			// #endregion
			imported > 0
		} catch (e: Exception) {
			Log.w(TAG, "import failed", e)
			false
		}
	}

	/** Save to public Downloads/Karol (survives app uninstall). */
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

	/** Restore from public backup if cookies are missing.
	 * Tries device backup (app-private copy pushed by install script),
	 * then MediaStore, then raw filesystem path. */
	fun tryRestoreOnStartup(context: Context): Boolean {
		if (YouTubeSessionHelper.isSignedIn()) {
			return true
		}
		val encoded = readAnyBackup(context) ?: return false

		return try {
			val ok = importJson(decode(encoded))
			if (ok && YouTubeSessionHelper.isSignedIn()) {
				YouTubeSessionHelper.markSignedIn(
					(context.applicationContext as PlayerApp).preferences,
				)
				Log.i(TAG, "restored YouTube session from backup")
				true
			} else {
				ok
			}
		} catch (e: Exception) {
			Log.w(TAG, "restore failed", e)
			false
		}
	}

	/** Probe all backup locations. */
	private fun readAnyBackup(context: Context): String? {
		// 1. App-private backup file (pushed by scripts/adb)
		val privateFile = File(context.filesDir, BACKUP_NAME)
		if (privateFile.exists() && privateFile.length() > 0) {
			Log.i(TAG, "found backup in app-private storage")
			return privateFile.readText()
		}
		// 2. App external files dir (adb-push friendly, always readable)
		val extDir = context.getExternalFilesDir(null)
		if (extDir != null) {
			val extFile = File(extDir, BACKUP_NAME)
			if (extFile.exists() && extFile.length() > 0) {
				Log.i(TAG, "found backup in app external files")
				return extFile.readText()
			}
		}
		// 3. MediaStore
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
			readMediaStoreBackup(context)?.let {
				Log.i(TAG, "found backup via MediaStore")
				return it
			}
		}
		// 4. Raw filesystem path (legacy, pre-Android 10 only)
		val legacyFile = legacyBackupFile()
		if (legacyFile.exists() && legacyFile.length() > 0) {
			try {
				Log.i(TAG, "found backup at legacy path")
				return legacyFile.readText()
			} catch (_: Exception) {
				// Scoped storage may block raw reads on Android 10+
			}
		}
		return null
	}

	fun legacyBackupFile(): File {
		val downloads =
			Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
		return File(File(downloads, "Karol"), BACKUP_NAME)
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
		var uri: Uri? = null
		try {
			uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
		} catch (_: Exception) {
			// Insert may fail if an adb-pushed file occupies the same name
			// and MediaStore delete didn't clean it up. Fall through to raw write.
		}
		try {
			if (uri != null) {
				resolver.openOutputStream(uri)?.use { it.write(encoded.toByteArray(Charsets.UTF_8)) }
				values.clear()
				values.put(MediaStore.Downloads.IS_PENDING, 0)
				resolver.update(uri, values, null, null)
			}
		} catch (_: Exception) {
			// MediaStore write failed — write raw so restore can still work.
		}
		if (uri == null) {
			// Fallback: write to raw filesystem path (adb-pushed restore reads this).
			val file = legacyBackupFile()
			file.parentFile?.mkdirs()
			file.writeText(encoded)
		}
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
