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
		val host = savedHost ?: "192.168.68.50"
		val port = savedPort ?: "3131"
		return "http://$host:$port"
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

		// Trigger background download on the Mac, then immediately fall back
		// to YouTube. The file will be cached for the next time this video plays.
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

				// Poll status for up to 120s
				for (attempt in 0..23) {
					delay(5000L)
					val statusRes = client.newCall(Request.Builder().url(statusUrl).build()).execute()
					val body = statusRes.body?.string() ?: ""
					if (body.contains("\"ready\":true")) {
						Log.i(TAG, "download: file ready on server, fetching for $videoId")
						downloadFile(mp4Url, mp4File) { }
						if (mp4File.exists() && mp4File.length() > 0) {
							Log.i(TAG, "download: cached $videoId (${mp4File.length()} bytes)")
						}
						cleanOldCache()
						return@launch
					}
				}
				Log.w(TAG, "download: timed out waiting for $videoId")
			} catch (e: Exception) {
				Log.w(TAG, "download: background failed: ${e.message}")
			}
		}

		// Immediately fall back — the file isn't cached, let YouTube play now
		onError("not cached, YouTube fallback")
	}

	private fun downloadFile(url: String, dest: File, onProgress: (Float) -> Unit) {
		val req = Request.Builder().url(url).build()
		val response = client.newCall(req).execute()
		if (!response.isSuccessful) throw RuntimeException("HTTP ${response.code}")
		val body = response.body ?: throw RuntimeException("Empty response")
		val contentLength = body.contentLength()
		val input = body.byteStream()
		val output = FileOutputStream(dest)
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
	}

	fun getLocalFile(videoId: String): File? {
		val file = File(cacheDir, "$videoId.mp4")
		return if (file.exists() && file.length() > 0) file else null
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
		val mp4Files = cacheDir.listFiles()?.filter { it.name.endsWith(".mp4") }
			?.sortedBy { it.lastModified() } ?: return
		if (mp4Files.size <= 2) return
		for (i in 0 until mp4Files.size - 2) {
			deleteAll(mp4Files[i].name.removeSuffix(".mp4"))
		}
	}

	companion object {
		private const val TAG = "VideoDownload"
	}
}
