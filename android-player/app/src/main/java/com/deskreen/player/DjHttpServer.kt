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
import io.ktor.server.routing.put
import io.ktor.server.routing.routing
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import com.deskreen.player.BuildConfig

class DjHttpServer(
	private val context: Context,
	private val hostIpProvider: () -> String,
	private val queueEngine: QueueEngine,
	private val youtubeBridge: YouTubePlayerController,
	private val preferences: PlayerPreferences,
	private val playlistSync: PlaylistSyncManager,
	private val dataClient: YouTubeDataClient,
	private val statusProvider: () -> HostStatus = {
		HostStatus(false, 0, "", null, null)
	},
) {
	private var engine: ApplicationEngine? = null

	@Volatile
	var latestSnapshot: PlayerSnapshot? = null

	@Volatile
	private var playbackClockBaseSec = 0.0

	@Volatile
	private var playbackClockMarkedAtMs = 0L

	@Volatile
	private var playbackClockVideoId = ""

	@Volatile
	private var seekSettleUntilMs = 0L

	fun isSeekSettling(): Boolean = System.currentTimeMillis() < seekSettleUntilMs

	fun reconcileSnapshotProgress(snapshot: PlayerSnapshot): PlayerSnapshot {
		if (!snapshot.hasVideo || !isSeekSettling()) {
			return snapshot
		}
		val queueTime = queueEngine.currentTime
		if (queueTime <= 0.0 || kotlin.math.abs(snapshot.currentTime - queueTime) <= 2.5) {
			return snapshot
		}
		return snapshot.copy(currentTime = queueTime)
	}

	var volumeLevel: Double = 1.0

	var onPlaybackRequested: (() -> Unit)? = null

	var onTransportAdvance: (() -> Unit)? = null

	private fun notifyTransportAdvance() {
		onTransportAdvance?.invoke()
		youtubeBridge.setVolume(volumeLevel)
	}

	fun invalidatePlaybackSnapshot() {
		latestSnapshot = null
	}

	private fun applySeek(seconds: Double) {
		val clamped = maxOf(0.0, seconds)
		val duration =
			queueEngine.duration.takeIf { it > 0 }
				?: latestSnapshot?.duration?.takeIf { it > 0 }
				?: 0.0
		val resolvedTime =
			if (duration > 0) {
				minOf(clamped, duration)
			} else {
				clamped
			}
		queueEngine.setPlaybackProgress(resolvedTime, duration)
		resetPlaybackClock(queueEngine.getCurrentVideoId().orEmpty(), resolvedTime)
		seekSettleUntilMs = System.currentTimeMillis() + 4000
		val snap = latestSnapshot
		if (snap != null) {
			val updated =
				snap.copy(
					currentTime = resolvedTime,
					duration = if (duration > 0) duration else snap.duration,
				)
			latestSnapshot = updated
			notePlaybackSample(updated)
		}
	}

	/** Track live playback for API clients when the WebView snapshot time stalls. */
	fun notePlaybackSample(snapshot: PlayerSnapshot) {
		val activeId = queueEngine.getCurrentVideoId().orEmpty()
		if (
			activeId.isNotBlank() &&
				snapshot.videoId.isNotBlank() &&
				snapshot.videoId != activeId
		) {
			return
		}
		val videoId = snapshot.videoId
		val time = snapshot.currentTime
		if (videoId != playbackClockVideoId) {
			playbackClockVideoId = videoId
			playbackClockBaseSec = maxOf(0.0, time)
			playbackClockMarkedAtMs = System.currentTimeMillis()
			return
		}
		if (snapshot.state == 1 && snapshot.hasVideo) {
			if (time > playbackClockBaseSec + 0.2) {
				playbackClockBaseSec = time
				playbackClockMarkedAtMs = System.currentTimeMillis()
			}
		} else {
			playbackClockBaseSec = time
			playbackClockMarkedAtMs = System.currentTimeMillis()
		}
	}

	fun resetPlaybackClock(
		videoId: String = "",
		timeSec: Double = 0.0,
	) {
		playbackClockVideoId = videoId
		playbackClockBaseSec = maxOf(0.0, timeSec)
		playbackClockMarkedAtMs = System.currentTimeMillis()
	}

	private fun resolveCurrentTimeForApi(
		state: Int,
		duration: Double,
	): Double {
		val activeId = queueEngine.getCurrentVideoId().orEmpty()
		val snap = latestSnapshot
		val snapMatches =
			snap != null &&
				snap.videoId.isNotBlank() &&
				(activeId.isBlank() || snap.videoId == activeId)
		val snapTime =
			if (snapMatches && snap != null && snap.hasVideo) {
				snap.currentTime
			} else {
				0.0
			}
		val direct =
			when {
				snapTime > 0.5 -> snapTime
				state != 1 -> {
					val queueTime = queueEngine.currentTime
					if (queueTime > 0) queueTime else snapTime
				}
				else -> 0.0
			}

		if (state != 1) {
			return if (duration > 0) minOf(direct, duration) else direct
		}

		val elapsedSec =
			(System.currentTimeMillis() - playbackClockMarkedAtMs).coerceAtLeast(0L) / 1000.0
		val extrapolated = playbackClockBaseSec + elapsedSec
		val merged =
			when {
				isSeekSettling() -> extrapolated
				direct > 0.5 -> {
					if (kotlin.math.abs(direct - extrapolated) > 2.0) {
						extrapolated
					} else {
						maxOf(direct, extrapolated)
					}
				}
				else -> extrapolated
			}
		return if (duration > 0) minOf(merged, duration) else merged
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
					if (BuildConfig.DEBUG) {
						get("/api/youtube-dj/dev/youtube-session") {
							call.respondJson(JSONObject(YouTubeSessionBackup.exportJson()))
						}
						put("/api/youtube-dj/dev/youtube-session") {
							val body = call.receiveText()
							val ok = YouTubeSessionBackup.importJson(body)
							val signedIn = YouTubeSessionHelper.isSignedIn()
							if (ok && signedIn) {
								YouTubeSessionHelper.markSignedIn(preferences)
								YouTubeSessionBackup.saveToDevice(this@DjHttpServer.context)
							}
							call.respondJson(
								JSONObject()
									.put("ok", ok)
									.put("signedIn", signedIn),
							)
						}
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
					post("/api/youtube-dj/transport/play") {
						onPlaybackRequested?.invoke()
						notifyTransportAdvance()
						queueEngine.setTransportPlaying(true)
						val currentId = queueEngine.getCurrentVideoId()
						val snap = latestSnapshot
						val resumeTime =
							if (snap != null && snap.videoId == currentId) {
								snap.currentTime.coerceAtLeast(0.0)
							} else {
								0.0
							}
						if (snap != null && snap.videoId != currentId) {
							invalidatePlaybackSnapshot()
						}
						resetPlaybackClock(currentId.orEmpty(), resumeTime)
						val needsLoad = currentId != null && youtubeBridge.needsVideoLoad(currentId)
						if (needsLoad) {
							youtubeBridge.loadVideo(currentId!!)
						} else {
							youtubeBridge.play()
						}
						latestSnapshot =
							latestSnapshot?.takeIf { it.videoId == currentId }?.copy(
								state = 1,
								paused = false,
							)
						call.respondJson(
							JSONObject()
								.put("ok", true)
								.put("nowPlaying", nowPlayingJson()),
						)
					}
					post("/api/youtube-dj/transport/pause") {
						latestSnapshot?.let { snap ->
							if (snap.currentTime > 0 || snap.duration > 0) {
								queueEngine.setPlaybackProgress(
									snap.currentTime,
									snap.duration.takeIf { it > 0 } ?: queueEngine.duration,
								)
							}
						}
						queueEngine.setTransportPlaying(false)
						youtubeBridge.pause()
						latestSnapshot = latestSnapshot?.copy(state = 2, paused = true)
						call.respondJson(
							JSONObject()
								.put("ok", true)
								.put("nowPlaying", nowPlayingJson()),
						)
					}
					post("/api/youtube-dj/transport/seek") {
						val body = JSONObject(call.receiveText())
						val seconds = body.optDouble("seconds", 0.0)
						youtubeBridge.seek(seconds)
						applySeek(seconds)
						call.respondJson(
							JSONObject()
								.put("ok", true)
								.put("nowPlaying", nowPlayingJson()),
						)
					}
					post("/api/youtube-dj/transport/seek-relative") {
						val body = JSONObject(call.receiveText())
						val base =
							queueEngine.currentTime.takeIf { it > 0 }
								?: latestSnapshot?.currentTime
								?: 0.0
						val target = maxOf(0.0, base + body.optDouble("delta", 0.0))
						youtubeBridge.seek(target)
						applySeek(target)
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
						youtubeBridge.setVolume(volumeLevel)
						call.respondJson(JSONObject().put("ok", true))
					}
					post("/api/youtube-dj/transport/skip-next") {
						invalidatePlaybackSnapshot()
						onPlaybackRequested?.invoke()
						notifyTransportAdvance()
						queueEngine.skipNext("user-skip-api")
						resetPlaybackClock(queueEngine.getCurrentVideoId().orEmpty(), 0.0)
						call.respondJson(
							JSONObject()
								.put("ok", true)
								.put("state", queueEngine.getKaraokeStateJson())
								.put("nowPlaying", nowPlayingJson()),
						)
					}
					post("/api/youtube-dj/transport/skip-prev") {
						invalidatePlaybackSnapshot()
						onPlaybackRequested?.invoke()
						notifyTransportAdvance()
						queueEngine.skipPrev("user-skip-api")
						resetPlaybackClock(queueEngine.getCurrentVideoId().orEmpty(), 0.0)
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
		if (action == "play-now") {
			onPlaybackRequested?.invoke()
		}
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
		val host = statusProvider()
		return JSONObject()
			.put("ok", true)
			.put("djActive", queueEngine.isPlaying || queueEngine.queue.isNotEmpty())
			.put("castConnected", false)
			.put("captureReady", host.showActive && youtubeBridge.isReady)
			.put("showActive", host.showActive)
			.put("queueLength", host.queueLength)
			.put("currentTitle", host.currentTitle)
			.put("interstitialMessage", host.interstitialMessage ?: JSONObject.NULL)
			.put("lastPlaybackError", host.lastPlaybackError ?: JSONObject.NULL)
			.put("lastAdvanceReason", queueEngine.lastAdvanceReason.ifBlank { JSONObject.NULL })
			.put("volumeLevel", volumeLevel)
			.put("youtubeSignedIn", YouTubeSessionHelper.isSignedIn())
			.put("youtubePremiumActive", YouTubeSessionHelper.isPremiumActive(preferences))
			.put("layoutOk", latestSnapshot?.layoutOk ?: false)
			.put("videoTopPx", latestSnapshot?.videoTopPx ?: 0)
			.put("port", SERVER_PORT)
			.put("hostMode", "direct")
			.put("host", ip)
	}

	private fun nowPlayingJson(): JSONObject {
		val snap = latestSnapshot
		val queueItem =
			queueEngine.queue.getOrNull(queueEngine.currentIndex)
		val videoId =
			snap?.videoId?.takeIf { it.isNotBlank() }
				?: queueEngine.getCurrentVideoId().orEmpty()
		val title =
			snap?.title?.takeIf { it.isNotBlank() }
				?: queueEngine.currentTitle.takeIf { it.isNotBlank() }
				?: queueItem?.title.orEmpty()
		val thumbnail =
			queueEngine.currentThumbnail.takeIf { it.isNotBlank() }
				?: queueItem?.thumbnail.orEmpty()
				.ifBlank {
					if (videoId.isNotBlank()) {
						"https://i.ytimg.com/vi/$videoId/hqdefault.jpg"
					} else {
						""
					}
				}
		val duration =
			snap?.duration?.takeIf { it > 0 }
				?: queueEngine.duration.takeIf { it > 0 }
				?: queueItem?.durationSec?.toDouble()?.takeIf { it > 0 }
				?: 0.0
		val state =
			if (!queueEngine.isPlaying) {
				2
			} else {
				snap?.state?.takeIf { it == 1 || it == 2 } ?: 1
			}
		val currentTime = resolveCurrentTimeForApi(state, duration)
		return JSONObject()
			.put("title", title)
			.put("videoId", videoId)
			.put("thumbnail", thumbnail)
			.put("currentTime", currentTime)
			.put("duration", duration)
			.put("volumeLevel", volumeLevel)
			.put("state", state)
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
