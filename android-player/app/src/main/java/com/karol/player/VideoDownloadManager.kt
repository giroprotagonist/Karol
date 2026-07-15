package com.karol.player

import android.content.Context
import android.util.Log
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream

class VideoDownloadManager(
	private val context: Context,
) {
	private val client = OkHttpClient.Builder()
		.connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
		.readTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
		.build()
	private val cacheDir = File(context.cacheDir, "karol_videos")
	private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

	init {
		cacheDir.mkdirs()
		cleanOldCache()
	}

	fun getServerBaseUrl(): String {
		val prefs = context.getSharedPreferences("karol_player", Context.MODE_PRIVATE)
		val savedHost = prefs.getString("dj_host_ip", null)
		val savedPort = prefs.getString("dj_host_port", null)

		// Use mDNS-discovered host if fresh enough
		val mdnsHost = _mdnsMacHost
		if (mdnsHost != null && System.currentTimeMillis() - _mdnsMacHostAt < MDNS_CACHE_TTL_MS) {
			return "http://${mdnsHost.first}:${mdnsHost.second}"
		}

		// Fallback: last known from SharedPreferences
		val host = savedHost ?: "192.168.68.50"
		val port = savedPort ?: "3131"
		return "http://$host:$port"
	}

	/**
	 * Refresh the Mac host via mDNS. Call this at startup and periodically.
	 * Safe to call from any thread — discovery runs on a background coroutine.
	 */
	fun refreshMacHostAsync() {
		scope.launch {
			val result = KarolMdnsBrowser.findMacHost(context)
			if (result != null) {
				_mdnsMacHost = result
				_mdnsMacHostAt = System.currentTimeMillis()
				Log.i(TAG, "Mac host discovered via mDNS: ${result.first}:${result.second}")
				// Persist to preferences for fallback on next cold start
				context.getSharedPreferences("karol_player", Context.MODE_PRIVATE)
					.edit()
					.putString("dj_host_ip", result.first)
					.putString("dj_host_port", result.second.toString())
					.apply()
			} else {
				Log.w(TAG, "No Mac host found via mDNS")
			}
		}
	}

	fun download(
		videoId: String,
		onProgress: (Float) -> Unit,
		onReady: (File, List<File>) -> Unit,
		onError: (String) -> Unit,
	) {
		// Check cache first — if already downloaded, play locally
		val local = getLocalFile(videoId)
		if (local != null) {
			val subs = getLocalSubtitles(videoId)
			Log.i(TAG, "download: $videoId already cached")
			onReady(local, subs)
			return
		}

		// Trigger background download on the Mac. The file will be cached
		// and then onReady is called to start ExoPlayer playback.
		scope.launch {
			try {
				val baseUrl = getServerBaseUrl()
				// Trigger the download via metadata endpoint
				val metaUrl = "$baseUrl/api/library/metadata/$videoId"
				client.newCall(Request.Builder().url(metaUrl).build()).execute().close()
				Log.i(TAG, "download: triggered metadata download for $videoId")

				// Now poll for readiness, then download in background
				val mp4File = File(cacheDir, "$videoId.mp4")
				val mp4Url = "$baseUrl/api/library/file/$videoId"
				val statusUrl = "$baseUrl/api/library/status/$videoId"

				// Poll status for up to 120s (check immediately, then every 5s)
				for (attempt in 0..23) {
					if (attempt > 0) delay(5000L) // skip delay on first poll
					val statusRes = client.newCall(Request.Builder().url(statusUrl).build()).execute()
					val body = statusRes.body?.string() ?: ""
					if (body.contains("\"ready\":true")) {
						Log.i(TAG, "download: file ready on server, fetching for $videoId")
						downloadFile(mp4Url, mp4File) { pct -> onProgress(pct) }
						if (mp4File.exists() && mp4File.length() > 0) {
							Log.i(TAG, "download: cached $videoId (${mp4File.length()} bytes)")
							cleanOldCache()
							val subs = getLocalSubtitles(videoId)
							onReady(mp4File, subs)
						} else {
							onError("Downloaded file is empty")
						}
						return@launch
					}
					// Update progress: show polling status as fraction of attempts
					onProgress((attempt + 1).toFloat() / 24f)
				}
				Log.w(TAG, "download: timed out waiting for $videoId")
				onError("Download timed out — try again")
			} catch (e: Exception) {
				Log.w(TAG, "download: background failed: ${e.message}")
				onError("Download failed: ${e.message}")
			}
		}
	}

	private fun downloadFile(url: String, dest: File, onProgress: (Float) -> Unit) {
		val tmpFile = File(dest.parentFile, dest.name + ".tmp")
		// Clean up any stale tmp file from previous interrupted download
		tmpFile.delete()
		val req = Request.Builder().url(url).build()
		val response = client.newCall(req).execute()
		if (!response.isSuccessful) throw RuntimeException("HTTP ${response.code}")
		val body = response.body ?: throw RuntimeException("Empty response")
		val contentLength = body.contentLength()
		val input = body.byteStream()
		val output = FileOutputStream(tmpFile)
		var totalRead = 0L
		val buffer = ByteArray(8192)
		var bytesRead: Int
		while (input.read(buffer).also { bytesRead = it } != -1) {
			output.write(buffer, 0, bytesRead)
			totalRead += bytesRead
			if (contentLength > 0) onProgress(totalRead.toFloat() / contentLength)
		}
		output.flush()
		output.close()
		input.close()
		// Atomic rename — only the complete file exists at dest
		if (!tmpFile.renameTo(dest)) {
			// Fallback: copy then delete tmp
			tmpFile.copyTo(dest, overwrite = true)
			tmpFile.delete()
		}
	}

	fun getLocalFile(videoId: String): File? {
		val file = File(cacheDir, "$videoId.mp4")
		// Require at least 500 KB — anything smaller is a stale partial download
		return if (file.exists() && file.length() > 500_000) file else {
			// Clean up stale partial files
			if (file.exists()) file.delete()
			null
		}
	}

	fun getLocalSubtitles(videoId: String): List<File> {
		return cacheDir.listFiles()?.filter {
			it.name.startsWith(videoId) && it.name.endsWith(".vtt") && it.length() > 20
		} ?: emptyList()
	}

	fun deleteAll(videoId: String) {
		cacheDir.listFiles()?.filter { it.name.startsWith(videoId) }?.forEach {
			it.delete()
			Log.i(TAG, "cleanup: deleted ${it.name}")
		}
	}

	private fun cleanOldCache() {
		// Also clean up stale .tmp files from interrupted downloads
		cacheDir.listFiles()?.filter { it.name.endsWith(".tmp") }?.forEach { it.delete() }
		val mp4Files = cacheDir.listFiles()?.filter { it.name.endsWith(".mp4") }
			?.sortedBy { it.lastModified() } ?: return
		if (mp4Files.size <= 5) return  // keep up to 5 recent videos cached
		for (i in 0 until mp4Files.size - 5) {
			deleteAll(mp4Files[i].name.removeSuffix(".mp4"))
		}
	}

	companion object {
		private const val TAG = "VideoDownload"

		@Volatile
		private var _mdnsMacHost: Pair<String, Int>? = null

		@Volatile
		private var _mdnsMacHostAt: Long = 0

		private const val MDNS_CACHE_TTL_MS = 5 * 60 * 1000L // 5 min
	}
}
