package com.karol.controller

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

object VlcApiClient {
	private const val TIMEOUT_MS = 8_000
	private const val CLIENT_HEADER = "KarolController/1.0"

	fun vlcApiBaseFromControllerUrl(controllerUrl: String): String? {
		return try {
			val uri = android.net.Uri.parse(controllerUrl)
			val host = uri.host ?: return null
			val port = uri.port.takeIf { it > 0 } ?: 3131
			val scheme = uri.scheme ?: "http"
			"$scheme://$host:$port/api/vlc-dj"
		} catch (_: Exception) {
			null
		}
	}

	suspend fun fetchVlcNowPlaying(apiBase: String): VlcNowPlayingData? =
		withContext(Dispatchers.IO) {
			val json = getJson("$apiBase/now-playing") ?: return@withContext null
			parseVlcNowPlaying(json)
		}

	suspend fun fetchVlcStatus(apiBase: String): JSONObject? =
		withContext(Dispatchers.IO) {
			getJson("$apiBase/status")
		}

	suspend fun vlcPlay(apiBase: String): Boolean = postSimple("$apiBase/transport/play")
	suspend fun vlcPause(apiBase: String): Boolean = postSimple("$apiBase/transport/pause")
	suspend fun vlcSkipNext(apiBase: String): Boolean = postSimple("$apiBase/transport/skip-next")
	suspend fun vlcSkipPrev(apiBase: String): Boolean = postSimple("$apiBase/transport/skip-prev")

	suspend fun vlcSeek(apiBase: String, seconds: Double): Boolean =
		withContext(Dispatchers.IO) {
			val connection = open("$apiBase/transport/seek", "POST")
			try {
				connection.doOutput = true
				val body = JSONObject().put("seconds", seconds.coerceAtLeast(0.0)).toString()
				connection.outputStream.use { it.write(body.toByteArray()) }
				connection.responseCode in 200..299
			} catch (_: Exception) {
				false
			} finally {
				connection.disconnect()
			}
		}

	suspend fun vlcSetVolume(apiBase: String, levelPercent: Int): Boolean =
		withContext(Dispatchers.IO) {
			val connection = open("$apiBase/transport/volume", "POST")
			try {
				connection.doOutput = true
				val body = JSONObject().put("level", levelPercent).toString()
				connection.outputStream.use { it.write(body.toByteArray()) }
				connection.responseCode in 200..299
			} catch (_: Exception) {
				false
			} finally {
				connection.disconnect()
			}
		}

	suspend fun loadCoverBitmap(apiBase: String, coverUrl: String): Bitmap? =
		withContext(Dispatchers.IO) {
			if (coverUrl.isBlank()) return@withContext null
			try {
				// coverUrl from the backend is a full path like /api/vlc-dj/cover?path=...
				// but apiBase already ends with /api/vlc-dj. Strip the prefix to avoid
				// double-prefix like /api/vlc-dj/api/vlc-dj/cover?path=...
				val resolvedCoverUrl = if (!coverUrl.startsWith("http") && coverUrl.startsWith("/api/vlc-dj/")) {
					coverUrl.removePrefix("/api/vlc-dj")
				} else {
					coverUrl
				}
				val fullUrl = if (resolvedCoverUrl.startsWith("http")) resolvedCoverUrl else "$apiBase$resolvedCoverUrl"
				val connection = open(fullUrl, "GET")
				try {
					if (connection.responseCode !in 200..299) null
					else connection.inputStream.use { BitmapFactory.decodeStream(it) }
				} catch (_: Exception) {
					null
				} finally {
					connection.disconnect()
				}
			} catch (_: Exception) {
				null
			}
		}

	private fun parseVlcNowPlaying(json: JSONObject): VlcNowPlayingData {
		val state = json.optString("state", "stopped")
		return VlcNowPlayingData(
			title = json.optString("title", ""),
			artist = json.optString("artist", ""),
			album = json.optString("album", ""),
			duration = json.optDouble("duration", 0.0),
			position = json.optDouble("position", 0.0),
			state = state,
			filePath = json.optString("filePath", ""),
			id = json.optString("id", ""),
			coverUrl = json.optString("coverUrl", ""),
			isPlaying = state == "playing",
		)
	}

	private suspend fun postSimple(url: String): Boolean =
		withContext(Dispatchers.IO) {
			val connection = open(url, "POST")
			try {
				connection.doOutput = true
				connection.outputStream.use { it.write("{}".toByteArray()) }
				connection.responseCode in 200..299
			} catch (_: Exception) {
				false
			} finally {
				connection.disconnect()
			}
		}

	private fun getJson(url: String): JSONObject? {
		val connection = open(url, "GET")
		return try {
			if (connection.responseCode !in 200..299) null
			else {
				val body = connection.inputStream.bufferedReader().use { it.readText() }
				JSONObject(body)
			}
		} catch (_: Exception) {
			null
		} finally {
			connection.disconnect()
		}
	}

	private fun open(url: String, method: String): HttpURLConnection =
		(URL(url).openConnection() as HttpURLConnection).apply {
			requestMethod = method
			connectTimeout = TIMEOUT_MS
			readTimeout = TIMEOUT_MS
			setRequestProperty("Content-Type", "application/json")
			setRequestProperty("X-Karol-Client", CLIENT_HEADER)
		}
}
