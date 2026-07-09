package com.karol.player

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

class YouTubeDataClient(private val preferences: PlayerPreferences) {
	companion object {
		private const val TAG = "YouTubeDataClient"
		private const val PLAYLIST_ITEMS = "https://www.googleapis.com/youtube/v3/playlistItems"
		private const val VIDEOS_LIST = "https://www.googleapis.com/youtube/v3/videos"
		private const val INNERTUBE_BROWSE = "https://www.youtube.com/youtubei/v1/browse"
		private const val SEARCH = "https://www.googleapis.com/youtube/v3/search"
		private const val TEST_PLAYLIST_ID = "PLRxCSLihrLO4"
		private const val MAX_PLAYLIST_CONTINUATION_PAGES = 60
		private const val DESKTOP_UA =
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
	}

	fun extractPlaylistId(input: String): String? {
		val trimmed = input.trim()
		if (Regex("^PL[a-zA-Z0-9_-]+$").matches(trimmed)) {
			return trimmed
		}
		return try {
			val u = URL(trimmed)
			if (u.host.contains("youtube.com") || u.host.contains("youtu.be")) {
				u.query?.split("&")?.firstOrNull { it.startsWith("list=") }?.substringAfter("list=")
					?.takeIf { it.startsWith("PL") }
			} else {
				null
			}
		} catch (_: Exception) {
			null
		}
	}

	fun fetchPlaylistTitle(
		playlistId: String,
		playlistUrl: String = "",
	): String {
		val apiKey = preferences.getYouTubeApiKey()
		if (!apiKey.isNullOrBlank()) {
			try {
				val url =
					URL(
						"https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=$playlistId&key=$apiKey",
					)
				val connection = openGet(url)
				val body = connection.inputStream.bufferedReader().use { it.readText() }
				connection.disconnect()
				val json = JSONObject(body)
				val items = json.optJSONArray("items")
				if (items != null && items.length() > 0) {
					val title =
						items
							.getJSONObject(0)
							.optJSONObject("snippet")
							?.optString("title")
							?.trim()
					if (!title.isNullOrBlank()) {
						return title
					}
				}
			} catch (error: Exception) {
				Log.w(TAG, "API playlist title fetch failed", error)
			}
		}
		return fetchPlaylistTitleFromHtml(playlistId, playlistUrl)
	}

	private fun fetchPlaylistTitleFromHtml(
		playlistId: String,
		playlistUrl: String,
	): String {
		val pageUrl =
			playlistUrl.ifBlank {
				"https://www.youtube.com/playlist?list=$playlistId"
			}
		return try {
			val connection = openGet(URL(pageUrl))
			val html = connection.inputStream.bufferedReader().use { it.readText() }
			connection.disconnect()
			val ogTitle =
				Regex(
					"<meta\\s+property=\"og:title\"\\s+content=\"([^\"]+)\"",
					RegexOption.IGNORE_CASE,
				).find(html)?.groupValues?.get(1)?.trim()
			if (!ogTitle.isNullOrBlank() && !ogTitle.equals("YouTube", ignoreCase = true)) {
				return ogTitle
			}
			val jsonTitle =
				Regex("\"title\":\"((?:\\\\.|[^\"\\\\])*)\"")
					.findAll(html)
					.map { it.groupValues[1].replace("\\u0026", "&") }
					.firstOrNull { it.length > 3 && !it.startsWith("YouTube") }
			jsonTitle ?: "Playlist"
		} catch (error: Exception) {
			Log.w(TAG, "HTML playlist title scrape failed", error)
			"Playlist"
		}
	}

	fun fetchPlaylistVideos(playlistInput: String): Pair<String, List<SearchVideo>> {
		val playlistId = extractPlaylistId(playlistInput) ?: TEST_PLAYLIST_ID
		val apiKey = preferences.getYouTubeApiKey()

		if (!apiKey.isNullOrBlank()) {
			try {
				val apiResults = fetchPlaylistViaApi(playlistId, apiKey)
				if (apiResults.isNotEmpty()) {
					Log.i(TAG, "playlist $playlistId via API: ${apiResults.size} videos")
					return playlistId to enrichVideosViaApi(apiResults, apiKey)
				}
			} catch (error: Exception) {
				Log.w(TAG, "API playlist fetch failed, trying HTML scrape", error)
			}
		}

		try {
			val scraped = fetchPlaylistViaInnertube(playlistId)
			if (scraped.isNotEmpty()) {
				Log.i(TAG, "playlist $playlistId via innertube: ${scraped.size} videos")
				return playlistId to scraped
			}
		} catch (error: Exception) {
			Log.w(TAG, "Innertube playlist fetch failed, trying regex scrape", error)
		}

		try {
			val scraped = fetchPlaylistViaHtmlScrapeRegex(playlistId)
			if (scraped.isNotEmpty()) {
				Log.i(TAG, "playlist $playlistId via scrape: ${scraped.size} videos")
				return playlistId to scraped
			}
		} catch (error: Exception) {
			Log.w(TAG, "HTML scrape failed", error)
		}

		return maybeFallbackTestVideos(playlistId)
	}

