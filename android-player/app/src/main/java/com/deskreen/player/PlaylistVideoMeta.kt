package com.deskreen.player

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.Locale
import java.util.regex.Pattern

object PlaylistVideoMeta {
	fun parseIsoMs(iso: String?): Long? {
		if (iso.isNullOrBlank()) {
			return null
		}
		return try {
			Instant.parse(iso).toEpochMilli()
		} catch (_: Exception) {
			null
		}
	}

	fun parseDurationSeconds(renderer: JSONObject): Int? {
		val seconds = renderer.optInt("lengthSeconds", -1)
		if (seconds > 0) {
			return seconds
		}
		val lengthText = textFromRuns(renderer.optJSONObject("lengthText")).ifBlank {
			renderer.optJSONObject("lengthText")?.optString("simpleText", "") ?: ""
		}
		return parseDurationText(lengthText)
	}

	fun parseDurationText(text: String): Int? {
		val trimmed = text.trim()
		if (trimmed.isBlank()) {
			return null
		}
		val parts = trimmed.split(":").mapNotNull { it.trim().toIntOrNull() }
		return when (parts.size) {
			3 -> parts[0] * 3600 + parts[1] * 60 + parts[2]
			2 -> parts[0] * 60 + parts[1]
			1 -> parts[0]
			else -> null
		}
	}

	fun parsePlaylistIndex(renderer: JSONObject): Int? {
		val indexText =
			renderer.optJSONObject("index")?.optString("simpleText", "")?.trim()
				?: renderer.optString("index", "").trim()
		return indexText.toIntOrNull()
	}

	fun parseChannelTitle(renderer: JSONObject): String {
		return textFromRuns(renderer.optJSONObject("shortBylineText")).trim()
	}

	fun parseVideoInfo(renderer: JSONObject): Pair<Long?, Long?> {
		val runs = renderer.optJSONObject("videoInfo")?.optJSONArray("runs") ?: return null to null
		var viewCount: Long? = null
		var publishedAtMs: Long? = null
		for (i in 0 until runs.length()) {
			val text = runs.getJSONObject(i).optString("text", "").trim()
			if (text.isBlank() || text == "•") {
				continue
			}
			if (text.contains("view", ignoreCase = true)) {
				viewCount = parseViewCount(text) ?: viewCount
			} else {
				publishedAtMs = parseRelativeTimeMs(text) ?: publishedAtMs
			}
		}
		return viewCount to publishedAtMs
	}

	fun parseViewCount(text: String): Long? {
		val cleaned =
			text
				.lowercase(Locale.US)
				.replace("views", "")
				.replace("view", "")
				.replace(",", "")
				.trim()
		if (cleaned.isBlank()) {
			return null
		}
		val multiplier =
			when {
				cleaned.endsWith("k") -> 1_000L
				cleaned.endsWith("m") -> 1_000_000L
				cleaned.endsWith("b") -> 1_000_000_000L
				else -> 1L
			}
		val numeric =
			cleaned
				.trimEnd { !it.isDigit() && it != '.' }
				.toDoubleOrNull()
				?: return null
		return (numeric * multiplier).toLong()
	}

	fun parseRelativeTimeMs(text: String): Long? {
		val normalized = text.trim().lowercase(Locale.US)
		val matcher = RELATIVE_TIME.matcher(normalized)
		if (!matcher.find()) {
			return null
		}
		val amount = matcher.group(1)?.toLongOrNull() ?: return null
		val unit = matcher.group(2) ?: return null
		val now = System.currentTimeMillis()
		val deltaMs =
			when {
				unit.startsWith("second") -> amount * 1_000L
				unit.startsWith("minute") -> amount * 60_000L
				unit.startsWith("hour") -> amount * 3_600_000L
				unit.startsWith("day") -> amount * 86_400_000L
				unit.startsWith("week") -> amount * 7 * 86_400_000L
				unit.startsWith("month") -> amount * 30 * 86_400_000L
				unit.startsWith("year") -> amount * 365 * 86_400_000L
				else -> return null
			}
		return now - deltaMs
	}

	fun parseApiDuration(isoDuration: String?): Int? {
		if (isoDuration.isNullOrBlank() || !isoDuration.startsWith("PT")) {
			return null
		}
		var seconds = 0
		val matcher = Pattern.compile("(\\d+)([HMS])").matcher(isoDuration)
		while (matcher.find()) {
			val value = matcher.group(1)?.toIntOrNull() ?: continue
			when (matcher.group(2)) {
				"H" -> seconds += value * 3600
				"M" -> seconds += value * 60
				"S" -> seconds += value
			}
		}
		return seconds.takeIf { it > 0 }
	}

	private fun textFromRuns(node: JSONObject?): String {
		if (node == null) {
			return ""
		}
		val runs = node.optJSONArray("runs")
		if (runs != null && runs.length() > 0) {
			val parts = mutableListOf<String>()
			for (i in 0 until runs.length()) {
				val part = runs.getJSONObject(i).optString("text", "")
				if (part.isNotBlank()) {
					parts.add(part)
				}
			}
			return parts.joinToString("")
		}
		return node.optString("simpleText", "")
	}

	private val RELATIVE_TIME =
		Pattern.compile("(\\d+)\\s+(second|minute|hour|day|week|month|year)s?\\s+ago")
}
