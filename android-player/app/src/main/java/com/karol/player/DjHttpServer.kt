package com.karol.player

import android.content.Context
import android.util.Log
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.CacheControl
import io.ktor.server.application.call
import io.ktor.server.engine.ApplicationEngine
import io.ktor.server.engine.embeddedServer
import io.ktor.server.cio.CIO
import io.ktor.server.request.receiveText
import io.ktor.server.request.httpMethod
import io.ktor.server.request.uri
import io.ktor.server.request.queryString
import io.ktor.server.response.header
import io.ktor.server.response.respondBytes
import io.ktor.server.response.respondText
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.put
import io.ktor.server.routing.route
import io.ktor.server.routing.routing
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Local player controller — delegates to ExoPlayer via the activity.
 */
interface LocalPlayerController {
	fun play(): Boolean
	fun pause(): Boolean
	fun seek(seconds: Double): Boolean
	fun setVolume(level: Double): Boolean
	fun skipNext(): Boolean
	fun skipPrev(): Boolean
	fun needsVideoLoad(videoId: String): Boolean
	fun loadVideo(videoId: String)
	fun getCurrentTime(): Double
	fun getDuration(): Double
	fun isPlaying(): Boolean
	fun listCaptions(): JSONArray
	fun setCaption(index: Int)
	fun setCaptionOff()
	fun loadLyrics(json: String)
	fun clearLyrics()
}

