package com.deskreen.player

import android.content.Context
import android.net.Uri
import android.util.Log
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.engine.ApplicationEngine
import io.ktor.server.engine.embeddedServer
import io.ktor.server.cio.CIO
import io.ktor.server.request.receiveText
import io.ktor.server.response.header
import io.ktor.server.response.respondBytes
import io.ktor.server.response.respondText
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException

class DjHttpServer(
	private val context: Context,
	private val hostIpProvider: () -> String,
	private val queueEngine: QueueEngine,
	private val youtubeBridge: YouTubePlayerController,
	private val preferences: PlayerPreferences,
	private val playlistSync: PlaylistSyncManager,
	private val dataClient: YouTubeDataClient,
) {
	private var engine: ApplicationEngine? = null

	@Volatile
	var latestSnapshot: PlayerSnapshot? = null

	var volumeLevel: Double = 1.0

	fun start(port: Int = SERVER_PORT) {
		if (engine != null) {
			return
		}
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
						call.respondJson(nowPlayingJson())
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
					post("/api/youtube-dj/queue/{id}/play") {
						val id = call.parameters["id"] ?: ""
						val videoId = queueEngine.playNow(id)
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
					}
					patch("/api/youtube-dj/playlist") {
						val body = JSONObject(call.receiveText())
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
							val first =
								queueEngine.getQueueSnapshot().queue.lastOrNull {
									it.videoId == videos.first().videoId
								}
							if (first != null) {
								queueEngine.playNow(first.id)
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
					post("/api/youtube-dj/transport/play") {
						if (latestSnapshot?.videoId.isNullOrBlank()) {
							queueEngine.getCurrentVideoId()?.let { youtubeBridge.loadVideo(it) }
						}
						youtubeBridge.play()
						call.respondJson(JSONObject().put("ok", true))
					}
					post("/api/youtube-dj/transport/pause") {
						youtubeBridge.pause()
						call.respondJson(JSONObject().put("ok", true))
					}
					post("/api/youtube-dj/transport/seek") {
						val body = JSONObject(call.receiveText())
						youtubeBridge.seek(body.optDouble("seconds", 0.0))
						call.respondJson(JSONObject().put("ok", true))
					}
					post("/api/youtube-dj/transport/seek-relative") {
						val body = JSONObject(call.receiveText())
						val base = latestSnapshot?.currentTime ?: 0.0
						youtubeBridge.seek(maxOf(0.0, base + body.optDouble("delta", 0.0)))
						call.respondJson(JSONObject().put("ok", true))
					}
					post("/api/youtube-dj/transport/volume") {
						val body = JSONObject(call.receiveText())
						volumeLevel = body.optDouble("level", 1.0).coerceIn(0.0, 1.0)
						youtubeBridge.setVolume(volumeLevel)
						call.respondJson(JSONObject().put("ok", true))
					}
					post("/api/youtube-dj/transport/skip-next") {
						queueEngine.skipNext()
						call.respondJson(
							JSONObject()
								.put("ok", true)
								.put("state", queueEngine.getKaraokeStateJson()),
						)
					}
					post("/api/youtube-dj/transport/skip-prev") {
						queueEngine.skipPrev()
						call.respondJson(
							JSONObject()
								.put("ok", true)
								.put("state", queueEngine.getKaraokeStateJson()),
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
						call.respondJson(JSONObject().put("ok", true))
					}
					get("/dj-controller") {
						call.response.header(HttpHeaders.Location, "/dj-controller/")
						call.respondText("", status = HttpStatusCode.MovedPermanently)
					}
					get("/dj-controller/") {
						call.serveAsset("dj-controller/index.html", "text/html")
					}
					get("/dj-controller/{path...}") {
						val parts = call.parameters.getAll("path") ?: emptyList()
						val rel = parts.joinToString("/")
						call.serveAsset("dj-controller/$rel", contentTypeFor(rel))
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
		val videoId = queueEngine.addFromUrl(url, action)
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
			.put("name", "Deskreen Player")
			.put("role", "dj-player")
			.put("ready", true)
			.put("host", ip)
			.put("port", SERVER_PORT)
			.put("shareUrl", JSONObject.NULL)
			.put("djControllerUrl", "$base/dj-controller/")
			.put("youtubeDjHealthUrl", "$base/api/youtube-dj/health")
	}

	private fun statusJson(): JSONObject {
		val ip = hostIpProvider()
		return JSONObject()
			.put("ok", true)
			.put("djActive", queueEngine.isPlaying || queueEngine.queue.isNotEmpty())
			.put("castConnected", false)
			.put("captureReady", youtubeBridge.isReady)
			.put("port", SERVER_PORT)
			.put("hostMode", "direct")
			.put("host", ip)
	}

	private fun nowPlayingJson(): JSONObject {
		val snap = latestSnapshot
		return JSONObject()
			.put("title", snap?.title ?: queueEngine.currentTitle)
			.put("videoId", snap?.videoId ?: queueEngine.getCurrentVideoId().orEmpty())
			.put("currentTime", snap?.currentTime ?: queueEngine.currentTime)
			.put("duration", snap?.duration ?: queueEngine.duration)
			.put("state", snap?.state ?: if (queueEngine.isPlaying) 1 else 2)
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
		try {
			val bytes = context.assets.open(assetPath).use { it.readBytes() }
			respondBytes(bytes, ContentType.parse(contentType))
		} catch (_: IOException) {
			if (assetPath.endsWith(".html") || assetPath.endsWith("/")) {
				respondText(
					"<html><body><h1>Deskreen Player</h1><p>Run: npm run sync:dj-controller-player</p></body></html>",
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