	private fun maybeFallbackTestVideos(playlistId: String): Pair<String, List<SearchVideo>> {
		if (BuildConfig.DEBUG) {
			Log.w(TAG, "using fallback test videos for $playlistId")
			return playlistId to fallbackTestVideos()
		}
		throw IllegalStateException(
			"Could not fetch playlist $playlistId. Add a YouTube API key in settings or check network.",
		)
	}

	private fun fetchPlaylistViaApi(
		playlistId: String,
		apiKey: String,
	): List<SearchVideo> {
		val results = mutableListOf<SearchVideo>()
		var pageToken = ""
		do {
			val url = URL(buildPlaylistUrl(playlistId, apiKey, pageToken))
			val connection = openGet(url)
			val body = connection.inputStream.bufferedReader().use { it.readText() }
			connection.disconnect()
			val json = JSONObject(body)
			if (json.has("error")) {
				throw IllegalStateException(json.optJSONObject("error")?.optString("message") ?: "API error")
			}
			val items = json.optJSONArray("items") ?: break
			for (i in 0 until items.length()) {
				val item = items.getJSONObject(i)
				val snippet = item.optJSONObject("snippet") ?: continue
				val resource = snippet.optJSONObject("resourceId") ?: continue
				val videoId = resource.optString("videoId")
				if (videoId.isBlank()) {
					continue
				}
				val thumbs = snippet.optJSONObject("thumbnails")
				val thumbUrl = thumbs?.optJSONObject("default")?.optString("url") ?: ""
				val content = item.optJSONObject("contentDetails")
				results.add(
					SearchVideo(
						videoId = videoId,
						title = snippet.optString("title", "YouTube: $videoId"),
						channelTitle = snippet.optString("channelTitle", ""),
						thumbnailUrl = thumbUrl,
						url = "https://www.youtube.com/watch?v=$videoId",
						playlistPosition = snippet.optInt("position", -1).takeIf { it >= 0 },
						addedAtMs = PlaylistVideoMeta.parseIsoMs(snippet.optString("publishedAt")),
						publishedAtMs =
							PlaylistVideoMeta.parseIsoMs(
								content?.optString("videoPublishedAt"),
							),
					),
				)
			}
			pageToken = json.optString("nextPageToken", "")
		} while (pageToken.isNotBlank())
		return results
	}

	private fun fetchPlaylistViaInnertube(playlistId: String): List<SearchVideo> {
		val pageUrl =
			"https://www.youtube.com/playlist?list=${URLEncoder.encode(playlistId, "UTF-8")}"
		val connection = openGet(URL(pageUrl))
		val html = connection.inputStream.bufferedReader().use { it.readText() }
		connection.disconnect()

		val config = extractInnertubeConfig(html) ?: return parsePlaylistHtmlRegex(html)
		val collector = PlaylistCollector()
		collector.consume(config.initialData)

		var continuation =
			extractPlaylistListContinuationToken(config.initialData) ?: collector.continuation
		var pages = 0
		while (!continuation.isNullOrBlank() && pages < MAX_PLAYLIST_CONTINUATION_PAGES) {
			pages++
			val response =
				postInnertubeBrowse(
					innertubeKey = config.apiKey,
					clientVersion = config.clientVersion,
					continuation = continuation,
				)
			val pageCollector = PlaylistCollector()
			pageCollector.consume(response)
			collector.merge(pageCollector)
			val nextContinuation = pageCollector.continuation
			if (nextContinuation.isNullOrBlank()) {
				break
			}
			if (nextContinuation == continuation) {
				break
			}
			continuation = nextContinuation
		}

		Log.i(
			TAG,
			"innertube $playlistId: ${collector.results.size} videos ($pages continuation pages)",
		)
		return collector.results
	}

	private data class InnertubeConfig(
		val apiKey: String,
		val clientVersion: String,
		val initialData: JSONObject,
	)

