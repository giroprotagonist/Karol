package com.deskreen.player

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import org.json.JSONObject

interface YouTubePlayerController {
	fun loadVideo(videoId: String)
	fun play()
	fun pause()
	fun seek(seconds: Double)
	fun setVolume(level: Double)
	fun getSnapshot(): PlayerSnapshot?
	val isReady: Boolean
}

@SuppressLint("SetJavaScriptEnabled")
class YouTubeKioskBridge(
	private val context: Context,
	private val webView: WebView,
	private val rootLayout: FrameLayout,
) : YouTubePlayerController {
	private val mainHandler = Handler(Looper.getMainLooper())
	private var layoutScript: String = ""
	private var lastVideoId: String = ""
	private var pendingVideoId: String = ""
	private var isNavigating = false
	private var customView: android.view.View? = null
	private var customViewCallback: WebChromeClient.CustomViewCallback? = null
	private var onEndedListener: (() -> Unit)? = null
	private var pollRunnable: Runnable? = null
	private var lastEndedSignalAt = 0L
	private var layoutRefreshGeneration = 0

	override var isReady: Boolean = false
		private set

	init {
		layoutScript =
			context.assets.open("youtubeWatchLayout.js").bufferedReader().use { it.readText() }
		configureWebView()
		startPolling()
	}

	fun setOnVideoEndedListener(listener: () -> Unit) {
		onEndedListener = listener
	}

	@SuppressLint("SetJavaScriptEnabled")
	private fun configureWebView() {
		webView.setLayerType(android.view.View.LAYER_TYPE_HARDWARE, null)
		webView.settings.apply {
			javaScriptEnabled = true
			domStorageEnabled = true
			mediaPlaybackRequiresUserGesture = false
			javaScriptCanOpenWindowsAutomatically = true
			loadWithOverviewMode = true
			useWideViewPort = true
			cacheMode = WebSettings.LOAD_DEFAULT
			mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
			userAgentString =
				"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 DeskreenPlayer/1.0"
		}
		webView.addJavascriptInterface(JsBridge(), "DeskreenPlayer")
		webView.webViewClient =
			object : WebViewClient() {
				override fun shouldOverrideUrlLoading(
					view: WebView?,
					request: WebResourceRequest?,
				): Boolean {
					val url = request?.url?.toString() ?: return false
					if (url.contains("/embed/")) {
						Log.e(TAG, "blocked embed URL: $url")
						return true
					}
					return false
				}

				override fun onPageFinished(
					view: WebView?,
					url: String?,
				) {
					super.onPageFinished(view, url)
					isReady = true
					if (url?.contains("/watch") == true) {
						isNavigating = false
						scheduleLayoutRefresh()
						mainHandler.postDelayed({
							evalJs("window.__deskreenYtPlay && window.__deskreenYtPlay()")
						}, 600)
					}
				}

				override fun onRenderProcessGone(
					view: WebView?,
					detail: android.webkit.RenderProcessGoneDetail?,
				): Boolean {
					Log.e(TAG, "WebView renderer gone didCrash=${detail?.didCrash()}")
					reloadAfterCrash()
					return true
				}
			}
		webView.webChromeClient =
			object : WebChromeClient() {
				override fun onShowCustomView(
					view: android.view.View?,
					callback: CustomViewCallback?,
				) {
					if (view == null) {
						callback?.onCustomViewHidden()
						return
					}
					if (customView != null) {
						callback?.onCustomViewHidden()
						return
					}
					customView = view
					customViewCallback = callback
					webView.visibility = android.view.View.GONE
					rootLayout.addView(
						view,
						FrameLayout.LayoutParams(
							FrameLayout.LayoutParams.MATCH_PARENT,
							FrameLayout.LayoutParams.MATCH_PARENT,
						),
					)
				}

				override fun onHideCustomView() {
					hideCustomView()
				}
			}
	}

	override fun loadVideo(videoId: String) {
		if (videoId.isBlank()) {
			return
		}
		pendingVideoId = videoId
		lastVideoId = videoId
		isNavigating = true
		mainHandler.post {
			hideCustomView()
			val url = "https://www.youtube.com/watch?v=$videoId&autoplay=1"
			Log.i(TAG, "loadVideo full navigation: $videoId")
			webView.loadUrl(url)
		}
	}

	override fun play() {
		evalJs("window.__deskreenYtPlay && window.__deskreenYtPlay()")
	}

	override fun pause() {
		evalJs("window.__deskreenYtPause && window.__deskreenYtPause()")
	}

	override fun seek(seconds: Double) {
		evalJs("window.__deskreenYtSeek && window.__deskreenYtSeek($seconds)")
	}

	override fun setVolume(level: Double) {
		evalJs("window.__deskreenYtSetVolume && window.__deskreenYtSetVolume($level)")
	}

	override fun getSnapshot(): PlayerSnapshot? = null

	fun readSnapshot(callback: (PlayerSnapshot?) -> Unit) {
		evalJs(
			"(function(){ var s = window.__deskreenYtReadSnapshot && window.__deskreenYtReadSnapshot(); return s ? JSON.stringify(s) : ''; })()",
		) { raw ->
			if (raw.isNullOrBlank()) {
				callback(null)
				return@evalJs
			}
			try {
				val json = JSONObject(raw)
				callback(
					PlayerSnapshot(
						state = json.optInt("state", 3),
						videoId = json.optString("videoId"),
						title = json.optString("title"),
						currentTime = json.optDouble("currentTime"),
						duration = json.optDouble("duration"),
						paused = json.optBoolean("paused"),
						ended = json.optBoolean("ended"),
						hasVideo = json.optBoolean("hasVideo"),
					),
				)
			} catch (_: Exception) {
				callback(null)
			}
		}
	}

	fun reloadAfterCrash() {
		if (lastVideoId.isNotBlank()) {
			loadVideo(lastVideoId)
		}
	}

	fun destroy() {
		pollRunnable?.let { mainHandler.removeCallbacks(it) }
	}

	private fun hideCustomView() {
		val view = customView ?: return
		rootLayout.removeView(view)
		customView = null
		customViewCallback?.onCustomViewHidden()
		customViewCallback = null
		webView.visibility = android.view.View.VISIBLE
	}

	private fun scheduleLayoutRefresh() {
		val generation = ++layoutRefreshGeneration
		injectLayoutScript()
		for (delayMs in listOf(300L, 800L, 1500L, 3000L)) {
			mainHandler.postDelayed({
				if (generation != layoutRefreshGeneration) {
					return@postDelayed
				}
				injectLayoutScript()
			}, delayMs)
		}
	}

	private fun injectLayoutScript() {
		webView.evaluateJavascript(layoutScript, null)
	}

	private fun evalJs(
		script: String,
		callback: ((String?) -> Unit)? = null,
	) {
		mainHandler.post {
			webView.evaluateJavascript(script) { result ->
				callback?.invoke(result?.trim('"'))
			}
		}
	}

	private fun startPolling() {
		val runnable =
			object : Runnable {
				override fun run() {
					readSnapshot { snap ->
						if (snap != null) {
							PlayerApp.instance?.applySnapshot(snap)
							val endedForCurrent =
								snap.ended &&
									snap.state == 0 &&
									!isNavigating &&
									snap.videoId.isNotBlank() &&
									(snap.videoId == lastVideoId || snap.videoId == pendingVideoId)
							if (endedForCurrent) {
								val now = System.currentTimeMillis()
								if (now - lastEndedSignalAt > 2500) {
									lastEndedSignalAt = now
									onEndedListener?.invoke()
								}
							}
						}
					}
					mainHandler.postDelayed(this, POLL_MS)
				}
			}
		pollRunnable = runnable
		mainHandler.postDelayed(runnable, POLL_MS)
	}

	inner class JsBridge {
		@JavascriptInterface
		fun log(message: String) {
			Log.d(TAG, message)
		}
	}

	companion object {
		private const val TAG = "YouTubeKioskBridge"
		private const val POLL_MS = 1000L
	}
}
