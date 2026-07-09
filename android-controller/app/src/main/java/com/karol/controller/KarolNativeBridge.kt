package com.karol.controller

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.webkit.JavascriptInterface
import android.webkit.WebView

class KarolNativeBridge(
	private val context: Context,
	private val webView: WebView,
	private val onConnectionState: (Boolean) -> Unit,
) {
	private val mainHandler = Handler(Looper.getMainLooper())

	fun pushVolumeToWebView(level: Double) {
		mainHandler.post {
			val clamped = level.coerceIn(0.0, 1.0)
			webView.evaluateJavascript(
				"window.__deskreenNativeVolume && window.__deskreenNativeVolume($clamped)",
				null,
			)
		}
	}

	fun pushNowPlayingToWebView(nowPlaying: DjNowPlaying) {
		mainHandler.post {
			val json =
				org.json.JSONObject()
					.put("title", nowPlaying.title)
					.put("videoId", nowPlaying.videoId)
					.put("thumbnail", nowPlaying.thumbnailUrl)
					.put("currentTime", nowPlaying.currentTimeSec)
					.put("duration", nowPlaying.durationSec)
					.put("state", nowPlaying.state)
					.toString()
			webView.evaluateJavascript(
				"window.__deskreenNativeNowPlaying && window.__deskreenNativeNowPlaying($json)",
				null,
			)
		}
	}

	@JavascriptInterface
	fun publishNowPlaying(json: String) {
		mainHandler.post {
			val parsed = parseNowPlayingJson(json) ?: return@post
			// #region agent log
			ControllerDbg.log(
				"H2",
				"KarolNativeBridge.publishNowPlaying",
				"webview-relay",
				mapOf(
					"videoId" to parsed.videoId,
					"state" to parsed.state,
					"currentTime" to parsed.currentTimeSec,
				),
			)
			// #endregion
			PlaybackStateRelay.publish(parsed, PlaybackStateRelay.Source.WEBVIEW)
		}
	}

	@JavascriptInterface
	fun setRemoteVolume(level: Double) {
		mainHandler.post {
			val clamped = level.coerceIn(0.0, 1.0)
			// #region agent log
			ControllerDbg.log(
				"H5",
				"KarolNativeBridge.setRemoteVolume",
				"webview-volume",
				mapOf("level" to clamped),
			)
			// #endregion
			RemoteVolumeController.setLevel(clamped, "webview-slider")
		}
	}

	private fun parseNowPlayingJson(json: String): DjNowPlaying? {
		return try {
			val obj = org.json.JSONObject(json)
			val videoId = obj.optString("videoId", "")
			if (videoId.isBlank() && obj.optString("title", "").isBlank()) {
				return null
			}
			DjNowPlaying(
				title = obj.optString("title", ""),
				videoId = videoId,
				thumbnailUrl = obj.optString("thumbnail", ""),
				currentTimeSec = obj.optDouble("currentTime", 0.0),
				durationSec = obj.optDouble("duration", 0.0),
				state = obj.optInt("state", 3),
			)
		} catch (_: Exception) {
			null
		}
	}

	@JavascriptInterface
	fun ctrlDbg(
		hypothesisId: String,
		message: String,
		dataJson: String,
	) {
		// #region agent log
		ControllerDbg.log(
			hypothesisId,
			"KarolNativeBridge.ctrlDbg",
			message,
			try {
				val data = org.json.JSONObject(dataJson)
				buildMap {
					put("raw", dataJson.take(240))
					if (data.has("target")) put("target", data.optDouble("target"))
					if (data.has("seconds")) put("seconds", data.optDouble("seconds"))
					if (data.has("requested")) put("requested", data.optDouble("requested"))
					if (data.has("reported")) put("reported", data.optDouble("reported"))
					if (data.has("active")) put("active", data.optBoolean("active"))
					if (data.has("serverTime")) put("serverTime", data.optDouble("serverTime"))
				}
			} catch (_: Exception) {
				mapOf("raw" to dataJson.take(240))
			},
		)
		// #endregion
	}

	@JavascriptInterface
	fun onConnectionState(healthy: Boolean) {
		mainHandler.post { onConnectionState(healthy) }
	}

	@JavascriptInterface
	fun hapticLight() {
		val vibrator =
			if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
				val manager =
					context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
				manager.defaultVibrator
			} else {
				@Suppress("DEPRECATION")
				context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
			}
		if (!vibrator.hasVibrator()) {
			return
		}
		if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
			vibrator.vibrate(VibrationEffect.createOneShot(25, VibrationEffect.DEFAULT_AMPLITUDE))
		} else {
			@Suppress("DEPRECATION")
			vibrator.vibrate(25)
		}
	}
}