	private fun extractPlaylistListContinuationToken(initialData: JSONObject): String? {
		return findPlaylistListContinuation(initialData)
	}

	private fun findPlaylistListContinuation(node: Any?): String? {
		when (node) {
			is JSONObject -> {
				val listRenderer = node.optJSONObject("playlistVideoListRenderer")
				if (listRenderer != null) {
					val contents = listRenderer.optJSONArray("contents") ?: return null
					for (i in 0 until contents.length()) {
						val item = contents.optJSONObject(i) ?: continue
						val contRenderer = item.optJSONObject("continuationItemRenderer")
						if (contRenderer != null) {
							val token = extractContinuationToken(contRenderer)
							if (!token.isNullOrBlank()) {
								return token
							}
						}
					}
				}
				val keys = node.keys()
				while (keys.hasNext()) {
					findPlaylistListContinuation(node.get(keys.next()))?.let { return it }
				}
			}
			is JSONArray -> {
				for (i in 0 until node.length()) {
					findPlaylistListContinuation(node.get(i))?.let { return it }
				}
			}
		}
		return null
	}

	private fun extractContinuationToken(renderer: JSONObject): String? {
		val endpoint = renderer.optJSONObject("continuationEndpoint") ?: return null
		endpoint
			.optJSONObject("continuationCommand")
			?.optString("token")
			?.takeIf { it.isNotBlank() }
			?.let { return it }
		val commands =
			endpoint.optJSONObject("commandExecutorCommand")?.optJSONArray("commands")
				?: return null
		for (i in 0 until commands.length()) {
			val token =
				commands
					.getJSONObject(i)
					.optJSONObject("continuationCommand")
					?.optString("token")
			if (!token.isNullOrBlank()) {
				return token
			}
		}
		return null
	}

	private inner class PlaylistCollector {
		val seen = linkedSetOf<String>()
		val results = mutableListOf<SearchVideo>()
		var continuation: String? = null

		fun merge(other: PlaylistCollector) {
			for (video in other.results) {
				if (seen.add(video.videoId)) {
					results.add(video)
				}
			}
			if (!other.continuation.isNullOrBlank()) {
				continuation = other.continuation
			}
		}

		fun consume(node: Any?) {
			when (node) {
				is JSONObject -> {
				if (node.has("playlistVideoRenderer")) {
					addVideo(node.getJSONObject("playlistVideoRenderer"))
				}
				if (node.has("playlistPanelVideoRenderer")) {
					addVideo(node.getJSONObject("playlistPanelVideoRenderer"))
				}
					captureContinuation(node)
					val keys = node.keys()
					while (keys.hasNext()) {
						consume(node.get(keys.next()))
					}
				}
				is JSONArray -> {
					for (i in 0 until node.length()) {
						consume(node.get(i))
					}
				}
			}
		}

		private fun addVideo(renderer: JSONObject) {
			val videoId =
				renderer
					.optJSONObject("navigationEndpoint")
					?.optJSONObject("watchEndpoint")
					?.optString("videoId")
					?.takeIf { it.length == 11 }
					?: renderer.optString("videoId").takeIf { it.length == 11 }
					?: return
			if (!seen.add(videoId)) {
				return
			}
			val title = titleFromRenderer(renderer).ifBlank { "YouTube: $videoId" }
			val thumbs = renderer.optJSONObject("thumbnail")
			val thumbUrl =
				thumbs
					?.optJSONArray("thumbnails")
					?.let { arr ->
						if (arr.length() > 0) {
							arr.getJSONObject(arr.length() - 1).optString("url")
						} else {
							""
						}
					}
					?: ""
			val (viewCount, publishedAtMs) = PlaylistVideoMeta.parseVideoInfo(renderer)
			val channelTitle = PlaylistVideoMeta.parseChannelTitle(renderer)
			results.add(
				SearchVideo(
					videoId = videoId,
					title = title,
					channelTitle = channelTitle,
					thumbnailUrl =
						thumbUrl.ifBlank {
							"https://i.ytimg.com/vi/$videoId/default.jpg"
						},
					url = "https://www.youtube.com/watch?v=$videoId",
					playlistPosition =
						PlaylistVideoMeta.parsePlaylistIndex(renderer)
							?: (results.size + 1),
					durationSec = PlaylistVideoMeta.parseDurationSeconds(renderer),
					publishedAtMs = publishedAtMs,
					viewCount = viewCount,
				),
			)
		}

		private fun titleFromRenderer(renderer: JSONObject): String {
			val title = renderer.optJSONObject("title") ?: return ""
			val runs = title.optJSONArray("runs")
			if (runs != null && runs.length() > 0) {
				return runs.getJSONObject(0).optString("text", "").trim()
			}
			return title.optString("simpleText", "").trim()
		}

		private fun captureContinuation(obj: JSONObject) {
			if (obj.has("continuationItemRenderer")) {
				val token = extractContinuationToken(obj.getJSONObject("continuationItemRenderer"))
				if (!token.isNullOrBlank()) {
					continuation = token
				}
			}
		}
	}

