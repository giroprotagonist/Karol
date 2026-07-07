package com.deskreen.player

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
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
	fun needsVideoLoad(videoId: String): Boolean
	fun getLastKnownPlaybackTime(): Double
	val isReady: Boolean
}

@SuppressLint("SetJavaScriptEnabled")
class YouTubeKioskBridge(
	private val context: Context,
	private val webView: WebView,
	private val rootLayout: FrameLayout,
	private val onRequestImmersiveMode: (() -> Unit)? = null,
) : YouTubePlayerController {
	private val mainHandler = Handler(Looper.getMainLooper())
	private var layoutScript: String = ""
	private var lastVideoId: String = ""
	private var pendingVideoId: String = ""
	private var isNavigating = false
	private var customView: android.view.View? = null
	private var customViewCallback: WebChromeClient.CustomViewCallback? = null
	private var onEndedListener: (() -> Unit)? = null
	private var onInterstitialListener: ((String) -> Unit)? = null
	private var onUnexpectedVideoIdListener: ((String) -> Unit)? = null
	private var onYouTubeSignedInListener: (() -> Unit)? = null
	private var pollRunnable: Runnable? = null
	private var layoutRefreshGeneration = 0
	private var programmaticNavGeneration = 0
	private var activeProgrammaticGeneration = 0
	private var userNavigatedAway = false
	@Volatile
	private var lastKnownUrl: String = ""
	private var lastVolumeLevel: Double = 1.0
	private var navigationWatchdog: Runnable? = null
	private var navigationRetryUrl: String = ""
	private var lastKnownPlaybackTime: Double = 0.0
	private var errorRetryCount = 0
	var allowHomeLanding = false
		private set

	override var isReady: Boolean = false
		private set

	init {
		layoutScript =
			context.assets.open("youtubeWatchLayout.js").bufferedReader().use { it.readText() }
		YouTubeSessionHelper.configure(webView)
		configureWebView()
		startPolling()
	}

	/** Open Google sign-in in the WebView (call before show or from start panel). */
	fun openYouTubeSignIn(onFinished: (() -> Unit)? = null) {
		allowHomeLanding = true
		userNavigatedAway = false
		mainHandler.post {
			hideCustomView()
			webView.visibility = android.view.View.VISIBLE
			webView.loadUrl(YouTubeSessionHelper.signInUrl())
			onFinished?.invoke()
		}
	}

	fun isYouTubeSignedIn(): Boolean = YouTubeSessionHelper.isSignedIn()

	fun setOnVideoEndedListener(listener: () -> Unit) {
		onEndedListener = listener
	}

	fun setOnInterstitialListener(listener: (String) -> Unit) {
		onInterstitialListener = listener
	}

	fun setOnUnexpectedVideoIdListener(listener: (String) -> Unit) {
		onUnexpectedVideoIdListener = listener
	}

	fun setOnYouTubeSignedInListener(listener: () -> Unit) {
		onYouTubeSignedInListener = listener
	}

	fun isInCustomView(): Boolean = customView != null

	fun exitFullscreen() {
		hideCustomView()
		onRequestImmersiveMode?.invoke()
	}

	fun cancelPendingLayoutRefresh() {
		layoutRefreshGeneration++
	}

	fun syncVolumeLevel(level: Double) {
		lastVolumeLevel = level.coerceIn(0.0, 1.0)
	}

	fun refreshLayout() {
		scheduleLayoutRefresh()
	}

	fun shouldWebViewGoBack(): Boolean {
		if (!webView.canGoBack()) {
			return false
		}
		val url = webView.url ?: return false
		if (url == "about:blank") {
			return false
		}
		if (userNavigatedAway) {
			return true
		}
		if (!url.contains("/watch")) {
			return true
		}
		return false
	}

	fun goBackInWebView() {
		if (!webView.canGoBack()) {
			return
		}
		userNavigatedAway = false
		webView.goBack()
		scheduleLayoutRefresh()
	}

	fun loadHomeLanding() {
		allowHomeLanding = true
		userNavigatedAway = false
		mainHandler.post {
			hideCustomView()
			webView.loadUrl("https://www.youtube.com")
		}
	}

	fun prepareForStop() {
		cancelPendingLayoutRefresh()
		userNavigatedAway = false
		allowHomeLanding = false
		activeProgrammaticGeneration = 0
		evalJs("window.__deskreenYtReleaseMonoPipeline && window.__deskreenYtReleaseMonoPipeline()")
		pause()
		exitFullscreen()
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
			// Desktop Chrome UA (no custom app token): theater layout + Premium cookies still apply.
			userAgentString = buildTrustedUserAgent()
		}
		// #region agent log
		Log.i(
			"DeskreenDbg",
			org.json.JSONObject()
				.put("sessionId", "25b906")
				.put("hypothesisId", "H1")
				.put("location", "YouTubeKioskBridge.configureWebView")
				.put("message", "user-agent")
				.put("data", org.json.JSONObject().put("ua", webView.settings.userAgentString.take(120)))
				.put("timestamp", System.currentTimeMillis())
				.toString(),
		)
		// #endregion
		webView.addJavascriptInterface(JsBridge(), "DeskreenPlayer")
		webView.webViewClient =
			object : WebViewClient() {
				override fun shouldOverrideUrlLoading(
					view: WebView?,
					request: WebResourceRequest?,
				): Boolean {
					val url = request?.url?.toString() ?: return false
					if (isAllowedUrl(url)) {
						return false
					}
					Log.w(TAG, "blocked navigation: $url")
					if (lastVideoId.isNotBlank()) {
						loadVideo(lastVideoId)
					}
					return true
				}

				override fun onReceivedError(
					view: WebView?,
					request: WebResourceRequest?,
					error: android.webkit.WebResourceError?,
				) {
					super.onReceivedError(view, request, error)
					val url = request?.url?.toString() ?: return
					if (!url.contains("/watch") || !request.isForMainFrame) {
						return
					}
					if (lastVideoId.isBlank()) {
						return
					}
					Log.w(TAG, "watch page error, retrying: $url")
					mainHandler.postDelayed({
						if (lastVideoId.isBlank()) {
							return@postDelayed
						}
						if (errorRetryCount == 0) {
							errorRetryCount++
							softRecoverPlayback(lastKnownPlaybackTime)
						} else {
							errorRetryCount = 0
							loadVideo(lastVideoId)
						}
					}, 1200)
				}

				override fun doUpdateVisitedHistory(
					view: WebView?,
					url: String?,
					isReload: Boolean,
				) {
					super.doUpdateVisitedHistory(view, url, isReload)
					val normalized = url ?: return
					noteCurrentUrl(normalized)
					notifyInterstitialIfNeeded(normalized)
					if (normalized.contains("/watch")) {
						injectLayoutScriptIfWatch()
					}
					if (activeProgrammaticGeneration > 0 && normalized.contains("/watch")) {
						mainHandler.postDelayed({ activeProgrammaticGeneration = 0 }, 800)
						return
					}
					if (!isAllowedUrl(normalized)) {
						userNavigatedAway = true
					}
				}

				override fun onPageCommitVisible(
					view: WebView?,
					url: String?,
				) {
					super.onPageCommitVisible(view, url)
					if (url?.contains("/watch") == true) {
						injectLayoutScriptIfWatch()
					}
				}

				override fun onPageFinished(
					view: WebView?,
					url: String?,
				) {
					super.onPageFinished(view, url)
					isReady = true
					url?.let {
						noteCurrentUrl(it)
						notifyInterstitialIfNeeded(it)
					}
					if (
						url?.contains("youtube.com") == true &&
						!url.contains("accounts.google") &&
						YouTubeSessionHelper.isSignedIn()
					) {
						onYouTubeSignedInListener?.invoke()
						verifyYouTubePremium { premium ->
							val app = context.applicationContext as? PlayerApp
							if (app != null) {
								YouTubeSessionHelper.markPremiumVerified(app.preferences, premium)
							}
						}
					}
					if (url?.contains("/watch") == true) {
						isNavigating = false
						clearNavigationWatchdog()
						allowHomeLanding = false
						injectExpectedVideoId()
						// #region agent log
						dbgLog(
							"H2",
							"YouTubeKioskBridge.onPageFinished",
							"watch-page-finished",
							mapOf("url" to (url ?: ""), "lastVideoId" to lastVideoId),
						)
						// #endregion
						scheduleLayoutRefresh()
						applyVolumeAndPlay()
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

	private fun isAllowedUrl(url: String): Boolean {
		if (url == "about:blank") {
			return true
		}
		if (url.contains("/embed/")) {
			return false
		}
		val uri =
			try {
				Uri.parse(url)
			} catch (_: Exception) {
				return false
			}
		val host = uri.host?.lowercase() ?: return false
		if (
			host.contains("consent.youtube.com") ||
			host.contains("accounts.google.com") ||
			host.contains("google.com")
		) {
			return true
		}
		if (!host.contains("youtube.com") && !host.contains("youtu.be")) {
			return false
		}
		val path = uri.path?.lowercase() ?: ""
		if (
			path.contains("/shorts") ||
			path.contains("/results") ||
			path.contains("/feed") ||
			path.contains("/gaming") ||
			path.contains("/channel/")
		) {
			return false
		}
		if (path.contains("/watch") || url.contains("watch?v=")) {
			return true
		}
		if (allowHomeLanding && (path.isEmpty() || path == "/")) {
			return true
		}
		return false
	}

	override fun loadVideo(videoId: String) {
		if (videoId.isBlank()) {
			return
		}
		// #region agent log
		dbgLog(
			"H4",
			"YouTubeKioskBridge.loadVideo",
			"full-navigation",
			mapOf(
				"videoId" to videoId,
				"lastVideoId" to lastVideoId,
				"isNavigating" to isNavigating,
			),
		)
		// #endregion
		pendingVideoId = videoId
		if (videoId != lastVideoId) {
			lastKnownPlaybackTime = 0.0
		}
		lastVideoId = videoId
		errorRetryCount = 0
		isNavigating = true
		layoutScriptInjectedForUrl = ""
		allowHomeLanding = false
		userNavigatedAway = false
		programmaticNavGeneration++
		activeProgrammaticGeneration = programmaticNavGeneration
		mainHandler.post {
			hideCustomView()
			evalJs("window.__deskreenYtPause && window.__deskreenYtPause()")
			val url = "https://www.youtube.com/watch?v=$videoId"
			noteCurrentUrl(url)
			navigationRetryUrl = url
			scheduleNavigationWatchdog(url)
			Log.i(TAG, "loadVideo full navigation (no autoplay): $videoId")
			webView.loadUrl(url)
			injectExpectedVideoId()
		}
	}

	private fun scheduleNavigationWatchdog(url: String) {
		navigationWatchdog?.let { mainHandler.removeCallbacks(it) }
		val watchdog =
			Runnable {
				if (!isNavigating) {
					return@Runnable
				}
				readSnapshot { snap ->
					mainHandler.post {
						if (!isNavigating) {
							return@post
						}
						if (
							snap != null &&
							snap.hasVideo &&
							snap.videoId == lastVideoId &&
							snap.currentTime > 2.0
						) {
							Log.i(TAG, "navigation watchdog: playback ok, skip reload")
							isNavigating = false
							clearNavigationWatchdog()
							return@post
						}
						Log.w(TAG, "navigation watchdog: forcing reload $url")
						isNavigating = false
						webView.stopLoading()
						webView.loadUrl(url)
						isNavigating = true
						scheduleNavigationWatchdog(url)
					}
				}
			}
		navigationWatchdog = watchdog
		mainHandler.postDelayed(watchdog, NAVIGATION_TIMEOUT_MS)
	}

	private fun clearNavigationWatchdog() {
		navigationWatchdog?.let { mainHandler.removeCallbacks(it) }
		navigationWatchdog = null
	}

	private fun applyVolumeAndPlay() {
		setVolume(lastVolumeLevel)
		mainHandler.postDelayed({
			evalJs(
				"window.__deskreenYtReapplyVolume && window.__deskreenYtReapplyVolume();" +
					"window.__deskreenYtEnsurePlaying && window.__deskreenYtEnsurePlaying()",
			)
		}, 200)
	}

	private fun noteCurrentUrl(url: String) {
		lastKnownUrl = url
	}

	override fun needsVideoLoad(videoId: String): Boolean {
		if (videoId.isBlank()) {
			return false
		}
		if (lastVideoId == videoId && lastKnownPlaybackTime > 1.0 && isReady) {
			return false
		}
		if (lastVideoId == videoId && isReady && !userNavigatedAway) {
			return false
		}
		if (lastVideoId != videoId) {
			return true
		}
		if (!isReady || userNavigatedAway) {
			return true
		}
		val url = lastKnownUrl
		if (url.isBlank() || url == "about:blank") {
			return true
		}
		return !url.contains("/watch")
	}

	private fun injectExpectedVideoId() {
		if (lastVideoId.isBlank()) {
			return
		}
		evalJs(
			"window.__deskreenYtExpectedVideoId='$lastVideoId';" +
				"if(window.__deskreenYtResetEndedTracking) window.__deskreenYtResetEndedTracking();",
		)
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
		lastVolumeLevel = level.coerceIn(0.0, 1.0)
		evalJs("window.__deskreenVolumeLevel=$lastVolumeLevel;window.__deskreenYtSetVolume && window.__deskreenYtSetVolume($lastVolumeLevel)")
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
				val snap =
					PlayerSnapshot(
						state = json.optInt("state", 3),
						videoId = json.optString("videoId"),
						title = json.optString("title"),
						currentTime = json.optDouble("currentTime"),
						duration = json.optDouble("duration"),
						paused = json.optBoolean("paused"),
						ended = json.optBoolean("ended"),
						hasVideo = json.optBoolean("hasVideo"),
						layoutOk = json.optBoolean("layoutOk", true),
						videoTopPx = json.optInt("videoTopPx", 0),
					)
				if (snap.hasVideo && snap.currentTime >= 0) {
					lastKnownPlaybackTime = snap.currentTime
				}
				callback(snap)
			} catch (_: Exception) {
				callback(null)
			}
		}
	}

	fun reloadAfterCrash() {
		if (lastVideoId.isNotBlank()) {
			if (lastKnownPlaybackTime > 1.0) {
				softRecoverPlayback(lastKnownPlaybackTime)
			} else {
				loadVideo(lastVideoId)
			}
		}
	}

	/** Resume playback without reloading the YouTube page (preserves position). */
	fun softRecoverPlayback(seekTo: Double? = null) {
		val target = seekTo?.takeIf { it > 0.25 } ?: lastKnownPlaybackTime
		mainHandler.post {
			hideCustomView()
			if (target > 0.25) {
				evalJs(
					"window.__deskreenYtSoftRecover && window.__deskreenYtSoftRecover($target)",
				)
			} else {
				evalJs("window.__deskreenYtSoftRecover && window.__deskreenYtSoftRecover()")
			}
			applyVolumeAndPlay()
		}
	}

	fun verifyYouTubePremium(callback: (Boolean) -> Unit) {
		evalJs(YouTubeSessionHelper.PREMIUM_CHECK_JS) { raw ->
			val result = raw?.trim()?.trim('"')?.lowercase()
			callback(result == "true")
		}
	}

	private fun buildTrustedUserAgent(): String {
		// Desktop Chrome (no DeskreenPlayer suffix): YouTube serves ytd-watch-flexy + theater mode.
		// Default Android WebView UA gets the mobile watch page (no flexy, playlist visible).
		return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
			"(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
	}

	override fun getLastKnownPlaybackTime(): Double = lastKnownPlaybackTime

	fun destroy() {
		pollRunnable?.let { mainHandler.removeCallbacks(it) }
		cancelPendingLayoutRefresh()
	}

	private fun notifyInterstitialIfNeeded(url: String) {
		val lower = url.lowercase()
		if (
			lower.contains("consent.youtube") ||
			lower.contains("accounts.google") ||
			(lower.contains("google.com") && !lower.contains("youtube.com/watch"))
		) {
			onInterstitialListener?.invoke(url)
		}
	}

	private fun hideCustomView() {
		val view = customView ?: return
		rootLayout.removeView(view)
		customView = null
		customViewCallback?.onCustomViewHidden()
		customViewCallback = null
		webView.visibility = android.view.View.VISIBLE
		onRequestImmersiveMode?.invoke()
	}

	private var layoutScriptInjectedForUrl: String = ""

	private fun injectLayoutScriptIfWatch() {
		val url = lastKnownUrl
		if (!url.contains("/watch")) {
			return
		}
		if (url == layoutScriptInjectedForUrl && layoutRefreshGeneration > 0) {
			return
		}
		layoutScriptInjectedForUrl = url
		injectLayoutScript()
	}

	private fun scheduleLayoutRefresh() {
		val generation = ++layoutRefreshGeneration
		injectLayoutScriptIfWatch()
		for (delayMs in listOf(800L, 2000L)) {
			mainHandler.postDelayed({
				if (generation != layoutRefreshGeneration) {
					return@postDelayed
				}
				refreshLayoutOnly()
			}, delayMs)
		}
	}

	private fun refreshLayoutOnly() {
		// #region agent log
		dbgLog("H2", "YouTubeKioskBridge.refreshLayoutOnly", "apply-layout-only", emptyMap())
		// #endregion
		webView.evaluateJavascript("window.__deskreenVolumeLevel = $lastVolumeLevel;", null)
		webView.evaluateJavascript(
			"window.__deskreenYtReapplyVolume && window.__deskreenYtReapplyVolume();" +
				"window.__deskreenYtApplyLayout && window.__deskreenYtApplyLayout()",
			null,
		)
		injectExpectedVideoId()
	}

	private fun injectLayoutScript() {
		// #region agent log
		dbgLog("H2", "YouTubeKioskBridge.injectLayoutScript", "reinject-layout-script", emptyMap())
		// #endregion
		webView.evaluateJavascript("window.__deskreenYtPlayerMode = true;", null)
		webView.evaluateJavascript("window.__deskreenVolumeLevel = $lastVolumeLevel;", null)
		webView.evaluateJavascript(layoutScript, null)
		injectExpectedVideoId()
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

	fun onPause() {
		YouTubeSessionHelper.flush()
	}

	private fun startPolling() {
		val runnable =
			object : Runnable {
				override fun run() {
					readSnapshot { snap ->
						if (snap != null) {
							PlayerApp.instance?.applySnapshot(snap)
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
			if (message.startsWith("DBG|")) {
				Log.i("DeskreenDbg", message.removePrefix("DBG|"))
			} else {
				Log.d(TAG, message)
			}
		}

		@JavascriptInterface
		fun onPlaybackEnded(videoId: String) {
			mainHandler.post {
				if (
					!isNavigating &&
					videoId.isNotBlank() &&
					videoId == lastVideoId
				) {
					onEndedListener?.invoke()
				}
			}
		}

		@JavascriptInterface
		fun onUnexpectedVideoId(foundId: String) {
			mainHandler.post {
				if (
					foundId.isBlank() ||
					foundId == lastVideoId ||
					isNavigating
				) {
					return@post
				}
				Log.w(TAG, "unexpected video id: $foundId expected $lastVideoId — soft recover")
				softRecoverPlayback(lastKnownPlaybackTime)
			}
		}
	}

	companion object {
		private const val TAG = "YouTubeKioskBridge"
		private const val POLL_MS = 500L
		private const val NAVIGATION_TIMEOUT_MS = 32_000L

		// #region agent log
		private fun dbgLog(
			hypothesisId: String,
			location: String,
			message: String,
			data: Map<String, Any?>,
		) {
			val payload =
				JSONObject()
					.put("sessionId", "25b906")
					.put("hypothesisId", hypothesisId)
					.put("location", location)
					.put("message", message)
					.put("data", JSONObject(data))
					.put("timestamp", System.currentTimeMillis())
			Log.i("DeskreenDbg", payload.toString())
		}
		// #endregion
	}
}