class DjHttpServer(
	private val context: Context,
	private val hostIpProvider: () -> String,
	private val queueEngine: QueueEngine,
	private val localPlayer: LocalPlayerController,
	private val preferences: PlayerPreferences,
	private val playlistSync: PlaylistSyncManager,
	private val dataClient: YouTubeDataClient,
	private val statusProvider: () -> HostStatus = {
		HostStatus(false, 0, "", null, null)
	},
) {
	private val macProxyTarget: String
		get() = preferences.getMacProxyBaseUrl()
	private var engine: ApplicationEngine? = null

	@Volatile
	var volumeLevel: Double = 1.0

	var onPlaybackRequested: (() -> Unit)? = null

	var onTransportAdvance: (() -> Unit)? = null

	private fun notifyTransportAdvance() {
		onTransportAdvance?.invoke()
		localPlayer.setVolume(volumeLevel)
	}

	fun start(port: Int = SERVER_PORT) {
		if (engine != null) {
			return
		}
		volumeLevel = preferences.getVolumeLevel()
		engine =
			embeddedServer(CIO, port = port) {
				routing {
					get("/api/discover.json") {
						call.respondJson(discoverJson())
					}
					get("/api/health.json") {
						call.respondJson(
							JSONObject()
								.put("ready", true)
								.put("hostMode", "direct"),
						)
					}
					get("/api/youtube-dj/health") {
						call.respondJson(statusJson())
					}
					get("/api/youtube-dj/status") {
						call.respondJson(statusJson())
					}
					get("/api/youtube-karaoke/health") {
						call.respondJson(JSONObject().put("ok", true))
					}
					get("/api/youtube-dj/now-playing") {
						try {
							call.respondJson(nowPlayingJson())
						} catch (e: Exception) {
							Log.e("DjHttpServer", "nowPlayingJson error", e)
							call.respondJson(
								JSONObject()
									.put("title", "Unknown")
									.put("videoId", "")
									.put("thumbnail", "")
									.put("currentTime", 0.0)
									.put("duration", 0.0)
									.put("volumeLevel", 1.0)
									.put("state", 0),
							)
						}
					}
					get("/api/youtube-dj/queue") {
						call.respondJson(queueEngine.getKaraokeStateJson())
					}
					get("/api/youtube-dj/queue-window") {
						call.respondJson(JSONObject().put("ok", true).put("open", false))
					}
					post("/api/youtube-dj/queue-window/open") {
						call.respondJson(JSONObject().put("ok", true).put("open", false))
					}
					get("/api/youtube-dj/playlist") {
						call.respondJson(
							JSONObject()
								.put("ok", true)
								.put(
									"config",
									preferences.getPlaylistConfig(playlistSync.lastAddedCount).toJson(),
								),
						)
					}
					post("/api/youtube-dj/queue") {
						call.handleQueuePost(call.receiveText())
					}
					post("/api/youtube-karaoke/queue") {
						call.handleQueuePost(call.receiveText())
					}
					post("/api/youtube-dj/play-now") {
						call.handleQueuePost(call.receiveText(), forcePlayNow = true)
					}
					post("/api/youtube-dj/queue/clear") {
						queueEngine.clearQueue()
						call.respondJson(
							JSONObject()
								.put("ok", true)
								.put("state", queueEngine.getKaraokeStateJson()),
						)
					}
					post("/api/youtube-dj/queue/reorder") {
						val body = JSONObject(call.receiveText())
						queueEngine.reorderQueue(
							body.optInt("fromIndex", -1),
							body.optInt("toIndex", -1),
						)
						call.respondJson(
							JSONObject()
								.put("ok", true)
								.put("state", queueEngine.getKaraokeStateJson()),
						)
					}
					post("/api/youtube-dj/queue/sort") {
						val body = JSONObject(call.receiveText())
						playlistSync.enrichQueueMetadataForSort()
						val ok = queueEngine.sortQueue(body.optString("mode", ""))
						call.respondJson(
							JSONObject()
								.put("ok", ok)
								.put("state", queueEngine.getKaraokeStateJson()),
						)
					}
					post("/api/youtube-dj/queue/shuffle-upcoming") {
						val ok = queueEngine.shuffleUpcoming()
						call.respondJson(
							JSONObject()
								.put("ok", ok)
								.put("state", queueEngine.getKaraokeStateJson()),
						)
					}
					patch("/api/youtube-dj/shuffle") {
						val body = JSONObject(call.receiveText())
						queueEngine.setShuffleEnabled(body.optBoolean("enabled", false))
						call.respondJson(
							JSONObject()
								.put("ok", true)
								.put("state", queueEngine.getKaraokeStateJson()),
						)
					}
					post("/api/youtube-dj/queue/{id}/play") {
						val id = call.parameters["id"] ?: ""
						onPlaybackRequested?.invoke()
						val videoId = queueEngine.playNow(id, "play-now-api")
						if (videoId == null) {
							call.respondText(
								JSONObject().put("ok", false).put("error", "not found").toString(),
								ContentType.Application.Json,
								HttpStatusCode.NotFound,
							)
						} else {
							call.respondJson(
								JSONObject()
									.put("ok", true)
									.put("state", queueEngine.getKaraokeStateJson()),
							)
						}
					}
					delete("/api/youtube-dj/queue/{id}") {
						val id = call.parameters["id"] ?: ""
						queueEngine.removeFromQueue(id)
						call.respondJson(
							JSONObject()
								.put("ok", true)
								.put("state", queueEngine.getKaraokeStateJson()),
						)
					}
					post("/api/youtube-dj/playlist") {
						val body = JSONObject(call.receiveText())
						try {
							val config =
								playlistSync.setPlaylistMode(
									enabled = body.optBoolean("enabled", true),
									playlistUrlOrId = body.optString("playlistUrl").ifBlank { null },
								)
							call.respondJson(
								JSONObject()
									.put("ok", true)
									.put("config", config.toJson()),
							)
						} catch (error: Exception) {
							call.respondText(
								JSONObject()
									.put("ok", false)
									.put("error", error.message ?: "playlist error")
									.toString(),
								ContentType.Application.Json,
								HttpStatusCode.BadRequest,
							)
						}
					}
					patch("/api/youtube-dj/playlist") {
						val body = JSONObject(call.receiveText())
						try {
							val config =
								if (body.has("enabled") && !body.optBoolean("enabled")) {
									playlistSync.setPlaylistMode(false, null)
								} else {
									playlistSync.setPlaylistMode(
										enabled = true,
										playlistUrlOrId = body.optString("playlistUrl").ifBlank { null },
									)
								}
							call.respondJson(
								JSONObject()
									.put("ok", true)
									.put("config", config.toJson()),
							)
						} catch (error: Exception) {
							call.respondText(
								JSONObject()
									.put("ok", false)
									.put("error", error.message ?: "playlist error")
									.toString(),
								ContentType.Application.Json,
								HttpStatusCode.BadRequest,
							)
						}
					}
					post("/api/youtube-dj/playlists") {
						val body = JSONObject(call.receiveText())
						try {
							val playlistUrl = body.optString("playlistUrl").trim()
							if (playlistUrl.isBlank()) {
								call.respondText(
									JSONObject().put("error", "playlistUrl is required").toString(),
									ContentType.Application.Json,
									HttpStatusCode.BadRequest,
								)
								return@post
							}
							val entry = playlistSync.addPlaylist(playlistUrl)
							call.respondJson(
								JSONObject()
									.put("ok", true)
									.put("playlist", entry.toJson())
									.put(
										"config",
										preferences.getPlaylistConfig(playlistSync.lastAddedCount).toJson(),
									),
							)
						} catch (error: Exception) {
							call.respondText(
								JSONObject()
									.put("ok", false)
									.put("error", error.message ?: "add playlist failed")
									.toString(),
								ContentType.Application.Json,
								HttpStatusCode.BadRequest,
							)
						}
					}
					delete("/api/youtube-dj/playlists/{id}") {
						val id = call.parameters["id"] ?: ""
						try {
							val config = playlistSync.removePlaylist(id)
							call.respondJson(
								JSONObject()
									.put("ok", true)
									.put("config", config.toJson()),
							)
						} catch (error: Exception) {
							call.respondText(
								JSONObject()
									.put("ok", false)
									.put("error", error.message ?: "remove playlist failed")
									.toString(),
								ContentType.Application.Json,
								HttpStatusCode.BadRequest,
							)
						}
					}
					post("/api/youtube-dj/playlists/{id}/activate") {
						val id = call.parameters["id"] ?: ""
						val body =
							try {
								JSONObject(call.receiveText())
							} catch (_: Exception) {
								JSONObject()
							}
						try {
							onPlaybackRequested?.invoke()
							val config =
								playlistSync.activatePlaylist(
									playlistId = id,
									playFirst = body.optBoolean("playFirst", false),
								)
							call.respondJson(
								JSONObject()
									.put("ok", true)
									.put("config", config.toJson())
									.put("state", queueEngine.getKaraokeStateJson()),
							)
						} catch (error: Exception) {
							call.respondText(
								JSONObject()
									.put("ok", false)
									.put("error", error.message ?: "activate playlist failed")
									.toString(),
								ContentType.Application.Json,
								HttpStatusCode.BadRequest,
							)
						}
					}
					post("/api/youtube-dj/playlists/{id}/sync") {
						val id = call.parameters["id"] ?: ""
						val result = playlistSync.runSyncForPlaylist(id)
						call.respondJson(
							JSONObject()
								.put("ok", true)
								.put("result", result)
								.put(
									"config",
									preferences.getPlaylistConfig(playlistSync.lastAddedCount).toJson(),
								),
						)
					}
					post("/api/youtube-dj/sync") {
						val result = playlistSync.runSync()
						call.respondJson(
							JSONObject()
								.put("ok", true)
								.put("result", result)
								.put(
									"config",
									preferences.getPlaylistConfig(playlistSync.lastAddedCount).toJson(),
								),
						)
					}
					post("/api/youtube-dj/import-playlist") {
						val body = JSONObject(call.receiveText())
						val playlistUrl = body.optString("playlistUrl")
						val replace = !body.has("replace") || body.optBoolean("replace", true)
						if (replace) {
							queueEngine.clearQueue()
						}
						val (_, videos) = dataClient.fetchPlaylistVideos(playlistUrl)
						queueEngine.addNewVideos(videos, "manual")
						if (body.optBoolean("playFirst") && videos.isNotEmpty()) {
							onPlaybackRequested?.invoke()
							val first =
								queueEngine.getQueueSnapshot().queue.lastOrNull {
									it.videoId == videos.first().videoId
								}
							if (first != null) {
								queueEngine.playNow(first.id, "import-play-first")
							}
						}
						call.respondJson(
							JSONObject()
								.put("ok", true)
								.put("count", videos.size)
								.put("state", queueEngine.getKaraokeStateJson()),
						)
					}
					post("/api/youtube-dj/search") {
						val body = JSONObject(call.receiveText())
						val results = dataClient.searchVideos(body.optString("query"))
						call.respondJson(
							JSONObject()
								.put("ok", true)
								.put("results", JSONArray(results.map { it.toJson() })),
						)
					}
					// ── Transport endpoints ──
					post("/api/youtube-dj/transport/play") {
						onPlaybackRequested?.invoke()
						notifyTransportAdvance()
						queueEngine.setTransportPlaying(true)
						val currentId = queueEngine.getCurrentVideoId()
						if (currentId != null && localPlayer.needsVideoLoad(currentId)) {
							localPlayer.loadVideo(currentId)
						} else {
							localPlayer.play()
						}
						call.respondJson(
							JSONObject()
								.put("ok", true)
								.put("nowPlaying", nowPlayingJson()),
						)
					}
					post("/api/youtube-dj/transport/pause") {
						queueEngine.setTransportPlaying(false)
						localPlayer.pause()
						call.respondJson(
							JSONObject()
								.put("ok", true)
								.put("nowPlaying", nowPlayingJson()),
						)
					}
					post("/api/youtube-dj/transport/seek") {
						val body = JSONObject(call.receiveText())
						val seconds = body.optDouble("seconds", 0.0)
						val clamped = maxOf(0.0, seconds)
						localPlayer.seek(clamped)
						queueEngine.setPlaybackProgress(clamped, queueEngine.duration)
						call.respondJson(
							JSONObject()
								.put("ok", true)
								.put("nowPlaying", nowPlayingJson()),
						)
					}
					post("/api/youtube-dj/transport/seek-relative") {
						val body = JSONObject(call.receiveText())
						val base = queueEngine.currentTime.takeIf { it > 0 } ?: 0.0
						val target = maxOf(0.0, base + body.optDouble("delta", 0.0))
						localPlayer.seek(target)
						queueEngine.setPlaybackProgress(target, queueEngine.duration)
						call.respondJson(
							JSONObject()
								.put("ok", true)
								.put("nowPlaying", nowPlayingJson()),
						)
					}
					post("/api/youtube-dj/transport/volume") {
						val body = JSONObject(call.receiveText())
						volumeLevel = body.optDouble("level", 1.0).coerceIn(0.0, 1.0)
						preferences.setVolumeLevel(volumeLevel)
						localPlayer.setVolume(volumeLevel)
						call.respondJson(JSONObject().put("ok", true))
					}
					post("/api/youtube-dj/transport/skip-next") {
						notifyTransportAdvance()
						queueEngine.skipNext("user-skip-api")
						call.respondJson(
							JSONObject()
								.put("ok", true)
								.put("state", queueEngine.getKaraokeStateJson())
								.put("nowPlaying", nowPlayingJson()),
						)
					}
					post("/api/youtube-dj/transport/skip-prev") {
						notifyTransportAdvance()
						queueEngine.skipPrev("user-skip-api")
						call.respondJson(
							JSONObject()
								.put("ok", true)
								.put("state", queueEngine.getKaraokeStateJson())
								.put("nowPlaying", nowPlayingJson()),
						)
					}
					post("/api/youtube-dj/mode") {
						val body = JSONObject(call.receiveText())
						val mode = body.optString("mode")
						if (mode !in listOf("queue", "hotswap", "manual")) {
							call.respondText(
								JSONObject().put("error", "invalid mode").toString(),
								ContentType.Application.Json,
								HttpStatusCode.BadRequest,
							)
							return@post
						}
						queueEngine.setMode(mode)
						call.respondJson(
							JSONObject()
								.put("ok", true)
								.put("state", queueEngine.getKaraokeStateJson()),
						)
					}
					patch("/api/youtube-dj/settings") {
						val body = JSONObject(call.receiveText())
						if (body.has("youtubeApiKey")) {
							preferences.setYouTubeApiKey(body.optString("youtubeApiKey"))
						}
						if (body.has("macHostIp")) {
							val ip = body.optString("macHostIp").trim()
							if (ip.isNotBlank()) {
								preferences.setMacHostIp(ip)
							}
						}
						call.respondJson(
							JSONObject()
								.put("ok", true)
								.put("macHostIp", preferences.getMacHostIp()),
						)
					}
					// ── Caption / subtitle endpoints ──
					get("/api/youtube-dj/captions/list") {
						val captionsJson = localPlayer.listCaptions()
						call.respondJson(
							JSONObject()
								.put("ok", true)
								.put("captions", captionsJson),
						)
					}
					post("/api/youtube-dj/captions/set") {
						val body = JSONObject(call.receiveText())
						val index = body.optInt("index", -1)
						if (index < 0) {
							call.respondText(
								JSONObject().put("error", "index is required").toString(),
								ContentType.Application.Json,
								HttpStatusCode.BadRequest,
							)
							return@post
						}
						localPlayer.setCaption(index)
						call.respondJson(JSONObject().put("ok", true))
					}
					post("/api/youtube-dj/captions/off") {
						localPlayer.setCaptionOff()
						call.respondJson(JSONObject().put("ok", true))
				}
				// ── Karaoke lyric overlay ──
				post("/api/youtube-dj/lyrics/load") {
					try {
						val body = JSONObject(call.receiveText())
						localPlayer.loadLyrics(body.toString())
						call.respondJson(JSONObject().put("ok", true))
					} catch (e: Exception) {
						call.respondJson(
							JSONObject()
								.put("ok", false)
								.put("error", e.message ?: "invalid json")
						)
					}
				}
				post("/api/youtube-dj/lyrics/clear") {
					localPlayer.clearLyrics()
					call.respondJson(JSONObject().put("ok", true))
				}
				// YouTube audio preview proxy – forward to Mac where yt-dlp is available
					get("/api/youtube-dj/audio-stream") {
						val targetUrl = "$macProxyTarget/api/youtube-dj/audio-stream?${call.request.queryString()}"
						proxyJsonToHost(call, targetUrl)
					}
				}
			}
		engine?.start(wait = false)
		Log.i(TAG, "DJ HTTP server started on port $port")
	}

	fun stop() {
		engine?.stop(1000, 2000)
		engine = null
	}

	private suspend fun io.ktor.server.application.ApplicationCall.handleQueuePost(
		bodyText: String,
		forcePlayNow: Boolean = false,
	) {
		val body = JSONObject(bodyText)
		val url = body.optString("url")
		if (url.isBlank()) {
			respondText(
				JSONObject().put("error", "url is required").toString(),
				ContentType.Application.Json,
				HttpStatusCode.BadRequest,
			)
			return
		}
		val action = if (forcePlayNow) "play-now" else body.optString("action", "queue")
		val requester = body.optString("requester").ifBlank { null }
		val songTitle = body.optString("title").ifBlank { null }
		val videoId = queueEngine.addFromUrl(url, action, requester, songTitle)
		if (videoId == null) {
			respondText(
				JSONObject().put("ok", false).put("error", "invalid url").toString(),
				ContentType.Application.Json,
				HttpStatusCode.BadRequest,
			)
			return
		}
		respondJson(
			JSONObject()
				.put("ok", true)
				.put("videoId", videoId)
				.put("action", action),
		)
	}

	private fun discoverJson(): JSONObject {
		val ip = hostIpProvider()
		val base = "http://$ip:$SERVER_PORT"
		return JSONObject()
			.put("name", "Karol Player")
			.put("role", "dj-player")
			.put("ready", true)
			.put("host", ip)
			.put("port", SERVER_PORT)
			.put("shareUrl", JSONObject.NULL)
			.put("youtubeDjHealthUrl", "$base/api/youtube-dj/health")
	}

	private fun statusJson(): JSONObject {
		val ip = hostIpProvider()
		val host = statusProvider()
		return JSONObject()
			.put("ok", true)
			.put("djActive", queueEngine.isPlaying || queueEngine.queue.isNotEmpty())
			.put("castConnected", false)
			.put("captureReady", host.showActive)
			.put("showActive", host.showActive)
			.put("queueLength", host.queueLength)
			.put("currentTitle", host.currentTitle)
			.put("interstitialMessage", host.interstitialMessage ?: JSONObject.NULL)
			.put("lastPlaybackError", host.lastPlaybackError ?: JSONObject.NULL)
			.put("lastAdvanceReason", queueEngine.lastAdvanceReason.ifBlank { JSONObject.NULL })
			.put("volumeLevel", volumeLevel)
			.put("port", SERVER_PORT)
			.put("hostMode", "direct")
			.put("host", ip)
	}

	private fun nowPlayingJson(): JSONObject {
		val queueItem =
			queueEngine.queue.getOrNull(queueEngine.currentIndex)
		val prevItem = queueEngine.queue.getOrNull(queueEngine.currentIndex - 1)
		val nextItem = queueEngine.queue.getOrNull(queueEngine.currentIndex + 1)
		val videoId =
			queueEngine.getCurrentVideoId().orEmpty()
		val title =
			queueEngine.currentTitle.takeIf { it.isNotBlank() }
				?: queueItem?.title.orEmpty()
		val thumbnail =
			queueEngine.currentThumbnail.takeIf { it.isNotBlank() }
				?: queueItem?.thumbnail.orEmpty()
				.ifBlank {
					if (videoId.isNotBlank()) {
						"https://i.ytimg.com/vi/$videoId/maxresdefault.jpg"
					} else {
						""
					}
				}
		val duration =
			queueEngine.duration.takeIf { it > 0 }
				?: queueItem?.durationSec?.toDouble()?.takeIf { it > 0 }
				?: 0.0
		val state =
			if (!queueEngine.isPlaying) {
				2
			} else {
				1
			}
		val currentTime =
			queueEngine.currentTime.takeIf { it > 0 } ?: 0.0
		val previousThumbnail = prevItem?.thumbnail.orEmpty()
		val nextThumbnail = nextItem?.thumbnail.orEmpty()
		return JSONObject()
			.put("title", title)
			.put("videoId", videoId)
			.put("thumbnail", thumbnail)
			.put("previousThumbnail", previousThumbnail)
			.put("nextThumbnail", nextThumbnail)
			.put("currentTime", currentTime)
			.put("duration", duration)
			.put("volumeLevel", volumeLevel)
			.put("state", state)
	}

	private suspend fun proxyJsonToHost(
		call: io.ktor.server.application.ApplicationCall,
		targetUrl: String,
	) {
		try {
			val conn = (URL(targetUrl).openConnection() as HttpURLConnection).apply {
				requestMethod = "GET"
				connectTimeout = 15_000
				readTimeout = 15_000
			}
			val status = conn.responseCode
			val bodyStream: InputStream = try {
				conn.inputStream
			} catch (_: IOException) {
				conn.errorStream ?: ByteArray(0).inputStream()
			}
			val body = bodyStream.bufferedReader().use { it.readText() }
			conn.disconnect()
			call.response.header(HttpHeaders.AccessControlAllowOrigin, "*")
			call.response.header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
			call.respondText(body, ContentType.Application.Json, HttpStatusCode.fromValue(status))
		} catch (e: IOException) {
			call.response.header(HttpHeaders.AccessControlAllowOrigin, "*")
			call.respondJson(
				JSONObject()
					.put("ok", false)
					.put("error", "Media host unreachable – is Deskreen running on your Mac?"),
			)
		}
	}

	private suspend fun proxyToMacHost(
		call: io.ktor.server.application.ApplicationCall,
		targetBase: String,
		prefix: String,
	) {
		try {
			val path = call.request.uri.removePrefix(prefix)
			val url = URL("$targetBase$prefix$path")
			val conn = (url.openConnection() as HttpURLConnection).apply {
				requestMethod = call.request.httpMethod.value
				connectTimeout = 5000
				readTimeout = if (path.startsWith("/audio")) 120_000 else 8000
				if (call.request.httpMethod.value in listOf("POST", "PUT", "PATCH")) {
					doOutput = true
					setRequestProperty("Content-Type", "application/json")
					val body = call.receiveText()
					outputStream.use { os: OutputStream -> os.write(body.toByteArray()) }
				}
			}
			val status = conn.responseCode
			val upstreamContentType = conn.contentType ?: "application/json"

			val isBinary = upstreamContentType.startsWith("audio/")
				|| upstreamContentType.startsWith("image/")
				|| upstreamContentType.startsWith("video/")

			call.response.header(HttpHeaders.AccessControlAllowOrigin, "*")

			if (isBinary) {
				val bodyStream: InputStream = try {
					conn.inputStream
				} catch (_: IOException) {
					conn.errorStream ?: ByteArray(0).inputStream()
				}
				val bodyBytes = bodyStream.readBytes()
				conn.disconnect()
				val ct = ContentType.parse(upstreamContentType)
				call.response.header(HttpHeaders.ContentType, ct.toString())
				call.respondBytes(bodyBytes, ct, HttpStatusCode.fromValue(status))
			} else {
				val bodyStream: InputStream = try {
					conn.inputStream
				} catch (_: IOException) {
					conn.errorStream ?: ByteArray(0).inputStream()
				}
				val body = bodyStream.bufferedReader().use { it.readText() }
				conn.disconnect()
				call.response.header(HttpHeaders.ContentType, ContentType.Application.Json.toString())
				call.respondText(body, ContentType.Application.Json, HttpStatusCode.fromValue(status))
			}
		} catch (e: IOException) {
			call.response.header(HttpHeaders.AccessControlAllowOrigin, "*")
			call.respondJson(
				JSONObject()
					.put("ok", false)
					.put("error", "Host unreachable – is Deskreen running on your Mac?")
					.put("proxyTarget", targetBase)
					.put("prefix", prefix),
			)
		}
	}

	private suspend fun io.ktor.server.application.ApplicationCall.respondJson(json: JSONObject) {
		response.header(HttpHeaders.AccessControlAllowOrigin, "*")
		response.header(HttpHeaders.AccessControlAllowMethods, "GET,POST,PATCH,DELETE,OPTIONS")
		response.header(HttpHeaders.AccessControlAllowHeaders, "Content-Type")
		respondText(json.toString(), ContentType.Application.Json)
	}

	private suspend fun io.ktor.server.application.ApplicationCall.serveAsset(
		assetPath: String,
		contentType: String,
	) {
		response.header(HttpHeaders.AccessControlAllowOrigin, "*")
		val isHashedAsset = assetPath.endsWith(".js") || assetPath.endsWith(".css")
		if (isHashedAsset && assetPath.matches(Regex(".*/[a-zA-Z0-9_-]{8,}\\.(js|css)$"))) {
			response.header(HttpHeaders.CacheControl, "public, max-age=31536000, immutable")
		} else if (assetPath.endsWith(".html")) {
			response.header(HttpHeaders.CacheControl, "no-cache, no-store, must-revalidate")
		}
		try {
			val bytes = context.assets.open(assetPath).use { it.readBytes() }
			respondBytes(bytes, ContentType.parse(contentType))
		} catch (_: IOException) {
			if (assetPath.endsWith(".html") || assetPath.endsWith("/")) {
				respondText(
					"<html><body><h1>Karol Player</h1><p>Run: npm run sync:dj-controller-player</p></body></html>",
					ContentType.Text.Html,
					HttpStatusCode.OK,
				)
			} else {
				respondText("not found", ContentType.Text.Plain, HttpStatusCode.NotFound)
			}
		}
	}

	private fun contentTypeFor(path: String): String =
		when {
			path.endsWith(".js") -> "application/javascript"
			path.endsWith(".css") -> "text/css"
			path.endsWith(".svg") -> "image/svg+xml"
			path.endsWith(".png") -> "image/png"
			path.endsWith(".json") -> "application/json"
			path.endsWith(".html") -> "text/html"
			else -> "application/octet-stream"
		}

	companion object {
		private const val TAG = "DjHttpServer"
		const val SERVER_PORT = 3131
	}
}
