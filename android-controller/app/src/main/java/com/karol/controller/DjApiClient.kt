package com.karol.controller

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

data class DjNowPlaying(
	val title: String,
	val videoId: String,
	val thumbnailUrl: String,
	val currentTimeSec: Double,
	val durationSec: Double,
	val state: Int,
) {
	val isPlaying: Boolean
		get() = state == 1

	val isPaused: Boolean
		get() = state == 2
}

data class TransportResult(
	val ok: Boolean,
	val nowPlaying: DjNowPlaying?,
)

object DjApiClient {
	private const val TIMEOUT_MS = 8_000
	private const val CLIENT_HEADER = "KarolController/1.0"

	suspend fun fetchNowPlaying(apiBase: String): DjNowPlaying? =
		withContext(Dispatchers.IO) {
			val json = getJson("$apiBase/now-playing") ?: return@withContext null
			val parsed = parseNowPlaying(json) ?: return@withContext null
			enrichFromQueue(apiBase, parsed)
		}

	suspend fun play(apiBase: String): TransportResult = transportPost(apiBase, "$apiBase/transport/play")

	suspend fun pause(apiBase: String): TransportResult = transportPost(apiBase, "$apiBase/transport/pause")

	suspend fun skipNext(apiBase: String): TransportResult = transportPost(apiBase, "$apiBase/transport/skip-next")

	suspend fun skipPrev(apiBase: String): TransportResult = transportPost(apiBase, "$apiBase/transport/skip-prev")

	suspend fun seek(
		apiBase: String,
		seconds: Double,
	): TransportResult =
		withContext(Dispatchers.IO) {
			val connection = open("$apiBase/transport/seek", "POST")
			try {
				connection.doOutput = true
				val body = JSONObject().put("seconds", seconds.coerceAtLeast(0.0)).toString()
				connection.outputStream.use { it.write(body.toByteArray()) }
				if (connection.responseCode !in 200..299) {
					return@withContext TransportResult(ok = false, nowPlaying = null)
				}
				val responseBody = connection.inputStream.bufferedReader().use { it.readText() }
				val json = JSONObject(responseBody)
				val nowPlaying =
					json.optJSONObject("nowPlaying")
						?.let { parseNowPlaying(it) }
						?.let { enrichFromQueue(apiBase, it) }
				TransportResult(ok = json.optBoolean("ok", true), nowPlaying = nowPlaying)
			} catch (_: Exception) {
				TransportResult(ok = false, nowPlaying = null)
			} finally {
				connection.disconnect()
			}
		}

	suspend fun seekRelative(
		apiBase: String,
		delta: Double,
	): TransportResult =
		withContext(Dispatchers.IO) {
			val connection = open("$apiBase/transport/seek-relative", "POST")
			try {
				connection.doOutput = true
				val body = JSONObject().put("delta", delta).toString()
				connection.outputStream.use { it.write(body.toByteArray()) }
				if (connection.responseCode !in 200..299) {
					return@withContext TransportResult(ok = false, nowPlaying = null)
				}
				val responseBody = connection.inputStream.bufferedReader().use { it.readText() }
				val json = JSONObject(responseBody)
				val nowPlaying =
					json.optJSONObject("nowPlaying")
						?.let { parseNowPlaying(it) }
						?.let { enrichFromQueue(apiBase, it) }
				TransportResult(ok = json.optBoolean("ok", true), nowPlaying = nowPlaying)
			} catch (_: Exception) {
				TransportResult(ok = false, nowPlaying = null)
			} finally {
				connection.disconnect()
			}
		}

	suspend fun setVolume(
		apiBase: String,
		level: Double,
	): Boolean =
		withContext(Dispatchers.IO) {
			val clamped = level.coerceIn(0.0, 1.0)
			val connection = open("$apiBase/transport/volume", "POST")
			try {
				connection.doOutput = true
				val body = JSONObject().put("level", clamped).toString()
				connection.outputStream.use { it.write(body.toByteArray()) }
				connection.responseCode in 200..299
			} catch (_: Exception) {
				false
			} finally {
				connection.disconnect()
			}
		}

	suspend fun fetchVolumeLevel(apiBase: String): Double? =
		withContext(Dispatchers.IO) {
			val health = getJson("$apiBase/health")
			if (health != null && health.has("volumeLevel")) {
				return@withContext health.optDouble("volumeLevel", 1.0).coerceIn(0.0, 1.0)
			}
			val nowPlaying = getJson("$apiBase/now-playing")
			if (nowPlaying != null && nowPlaying.has("volumeLevel")) {
				return@withContext nowPlaying.optDouble("volumeLevel", 1.0).coerceIn(0.0, 1.0)
			}
			null
		}

	suspend fun loadBitmap(url: String): Bitmap? =
		withContext(Dispatchers.IO) {
			if (url.isBlank()) {
				return@withContext null
			}
			val connection = open(url, "GET")
			try {
				if (connection.responseCode !in 200..299) {
					null
				} else {
					connection.inputStream.use { stream ->
						BitmapFactory.decodeStream(stream)
					}
				}
			} catch (_: Exception) {
				null
			} finally {
				connection.disconnect()
			}
		}