	private fun extractInnertubeConfig(html: String): InnertubeConfig? {
		val apiKey =
			Regex("\"INNERTUBE_API_KEY\":\"([^\"]+)\"")
				.find(html)
				?.groupValues
				?.get(1)
				?: return null
		val clientVersion =
			Regex("\"INNERTUBE_CONTEXT_CLIENT_VERSION\":\"([^\"]+)\"")
				.find(html)
				?.groupValues
				?.get(1)
				?: Regex("\"clientVersion\":\"([^\"]+)\"")
					.find(html)
					?.groupValues
					?.get(1)
				?: "2.20240101.00.00"
		val initialData = extractYtInitialData(html) ?: return null
		return InnertubeConfig(apiKey, clientVersion, initialData)
	}

	private fun extractYtInitialData(html: String): JSONObject? {
		val marker = "var ytInitialData = "
		val startIdx = html.indexOf(marker)
		if (startIdx < 0) {
			return null
		}
		var i = startIdx + marker.length
		while (i < html.length && html[i].isWhitespace()) {
			i++
		}
		if (i >= html.length || html[i] != '{') {
			return null
		}
		var depth = 0
		val begin = i
		while (i < html.length) {
			when (html[i]) {
				'{' -> depth++
				'}' -> {
					depth--
					if (depth == 0) {
						return try {
							JSONObject(html.substring(begin, i + 1))
						} catch (_: Exception) {
							null
						}
					}
				}
			}
			i++
		}
		return null
	}

	private fun postInnertubeBrowse(
		innertubeKey: String,
		clientVersion: String,
		continuation: String,
	): JSONObject {
		val url =
			URL(
				"$INNERTUBE_BROWSE?key=${URLEncoder.encode(innertubeKey, "UTF-8")}&prettyPrint=false",
			)
		val connection = url.openConnection() as HttpURLConnection
		connection.requestMethod = "POST"
		connection.doOutput = true
		connection.connectTimeout = 20_000
		connection.readTimeout = 45_000
		connection.setRequestProperty("Content-Type", "application/json")
		connection.setRequestProperty("User-Agent", DESKTOP_UA)
		connection.setRequestProperty("Accept-Language", "en-US,en;q=0.9")
		val payload =
			JSONObject()
				.put(
					"context",
					JSONObject()
						.put(
							"client",
							JSONObject()
								.put("clientName", "WEB")
								.put("clientVersion", clientVersion)
								.put("hl", "en")
								.put("gl", "US"),
						),
				)
				.put("continuation", continuation)
		connection.outputStream.use {
			it.write(payload.toString().toByteArray(Charsets.UTF_8))
		}
		val code = connection.responseCode
		val body =
			(if (code in 200..299) connection.inputStream else connection.errorStream)
				.bufferedReader()
				.use { it.readText() }
		connection.disconnect()
		if (code !in 200..299) {
			throw IllegalStateException("Innertube browse failed ($code)")
		}
		return JSONObject(body)
	}

	private fun fetchPlaylistViaHtmlScrapeRegex(playlistId: String): List<SearchVideo> {
		val url =
			URL(
				"https://www.youtube.com/playlist?list=${URLEncoder.encode(playlistId, "UTF-8")}",
			)
		val connection = openGet(url)
		val html = connection.inputStream.bufferedReader().use { it.readText() }
		connection.disconnect()
		return parsePlaylistHtmlRegex(html)
	}

	private fun parsePlaylistHtmlRegex(html: String): List<SearchVideo> {
		val seen = linkedSetOf<String>()
		val results = mutableListOf<SearchVideo>()
		val regex = Regex("\"videoId\":\"([a-zA-Z0-9_-]{11})\"")
		for (match in regex.findAll(html)) {
			val videoId = match.groupValues[1]
			if (seen.contains(videoId)) {
				continue
			}
			seen.add(videoId)
			results.add(
				SearchVideo(
					videoId = videoId,
					title = "YouTube: $videoId",
					channelTitle = "",
					thumbnailUrl = "https://i.ytimg.com/vi/$videoId/default.jpg",
					url = "https://www.youtube.com/watch?v=$videoId",
					playlistPosition = results.size + 1,
				),
			)
		}
		return results
	}

