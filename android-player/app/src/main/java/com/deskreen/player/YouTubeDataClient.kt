package com.deskreen.player

import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

class YouTubeDataClient(private val preferences: PlayerPreferences) {
	companion object {
		private const val TAG = "YouTubeDataClient"
		private const val PLAYLIST_ITEMS = "https://www.googleapis.com/youtube/v3/playlistItems"
		private const val SEARCH = "https://www.googleapis.com/youtube/v3/search"
		private const val TEST_PLAYLIST_ID = "PLRxCSLihrLO4"
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

	fun fetchPlaylistVideos(playlistInput: String): Pair<String, List<SearchVideo>> {
		val playlistId = extractPlaylistId(playlistInput) ?: TEST_PLAYLIST_ID
		val apiKey = preferences.getYouTubeApiKey()

		if (!apiKey.isNullOrBlank()) {
			try {
				val apiResults = fetchPlaylistViaApi(playlistId, apiKey)
				if (apiResults.isNotEmpty()) {
					Log.i(TAG, "playlist $playlistId via API: ${apiResults.size} videos")
					return playlistId to apiResults
				}
			} catch (error: Exception) {
				Log.w(TAG, "API playlist fetch failed, trying HTML scrape", error)
			}
		}

		try {
			val scraped = fetchPlaylistViaHtmlScrape(playlistId)
			if (scraped.isNotEmpty()) {
				Log.i(TAG, "playlist $playlistId via scrape: ${scraped.size} videos")
				return playlistId to scraped
			}
		} catch (error: Exception) {
			Log.w(TAG, "HTML scrape failed", error)
		}

		Log.w(TAG, "using fallback test videos for $playlistId")
		return playlistId to fallbackTestVideos()
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
				results.add(
					SearchVideo(
						videoId = videoId,
						title = snippet.optString("title", "YouTube: $videoId"),
						channelTitle = snippet.optString("channelTitle", ""),
						thumbnailUrl = thumbUrl,
						url = "https://www.youtube.com/watch?v=$videoId",
					),
				)
			}
			pageToken = json.optString("nextPageToken", "")
		} while (pageToken.isNotBlank())
		return results
	}

	private fun fetchPlaylistViaHtmlScrape(playlistId: String): List<SearchVideo> {
		val url =
			URL(
				"https://www.youtube.com/playlist?list=${URLEncoder.encode(playlistId, "UTF-8")}",
			)
		val connection = openGet(url)
		val html = connection.inputStream.bufferedReader().use { it.readText() }
		connection.disconnect()

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
			connectTimeout = 15000
			readTimeout = 20000
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
		return "$PLAYLIST_ITEMS?part=snippet&playlistId=$playlistId&maxResults=50&key=$apiKey$tokenPart"
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
