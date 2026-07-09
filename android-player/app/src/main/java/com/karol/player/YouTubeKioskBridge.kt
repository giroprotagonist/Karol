package com.karol.player

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.CookieManager
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
	private var lastEndedFireVideoId: String = ""
	private var pendingVideoId: String = ""
	private var isNavigating = false
	private var customView: android.view.View? = null
	private var customViewCallback: WebChromeClient.CustomViewCallback? = null
	private var onEndedListener: (() -> Unit)? = null
	private var onInterstitialListener: ((String) -> Unit)? = null
	private var onUnexpectedVideoIdListener: ((String) -> Unit)? = null
	private var onYouTubeSignedInListener: (() -> Unit)? = null
	var onLoadingStateChanged: ((Boolean) -> Unit)? = null
	private var pollRunnable: Runnable? = null
	private var layoutRefreshGeneration = 0
	private var programmaticNavGeneration = 0
	private var activeProgrammaticGeneration = 0
	private var userNavigatedAway = false
	@Volatile
	private var lastKnownUrl: String = ""
	private var lastVolumeLevel: Double = 1.0
	private var navigationWatchdog: Runnable? = null
	private var navigationWatchdogRetries = 0
	private var navigationRetryUrl: String = ""
	private var premiumCheckDone = false
	private var lastKnownPlaybackTime: Double = 0.0
	private var errorRetryCount = 0
	private var lastCustomViewToggle: Long = 0
	private var lastKnownDuration: Double = 0.0
	private var lastKnownCurrentTime: Double = 0.0
	var allowHomeLanding = false
		private set

	private var signInMode = false
	private var signInPollRunnable: Runnable? = null
	private var signInPollStartMs: Long = 0
	private var signInOnComplete: ((Boolean?) -> Unit)? = null
	private var onSignInProgressListener: ((SignInStep) -> Unit)? = null

	enum class SignInStep {
		OPENING_GOOGLE,
		SIGNING_IN,
		COOKIES_DETECTED,
		CHECKING_PREMIUM,
		PREMIUM_CONFIRMED,
		NO_PREMIUM,
		TIMEOUT,
	}

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

	fun setOnSignInProgressListener(listener: (SignInStep) -> Unit) {
		onSignInProgressListener = listener
	}

	/**
	 * Enter self-contained WebView sign-in mode with cookie polling.
	 * Clears all cookies and cache for a fresh start, then loads the
	 * Google sign-in page in the WebView.  Polls every 500 ms for
	 * auth cookies, up to 120 s.  Handles Multi-Account UI, 2FA, and
	 * any redirect chain Google throws at it.
	 */
	fun enterSignInMode(onComplete: (premium: Boolean?) -> Unit) {
		signInMode = true
		signInOnComplete = onComplete
		premiumCheckDone = false
		allowHomeLanding = true
		userNavigatedAway = false

		// Fresh start — no stale cookies from previous attempts
		webView.clearCache(true)
		try {
			val cm = CookieManager.getInstance()
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
				cm.removeAllCookies(null)
			} else {
				@Suppress("DEPRECATION")
				cm.removeAllCookie()
			}
			// Pre-inject consent cookie to avoid YouTube/Google consent dialogs
			cm.setCookie("https://www.youtube.com", "CONSENT=YES+; Domain=.youtube.com; Path=/")
			cm.setCookie("https://youtube.com", "CONSENT=YES+; Domain=.youtube.com; Path=/")
			cm.setCookie("https://m.youtube.com", "CONSENT=YES+; Domain=.youtube.com; Path=/")
			cm.flush()
		} catch (e: Exception) {
			Log.w(TAG, "cookie clear during sign-in", e)
		}

		onSignInProgressListener?.invoke(SignInStep.OPENING_GOOGLE)
		mainHandler.post {
			hideCustomView()
			webView.visibility = android.view.View.VISIBLE
			webView.loadUrl(YouTubeSessionHelper.signInUrl())
		}

		// Start cookie poll loop
		signInPollStartMs = System.currentTimeMillis()
		startSignInPoll(onComplete)
	}

	/** Stop the sign-in poll and release sign-in-mode state. */
	fun exitSignInMode(ok: Boolean, onComplete: (premium: Boolean?) -> Unit) {
		signInPollRunnable?.let { mainHandler.removeCallbacks(it) }
		signInPollRunnable = null
		signInMode = false
		signInOnComplete = null
		allowHomeLanding = false
		if (ok) {
			onSignInProgressListener?.invoke(SignInStep.CHECKING_PREMIUM)
			verifyYouTubePremium { premium ->
				onSignInProgressListener?.invoke(
					if (premium) SignInStep.PREMIUM_CONFIRMED else SignInStep.NO_PREMIUM,
				)
				onComplete(premium)
			}
		} else {
			onComplete(null)
		}
	}

	private fun startSignInPoll(onComplete: (premium: Boolean?) -> Unit) {
		signInPollRunnable?.let { mainHandler.removeCallbacks(it) }
		val runnable =
			object : Runnable {
				override fun run() {
					if (!signInMode) return
					// Flush cookies to ensure Set-Cookie headers are persisted
					YouTubeSessionHelper.flush()
					val elapsed = System.currentTimeMillis() - signInPollStartMs
					if (elapsed > SIGN_IN_TIMEOUT_MS) {
						Log.w(TAG, "sign-in poll: timed out after ${elapsed}ms")
						signInPollRunnable = null
						onSignInProgressListener?.invoke(SignInStep.TIMEOUT)
						// Defer mode exit to let caller handle UI
						mainHandler.post { exitSignInMode(false, onComplete) }
						return
					}
					if (YouTubeSessionHelper.isSignedIn()) {
						Log.i(TAG, "sign-in poll: cookies detected after ${elapsed}ms")
						onSignInProgressListener?.invoke(SignInStep.COOKIES_DETECTED)
						signInPollRunnable = null
						mainHandler.post { exitSignInMode(true, onComplete) }
						return
					}
					// URL-based progress: if we're on accounts.google.com, try to nudge
					// the consent/challenge dialog every few poll cycles
					val currentUrl = webView.url ?: ""
					if (currentUrl.contains("accounts.google.com")) {
						if (elapsed > 3_000L && elapsed % 5_000L < SIGN_IN_POLL_INTERVAL_MS) {
							dismissGoogleSignInPrompts()
						}
						if (elapsed > 8000L) {
							// Periodic scan for Google "blocked" error page
							scanForGoogleBlockedPage()
						}
					}
					signInPollRunnable = this
					mainHandler.postDelayed(this, SIGN_IN_POLL_INTERVAL_MS)
				}
			}
		signInPollRunnable = runnable
		mainHandler.postDelayed(runnable, SIGN_IN_POLL_INTERVAL_MS)
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
			webView.loadUrl("https://www.youtube.com/")
		}
	}

	fun prepareForStop() {
		cancelPendingLayoutRefresh()
		userNavigatedAway = false
		allowHomeLanding = false
		activeProgrammaticGeneration = 0
		pause()
		exitFullscreen()
	}

	@SuppressLint("SetJavaScriptEnabled")
	private fun configureWebView() {
		webView.setBackgroundColor(Color.BLACK)
		webView.settings.apply {
			javaScriptEnabled = true
			domStorageEnabled = true
			mediaPlaybackRequiresUserGesture = false
			javaScriptCanOpenWindowsAutomatically = true
			loadWithOverviewMode = true
			useWideViewPort = true
			cacheMode = WebSettings.LOAD_DEFAULT
			mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
			userAgentString = buildTrustedUserAgent()
		}
		webView.addJavascriptInterface(JsBridge(), "KarolPlayer")
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
					// During sign-in mode, never fire recovery — doing so
					// destroys Google's auth redirect chain mid-sign-in.
					if (signInMode) {
						Log.d(TAG, "signInMode: allowing blocked URL to proceed: $url")
						return false
					}
					// YouTube's player JS fires programmatic navigations during normal
					// playback (autoplay suggestions, end-screen links, internal state
					// transitions).  Blocking every non-watch URL and force-reloading
					// the current video causes random restarts.
					// Only recover if the current page is actually lost — i.e. a main-
					// frame navigation away from /watch has already completed.
					val isMainFrame = request?.isForMainFrame ?: false
					val currentUrl = webView.url ?: ""
				if (!currentUrl.contains("/watch") || isMainFrame) {
						Log.w(TAG, "recovering from blocked navigation: $url (mainFrame=$isMainFrame)")
						if (lastVideoId.isNotBlank() && currentUrl != "about:blank") {
							userNavigatedAway = false
							mainHandler.post { loadVideo(lastVideoId) }
						}
					} else {
						Log.d(TAG, "ignoring blocked sub-navigation on video page: $url")
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
					// During sign-in mode, any main-frame error is fatal
					if (signInMode && request.isForMainFrame) {
						Log.w(TAG, "signInMode: page error for $url, aborting sign-in")
						val cb = signInOnComplete
						if (cb != null) {
							mainHandler.post { exitSignInMode(false, cb) }
						}
						return
					}
				if (!url.contains("/watch") || !request.isForMainFrame) {
						return
					}
					if (lastVideoId.isBlank()) {
						return
					}
					onLoadingStateChanged?.invoke(false)
					Log.w(TAG, "video page error, retrying: $url")
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
					// YouTube is a SPA — pushState fires for internal routing that may
					// land on non-allowed URLs (channels, home, etc.) without the user
					// actually navigating away from the watch page.  Only mark
					// userNavigatedAway when the current URL genuinely leaves /watch.
					if (!normalized.contains("/watch") && !normalized.contains("/embed/") &&
						webView.url?.contains("/watch") != true) {
						userNavigatedAway = true
					}
				}

				override fun onPageCommitVisible(
					view: WebView?,
					url: String?,
				) {
					super.onPageCommitVisible(view, url)
					if (url?.contains("/watch") == true || url?.contains("/embed/") == true) {
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
						// Auto-dismiss YouTube consent dialog
						if (it.contains("consent.youtube")) {
							webView.evaluateJavascript(
								"(function(){" +
								"var btns=document.querySelectorAll('button');" +
								"for(var i=0;i<btns.length;i++){" +
								"var t=(btns[i].textContent||'').trim().toLowerCase();" +
								"var a=(btns[i].getAttribute('aria-label')||'').toLowerCase();" +
								"if(t.includes('accept')||t.includes('agree')||t.includes('allow')||" +
								"a.includes('accept')||a.includes('agree')){" +
								"btns[i].click();break;" +
								"}}" +
								// Fallback: submit form
								"if(!document.querySelector('button[clicked]')){" +
								"var f=document.querySelector('form');if(f)f.submit();" +
								"}})()",
								null,
							)
							// Also try again after a short delay
							mainHandler.postDelayed({
								webView.evaluateJavascript(
									"(function(){" +
									"var btns=document.querySelectorAll('button');" +
									"for(var i=0;i<btns.length;i++){" +
									"var t=(btns[i].textContent||'').trim().toLowerCase();" +
									"if(t.includes('accept')||t.includes('agree')){" +
									"btns[i].click();return;" +
									"}}})()",
									null,
								)
							}, 1000)
						}
						// --- Sign-in mode page detection ---
						if (signInMode) {
							// Success: youtube.com loaded with auth cookies present
							if (it.contains("youtube.com") &&
								!it.contains("accounts.google") &&
								YouTubeSessionHelper.isSignedIn()
							) {
								Log.i(TAG, "signInMode: youtube.com landed with cookies, completing sign-in")
								val cb = signInOnComplete
								if (cb != null) {
									onSignInProgressListener?.invoke(SignInStep.COOKIES_DETECTED)
									mainHandler.post { exitSignInMode(true, cb) }
								}
							}
							// Google sign-in page consent/challenge auto-dismiss
							if (it.contains("accounts.google.com")) {
								dismissGoogleSignInPrompts()
							}
							// Scan for Google "blocked" error page
							scanForGoogleBlockedPage()
						}
					}
					if (
						!signInMode &&
						!premiumCheckDone &&
						url?.contains("youtube.com") == true &&
						!url.contains("accounts.google") &&
						YouTubeSessionHelper.isSignedIn()
					) {
						premiumCheckDone = true
						onYouTubeSignedInListener?.invoke()
						verifyYouTubePremium { premium ->
							val app = context.applicationContext as? PlayerApp
							if (app != null) {
								YouTubeSessionHelper.markPremiumVerified(app.preferences, premium)
							}
						}
					}
					if (url?.contains("/watch") == true || url?.contains("/embed/") == true) {
						isNavigating = false
						clearNavigationWatchdog()
						allowHomeLanding = false
						injectExpectedVideoId()
						scheduleLayoutRefresh()
						applyVolumeAndPlay()
						onLoadingStateChanged?.invoke(false)
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
					// Debounce: ignore toggles within 1000ms to prevent SurfaceView flicker between songs
					val now = System.currentTimeMillis()
					if (now - lastCustomViewToggle < 1000) {
						callback?.onCustomViewHidden()
						return
					}
					lastCustomViewToggle = now
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
					val now = System.currentTimeMillis()
					if (now - lastCustomViewToggle < 1000) {
						return
					}
					lastCustomViewToggle = now
					hideCustomView()
				}
			}
	}

	private fun isAllowedUrl(url: String): Boolean {
		if (url == "about:blank") {
			return true
		}
		if (url.contains("/embed/")) {
			return true
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
			// Allow consent/sign-in pages to load so the JS dismisser can click accept
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
		pendingVideoId = videoId
		if (videoId != lastVideoId) {
			lastKnownPlaybackTime = 0.0
		}
		lastVideoId = videoId
		lastEndedFireVideoId = ""
		errorRetryCount = 0
		isNavigating = true
		onLoadingStateChanged?.invoke(true)
		layoutScriptInjectedForUrl = ""
		allowHomeLanding = false
		userNavigatedAway = false
		programmaticNavGeneration++
		activeProgrammaticGeneration = programmaticNavGeneration
		mainHandler.post {
			hideCustomView()
			evalJs("window.__deskreenYtPause && window.__deskreenYtPause()")
			// Exit fullscreen before navigating to prevent SurfaceView linger from previous video
			evalJs("(function(){" +
				"if(document.exitFullscreen)document.exitFullscreen().catch(function(){});" +
				"if(document.webkitExitFullscreen)document.webkitExitFullscreen();" +
				"})()", null)
			val url = "https://www.youtube.com/watch?v=${videoId}"
			noteCurrentUrl(url)
			navigationRetryUrl = url
			scheduleNavigationWatchdog(url)
			Log.i(TAG, "loadVideo full navigation: $videoId")
			webView.loadUrl(url)
			injectExpectedVideoId()
		}
	}

	private fun scheduleNavigationWatchdog(url: String) {
		navigationWatchdog?.let { mainHandler.removeCallbacks(it) }
		val watchdog =
			Runnable {
				navigationWatchdogRetries++
				if (navigationWatchdogRetries > MAX_NAVIGATION_WATCHDOG_RETRIES) {
					Log.e(TAG, "navigation watchdog: exceeded ${MAX_NAVIGATION_WATCHDOG_RETRIES} retries, giving up")
					isNavigating = false
					clearNavigationWatchdog()
					navigationWatchdogRetries = 0
					onLoadingStateChanged?.invoke(false)
					return@Runnable
				}
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
						Log.w(TAG, "navigation watchdog: forcing reload $url (retry ${navigationWatchdogRetries}/${MAX_NAVIGATION_WATCHDOG_RETRIES})")
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
		// Dispatch a simulated touch to satisfy WebView's user-gesture requirement,
		// then trigger play and request fullscreen in close succession.
		mainHandler.postDelayed({
			val wv = webView
			if (wv.width > 0 && wv.height > 0) {
				val centerX = (wv.width / 2).toFloat()
				val centerY = (wv.height / 2).toFloat()
				val downTime = System.currentTimeMillis()
				val down = android.view.MotionEvent.obtain(
					downTime, downTime, android.view.MotionEvent.ACTION_DOWN, centerX, centerY, 0,
				)
				val up = android.view.MotionEvent.obtain(
					downTime, downTime + 100, android.view.MotionEvent.ACTION_UP, centerX, centerY, 0,
				)
				wv.dispatchTouchEvent(down)
				wv.dispatchTouchEvent(up)
				down.recycle()
				up.recycle()
			}
			evalJs(
				"window.__deskreenYtReapplyVolume && window.__deskreenYtReapplyVolume();" +
					"window.__deskreenYtEnsurePlaying && window.__deskreenYtEnsurePlaying()",
			)
		}, 200)
		// Request fullscreen shortly after user gesture. YouTube native fullscreen
		// triggers onShowCustomView → video renders on a native SurfaceView,
		// bypassing WebView compositing entirely for edge-to-edge video.
		mainHandler.postDelayed({
			evalJs(
				"(function(){" +
				"var v=document.querySelector('video');" +
				"if(v&&v.requestFullscreen){v.requestFullscreen().catch(function(){});}" +
				"})()",
			)
		}, 500)
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
		val clamped = level.coerceIn(0.0, 1.0)
		lastVolumeLevel = clamped
		evalJs("window.__deskreenVolumeLevel = $clamped; window.__deskreenYtReapplyVolume && window.__deskreenYtReapplyVolume()")
	}

	override fun getSnapshot(): PlayerSnapshot? = null

	fun readSnapshot(callback: (PlayerSnapshot?) -> Unit) {
		evalJs(
			"window.__deskreenYtReadSnapshot && window.__deskreenYtReadSnapshot()",
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
						thumbnail = json.optString("thumbnail", ""),
					)
				if (snap.hasVideo && snap.currentTime >= 0) {
					lastKnownPlaybackTime = snap.currentTime
				}
				if (snap.duration > 0) {
					lastKnownDuration = snap.duration
				}
				if (snap.currentTime >= 0) {
					lastKnownCurrentTime = snap.currentTime
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
		val target = if (seekTo != null && seekTo > 0.25) {
			"Math.min($seekTo, v.duration ? 0 - 0.5)"
		} else "0"
		if (seekTo != null && seekTo > 0) {
			evalJs(
				"window.__deskreenYtSoftRecover && window.__deskreenYtSoftRecover($target)",
			)
		} else {
			evalJs("window.__deskreenYtSoftRecover && window.__deskreenYtSoftRecover()")
		}
		applyVolumeAndPlay()
	}

	fun verifyYouTubePremium(callback: (Boolean) -> Unit) {
		Log.i(TAG, "verifyYouTubePremium: starting premium check (attempts up to $MAX_PREMIUM_CHECK_ATTEMPTS)")
		tryCheckPremium(0, callback)
	}

	private fun tryCheckPremium(
		attempt: Int,
		callback: (Boolean) -> Unit,
	) {
		evalJs(YouTubeSessionHelper.PREMIUM_CHECK_JS) { raw ->
			val result = raw?.trim()?.trim('"')?.lowercase()
			Log.i(TAG, "tryCheckPremium attempt=$attempt raw=$raw result=$result")
			if (result == "true" || attempt >= MAX_PREMIUM_CHECK_ATTEMPTS) {
				callback(result == "true")
			} else {
				mainHandler.postDelayed(
					{ tryCheckPremium(attempt + 1, callback) },
					PREMIUM_CHECK_RETRY_MS,
				)
			}
		}
	}

	private fun buildTrustedUserAgent(): String {
		// Android Chrome — YouTube trusts it (no bot detection), Premium detected.
		// Transparent WebView + CSS fixes hardware video surface visibility.
		return "Mozilla/5.0 (Linux; Android 14; SM-X700) AppleWebKit/537.36 " +
			"(KHTML, like Gecko) Chrome/131.0.6778.135 Mobile Safari/537.36"
	}

	override fun getLastKnownPlaybackTime(): Double = lastKnownPlaybackTime

	fun destroy() {
		pollRunnable?.let { mainHandler.removeCallbacks(it) }
		signInPollRunnable?.let { mainHandler.removeCallbacks(it) }
		signInPollRunnable = null
		signInMode = false
		signInOnComplete = null
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
		webView.evaluateJavascript("window.__deskreenVolumeLevel = $lastVolumeLevel;", null)
		webView.evaluateJavascript(
			"window.__deskreenYtReapplyVolume && window.__deskreenYtReapplyVolume();" +
				"window.__deskreenYtApplyLayout && window.__deskreenYtApplyLayout()",
			null,
		)
		injectExpectedVideoId()
	}

	private fun injectLayoutScript() {
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
							// Poll-based ended watchdog — YouTube autoplay races with
							// the JS ended event; detect ended from the readback snapshot.
							val endedDetected = snap.ended
							val stateEndedOrStopped = snap.state == 0
							val timeIsNull = snap.currentTime <= 0.0 && snap.state == 0
							val videoMatches = snap.videoId.isNotBlank() &&
								snap.videoId == lastVideoId &&
								snap.videoId != lastEndedFireVideoId
							if ((endedDetected || stateEndedOrStopped || timeIsNull) && videoMatches) {
								lastEndedFireVideoId = snap.videoId
								Log.i(TAG, "poll watchdog: ended detected for ${snap.videoId} (ended=${endedDetected} state=${snap.state} time=${snap.currentTime})")
								onEndedListener?.invoke()
							}
						}
					}
					// Speed up polling near end of video to catch brief ended window
					val pollDelay = if (lastKnownDuration > 0 && lastKnownCurrentTime > 0 &&
						(lastKnownDuration - lastKnownCurrentTime) < 15000) 250L else 500L
					mainHandler.postDelayed(this, pollDelay)
				}
			}
		pollRunnable = runnable
		mainHandler.postDelayed(runnable, POLL_MS)
	}

	inner class JsBridge {
		@JavascriptInterface
		fun log(message: String) {
			if (message.startsWith("DBG|")) {
				Log.i("KarolDbg", message.removePrefix("DBG|"))
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

	// --- Sign-in mode helpers ---

	/**
	 * Auto-dismiss Google sign-in consent/challenge prompts on accounts.google.com.
	 * Only targets consent-style buttons, NOT credential-entry forms (email/password).
	 */
	private fun dismissGoogleSignInPrompts() {
		// Attempt to click common consent/approval buttons
		webView.evaluateJavascript(
			"(function(){" +
			"var btns=document.querySelectorAll('button, input[type=submit], [role=button]');" +
			"for(var i=0;i<btns.length;i++){" +
			"var el=btns[i];" +
			"var t=(el.textContent||el.value||'').trim().toLowerCase();" +
			"var a=(el.getAttribute('aria-label')||'').toLowerCase();" +
			"// Only target consent/approval, never credential fields" +
			"var isConsent=t.includes('i agree')||t.includes('allow')||" +
			"t.includes('accept all')||t.includes('continue')||" +
			"t.includes('confirm')||t.includes('yes')||" +
			"a.includes('i agree')||a.includes('allow')||a.includes('accept');" +
			"var isNext=t==='next'||a==='next';" +
			"if(isConsent||isNext){" +
			"try{el.click();return;}catch(e){}" +
			"}}" +
			"// Fallback: form-based consent" +
			"var f=document.querySelector('form');" +
			"if(f&&!document.querySelector('input[type=email],input[type=password]')){" +
			"try{f.submit();}catch(e){}" +
			"}})()",
			null,
		)
		// Retry after delay for dynamic content
		mainHandler.postDelayed({
			webView.evaluateJavascript(
				"(function(){" +
				"var btns=document.querySelectorAll('button, input[type=submit], [role=button]');" +
				"for(var i=0;i<btns.length;i++){" +
				"var t=(btns[i].textContent||btns[i].value||'').trim().toLowerCase();" +
				"if(t.includes('accept')||t.includes('agree')||t.includes('allow')||" +
				"t.includes('continue')||t.includes('confirm')){" +
				"btns[i].click();return;}}})()",
				null,
			)
		}, 1500)
	}

	/**
	 * Scan the current page for Google "disallowed_useragent" or
	 * "insecure browser" blocking messages.  If detected, abort sign-in
	 * so the caller can fall back to device account sign-in.
	 */
	private fun scanForGoogleBlockedPage() {
		webView.evaluateJavascript(
			"(function(){" +
			"var b=document.body;if(!b)return'ok';" +
			"var t=(b.innerText||b.textContent||'').toLowerCase();" +
			"if(t.includes('disallowed_useragent')||" +
			"t.includes('browser or app may not be secure')||" +
			"t.includes('not a supported browser')||" +
			"t.includes('couldn\\'t sign you in')||" +
			"t.includes('this browser is not supported'))" +
			"return'blocked';" +
			"return'ok';" +
			"})()",
		) { raw ->
			if (raw == "\"blocked\"") {
				Log.w(TAG, "signInMode: Google blocked sign-in page")
				val cb = signInOnComplete
				if (cb != null) {
					onSignInProgressListener?.invoke(SignInStep.TIMEOUT)
					mainHandler.post { exitSignInMode(false, cb) }
				}
			}
		}
	}

	companion object {
		private const val TAG = "YouTubeKioskBridge"
		private const val POLL_MS = 500L
		private const val NAVIGATION_TIMEOUT_MS = 32_000L
		private const val MAX_PREMIUM_CHECK_ATTEMPTS = 4
		private const val PREMIUM_CHECK_RETRY_MS = 1500L
		private const val MAX_NAVIGATION_WATCHDOG_RETRIES = 3
		private const val SIGN_IN_POLL_INTERVAL_MS = 500L
		private const val SIGN_IN_TIMEOUT_MS = 120_000L
	}
}