	fun searchVideos(query: String): List<SearchVideo> {
		val apiKey = preferences.getYouTubeApiKey() ?: return emptyList()
		if (query.isBlank()) {
			return emptyList()
		}
		val url =
			URL(
				"$SEARCH?part=snippet&maxResults=12&q=${URLEncoder.encode(query.trim(), "UTF-8")}&type=video&key=$apiKey",
			)
		val connection = openGet(url)
		val body = connection.inputStream.bufferedReader().use { it.readText() }
		connection.disconnect()
		val json = JSONObject(body)
		val items = json.optJSONArray("items") ?: return emptyList()
		val results = mutableListOf<SearchVideo>()
		for (i in 0 until items.length()) {
			val item = items.getJSONObject(i)
			val id = item.optJSONObject("id") ?: continue
			val videoId = id.optString("videoId")
			val snippet = item.optJSONObject("snippet") ?: continue
			val thumbs = snippet.optJSONObject("thumbnails")
			results.add(
				SearchVideo(
					videoId = videoId,
					title = snippet.optString("title"),
					channelTitle = snippet.optString("channelTitle"),
					thumbnailUrl = thumbs?.optJSONObject("default")?.optString("url") ?: "",
					url = "https://www.youtube.com/watch?v=$videoId",
				),
			)
		}
		return results
	}

	private fun openGet(url: URL): HttpURLConnection =
		(url.openConnection() as HttpURLConnection).apply {
			connectTimeout = 20_000
			readTimeout = 45_000
			requestMethod = "GET"
			setRequestProperty("User-Agent", DESKTOP_UA)
			setRequestProperty("Accept-Language", "en-US,en;q=0.9")
		}

	private fun buildPlaylistUrl(
		playlistId: String,
		apiKey: String,
		pageToken: String,
	): String {
		val tokenPart =
			if (pageToken.isBlank()) {
				""
			} else {
				"&pageToken=${URLEncoder.encode(pageToken, "UTF-8")}"
			}
		return "$PLAYLIST_ITEMS?part=snippet,contentDetails&playlistId=$playlistId&maxResults=50&key=$apiKey$tokenPart"
	}

	private fun enrichVideosViaApi(
		videos: List<SearchVideo>,
		apiKey: String,
	): List<SearchVideo> {
		if (videos.isEmpty()) {
			return videos
		}
		val byId = videos.associateBy { it.videoId }.toMutableMap()
		videos.map { it.videoId }.chunked(50).forEach { chunk ->
			try {
				val ids = chunk.joinToString(",")
				val url =
					URL(
						"$VIDEOS_LIST?part=contentDetails,statistics&id=$ids&key=$apiKey",
					)
				val connection = openGet(url)
				val body = connection.inputStream.bufferedReader().use { it.readText() }
				connection.disconnect()
				val json = JSONObject(body)
				val items = json.optJSONArray("items") ?: return@forEach
				for (i in 0 until items.length()) {
					val item = items.getJSONObject(i)
					val videoId = item.optString("id")
					val existing = byId[videoId] ?: continue
					val content = item.optJSONObject("contentDetails")
					val stats = item.optJSONObject("statistics")
					byId[videoId] =
						existing.copy(
							durationSec =
								PlaylistVideoMeta.parseApiDuration(
									content?.optString("duration"),
								) ?: existing.durationSec,
							viewCount =
								stats
									?.optString("viewCount")
									?.toLongOrNull()
									?: existing.viewCount,
							publishedAtMs =
								PlaylistVideoMeta.parseIsoMs(
									content?.optString("videoPublishedAt"),
								) ?: existing.publishedAtMs,
						)
				}
			} catch (error: Exception) {
				Log.w(TAG, "videos.list enrich failed for chunk", error)
			}
		}
		return videos.map { byId[it.videoId] ?: it }
	}

	private fun fallbackTestVideos(): List<SearchVideo> =
		listOf(
			"dEj2Pn4uuzs",
			"6Zbi0XmGtMw",
			"JeucohIa5LQ",
			"c18441Eh_WE",
			"r7ERoX099ao",
		).map { videoId ->
			SearchVideo(
				videoId = videoId,
				title = "YouTube: $videoId",
				channelTitle = "",
				thumbnailUrl = "https://i.ytimg.com/vi/$videoId/default.jpg",
				url = "https://www.youtube.com/watch?v=$videoId",
			)
		}
}
