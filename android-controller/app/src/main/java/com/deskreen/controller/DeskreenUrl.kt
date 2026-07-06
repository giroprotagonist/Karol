package com.deskreen.controller

object DeskreenUrl {
	fun normalize(input: String): String? {
		val trimmed = input.trim()
		if (trimmed.isBlank()) {
			return null
		}

		val withScheme = when {
			trimmed.startsWith("http://") || trimmed.startsWith("https://") -> trimmed
			else -> "http://$trimmed"
		}

		return try {
			val uri = android.net.Uri.parse(withScheme)
			val host = uri.host ?: return null
			val port = if (uri.port > 0) uri.port else 3131
			val path = uri.path ?: ""
			when {
				path.contains("/dj-controller") -> withScheme.trimEnd('/') + "/"
				path.isBlank() || path == "/" ->
					"http://$host:$port/dj-controller/"
				else -> withScheme
			}
		} catch (_: Exception) {
			null
		}
	}
}