	fun apiBaseFromControllerUrl(controllerUrl: String): String? {
		return try {
			val uri = android.net.Uri.parse(controllerUrl)
			val host = uri.host ?: return null
			val port = uri.port.takeIf { it > 0 } ?: 3131
			val scheme = uri.scheme ?: "http"
			"$scheme://$host:$port/api/youtube-dj"
		} catch (_: Exception) {
			null
		}
	}

	private fun parseNowPlaying(json: JSONObject): DjNowPlaying? {
		val videoId = json.optString("videoId", "")
		if (videoId.isBlank() && json.optString("title", "").isBlank()) {
			return null
		}
		return DjNowPlaying(
			title = json.optString("title", ""),
			videoId = videoId,
			thumbnailUrl = json.optString("thumbnail", ""),
			currentTimeSec = json.optDouble("currentTime", 0.0),
			durationSec = json.optDouble("duration", 0.0),
			state = json.optInt("state", 3),
		)
	}

	private fun enrichFromQueue(
		apiBase: String,
		base: DjNowPlaying,
	): DjNowPlaying {
		if (base.title.isNotBlank() && base.durationSec > 0 && base.thumbnailUrl.isNotBlank()) {
			return base
		}
		val queueJson = getJson("$apiBase/queue") ?: return base
		val idx = queueJson.optInt("currentIndex", -1)
		val queue = queueJson.optJSONArray("queue") ?: return base
		val item =
			if (idx in 0 until queue.length()) {
				queue.getJSONObject(idx)
			} else {
				null
			}
		val videoId =
			base.videoId.ifBlank {
				item?.optString("videoId").orEmpty()
			}
		val title =
			base.title.ifBlank {
				queueJson.optString("currentTitle", "")
					.ifBlank { item?.optString("title").orEmpty() }
			}
		val thumbnail =
			base.thumbnailUrl.ifBlank {
				queueJson.optString("currentThumbnail", "")
					.ifBlank { item?.optString("thumbnail").orEmpty() }
					.ifBlank {
						if (videoId.isNotBlank()) {
							"https://i.ytimg.com/vi/$videoId/hqdefault.jpg"
						} else {
							""
						}
					}
			}
		val duration =
			if (base.durationSec > 0) {
				base.durationSec
			} else {
				queueJson.optDouble("duration", 0.0).takeIf { it > 0 }
					?: item?.optInt("durationSec", 0)?.toDouble()?.takeIf { it > 0 }
					?: 0.0
			}
		val state =
			if (base.state == 1 || base.state == 2) {
				base.state
			} else if (queueJson.optBoolean("isPlaying", false)) {
				1
			} else {
				2
			}
		if (state != base.state) {
			// #region agent log
			android.util.Log.i(
				"KarolCtrlDbg",
				org.json.JSONObject()
					.put("sessionId", "25b906")
					.put("hypothesisId", "H3")
					.put("location", "DjApiClient.enrichFromQueue")
					.put("message", "state-override")
					.put(
						"data",
						org.json.JSONObject()
							.put("baseState", base.state)
							.put("resolvedState", state)
							.put("queuePlaying", queueJson.optBoolean("isPlaying", false)),
					)
					.put("timestamp", System.currentTimeMillis())
					.toString(),
			)
			// #endregion
		}
		return base.copy(
			title = title,
			videoId = videoId,
			thumbnailUrl = thumbnail,
			durationSec = duration,
			state = state,
		)
	}

	private suspend fun transportPost(
		apiBase: String,
		url: String,
	): TransportResult =
		withContext(Dispatchers.IO) {
			val connection = open(url, "POST")
			try {
				connection.doOutput = true
				connection.outputStream.use { it.write("{}".toByteArray()) }
				if (connection.responseCode !in 200..299) {
					return@withContext TransportResult(ok = false, nowPlaying = null)
				}
				val body = connection.inputStream.bufferedReader().use { it.readText() }
				val json = JSONObject(body)
				val nowPlaying =
					json.optJSONObject("nowPlaying")
						?.let { parseNowPlaying(it) }
						?.let { enrichFromQueue(apiBase, it) }
				TransportResult(ok = json.optBoolean("ok", true), nowPlaying = nowPlaying)
			} catch (_: Exception) {
				TransportResult(ok = false, nowPlaying = null)
			} finally {
				connection.disconnect()
			}
		}

	private fun getJson(url: String): JSONObject? {
		val connection = open(url, "GET")
		return try {
			if (connection.responseCode !in 200..299) {
				null
			} else {
				val body = connection.inputStream.bufferedReader().use { it.readText() }
				JSONObject(body)
			}
		} catch (_: Exception) {
			null
		} finally {
			connection.disconnect()
		}
	}

	private fun open(
		url: String,
		method: String,
	): HttpURLConnection =
		(URL(url).openConnection() as HttpURLConnection).apply {
			requestMethod = method
			connectTimeout = TIMEOUT_MS
			readTimeout = TIMEOUT_MS
			setRequestProperty("Content-Type", "application/json")
			setRequestProperty("X-Karol-Client", CLIENT_HEADER)
		}
}
