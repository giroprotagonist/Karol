package com.karol.player

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import java.io.File
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import com.google.android.material.button.MaterialButton
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {
	private lateinit var webView: WebView
	private lateinit var rootLayout: FrameLayout
	private lateinit var startPanel: View
	private lateinit var loadingOverlay: FrameLayout
	private lateinit var hostInfoText: TextView
	private lateinit var controllerUrlText: TextView
	private lateinit var statusText: TextView
	private lateinit var errorText: TextView
	private lateinit var youtubeAccountText: TextView
	private lateinit var signInYouTubeButton: MaterialButton
	private lateinit var qrCodeImage: ImageView
	private lateinit var autoBootSwitch: android.widget.Switch
	private var bridge: YouTubeKioskBridge? = null
	private var showStarted = false
	private var pendingShowAfterSession = false
	private lateinit var reauthOverlay: View
	private lateinit var signInProgressOverlay: View
	private lateinit var signInProgressTitle: TextView
	private lateinit var signInProgressSubtitle: TextView
	private lateinit var signInSpinner: android.widget.ProgressBar
	private lateinit var signInRetryButton: MaterialButton
	private lateinit var signInCancelButton: MaterialButton
	private var signInInProgress = false
	private lateinit var backCallback: OnBackPressedCallback
	private val statusHandler = Handler(Looper.getMainLooper())
	private val mainHandler = Handler(Looper.getMainLooper())
	private var statusRunnable: Runnable? = null

	// Immersive mode re-enforcer (YouTube tends to restore nav bars)
	private var immersiveJob: Job? = null

	// --- ExoPlayer for local video playback ---
	private var exoPlayer: ExoPlayer? = null
	private lateinit var playerView: PlayerView
	private lateinit var videoDownloadManager: VideoDownloadManager
	private var localPlaybackActive = false
	private var currentLocalVideoId: String? = null

	private val notificationPermissionLauncher =
		registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

	private val importSessionLauncher =
		registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
			if (uri == null) return@registerForActivityResult
			try {
				val raw =
					contentResolver.openInputStream(uri)?.use { stream ->
						stream.bufferedReader().readText()
					} ?: return@registerForActivityResult
				if (YouTubeSessionBackup.importJson(raw)) {
					completeYouTubeSignIn()
					if (pendingShowAfterSession) {
						pendingShowAfterSession = false
						startShow()
					}
					Toast.makeText(this, R.string.youtube_session_import_ok, Toast.LENGTH_LONG).show()
				} else {
					Toast.makeText(this, R.string.youtube_session_import_fail, Toast.LENGTH_LONG).show()
				}
			} catch (_: Exception) {
				Toast.makeText(this, R.string.youtube_session_import_fail, Toast.LENGTH_LONG).show()
			}
		}

	@SuppressLint("SetJavaScriptEnabled")
	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		// Must be called BEFORE setContentView to push content under system bars
		WindowCompat.setDecorFitsSystemWindows(window, false)
		window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
		setContentView(R.layout.activity_main)
		enterImmersiveMode()

		val app = application as PlayerApp
		rootLayout = findViewById(R.id.rootLayout)
		webView = findViewById(R.id.webView)
		startPanel = findViewById(R.id.startPanel)
		loadingOverlay = findViewById(R.id.loadingOverlay)
		hostInfoText = findViewById(R.id.hostInfoText)
		controllerUrlText = findViewById(R.id.controllerUrlText)
		statusText = findViewById(R.id.statusText)
		errorText = findViewById(R.id.errorText)
		youtubeAccountText = findViewById(R.id.youtubeAccountText)
		signInYouTubeButton = findViewById(R.id.signInYouTubeButton)
		qrCodeImage = findViewById(R.id.qrCodeImage)
		autoBootSwitch = findViewById(R.id.autoBootSwitch)
		reauthOverlay = findViewById(R.id.reauthOverlay)
		signInProgressOverlay = findViewById(R.id.signInProgressOverlay)
		signInProgressTitle = findViewById(R.id.signInProgressTitle)
		signInProgressSubtitle = findViewById(R.id.signInProgressSubtitle)
		signInSpinner = findViewById(R.id.signInSpinner)
		signInRetryButton = findViewById(R.id.signInRetryButton)
		signInCancelButton = findViewById(R.id.signInCancelButton)

		playerView = findViewById(R.id.playerView)
		videoDownloadManager = VideoDownloadManager(this)

		initExoPlayer()

		findViewById<MaterialButton>(R.id.reauthButton).setOnClickListener {
			beginYouTubeSignIn()
		}
		findViewById<MaterialButton>(R.id.reauthStopShowButton).setOnClickListener {
			reauthOverlay.visibility = View.GONE
			stopShow()
		}
		signInRetryButton.setOnClickListener {
			hideSignInProgressOverlay()
			beginYouTubeSignIn()
		}
		signInCancelButton.setOnClickListener {
			cancelSignIn()
		}

		app.onRequestStartShow = { runOnUiThread { ensureShowStarted() } }
		app.onSeekRequested = { seconds ->
			runOnUiThread {
				if (localPlaybackActive && exoPlayer != null) {
					exoPlayer?.seekTo((seconds * 1000).toLong())
				}
			}
		}

		val ip = NetworkUtils.getLocalIpAddress(this)
		val controllerUrl = "http://$ip:${DjHttpServer.SERVER_PORT}/dj-controller/"
		val apiUrl = "http://$ip:${DjHttpServer.SERVER_PORT}/api/youtube-dj/health"
		controllerUrlText.text = controllerUrl
		hostInfoText.text = apiUrl
		QrCodeHelper.encode(controllerUrl, 400)?.let { qrCodeImage.setImageBitmap(it) }

		findViewById<MaterialButton>(R.id.copyUrlButton).setOnClickListener {
			val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
			clipboard.setPrimaryClip(ClipData.newPlainText("controller_url", controllerUrl))
			Toast.makeText(this, R.string.copied_url, Toast.LENGTH_SHORT).show()
		}

		autoBootSwitch.isChecked = app.preferences.getAutoStartOnBoot()
		autoBootSwitch.setOnCheckedChangeListener { _, checked ->
			app.preferences.setAutoStartOnBoot(checked)
		}

		findViewById<MaterialButton>(R.id.startShowButton).setOnClickListener {
			startShow()
		}

		signInYouTubeButton.setOnClickListener {
			beginYouTubeSignIn()
		}
		signInYouTubeButton.setOnLongClickListener {
			importYouTubeSession()
			true
		}

		findViewById<TextView>(R.id.signInTroubleLink)?.setOnClickListener {
			tryDeviceAccountSignIn()
		}

		updateYouTubeAccountUi()

		backCallback =
			object : OnBackPressedCallback(true) {
				override fun handleOnBackPressed() {
					handleBack()
				}
			}
		onBackPressedDispatcher.addCallback(this, backCallback)

		requestRuntimePermissionsIfNeeded()
		(application as PlayerApp).startForegroundHost()

		if (
			savedInstanceState?.getBoolean(SAVED_STARTED, false) == true ||
			intent.getBooleanExtra(EXTRA_AUTO_START_SHOW, false)
		) {
			startShow()
		}

		if (!showStarted && YouTubeSessionHelper.isSignedIn()) {
			startShow()
		}

		startStatusRefresh()
	}


	// ═══════════════════════════════════════════════════════
	//  ExoPlayer — local video playback
	// ═══════════════════════════════════════════════════════

	private fun initExoPlayer() {
		exoPlayer = ExoPlayer.Builder(this).build()
		playerView.player = exoPlayer
		playerView.useController = false
		playerView.visibility = View.GONE

		exoPlayer?.addListener(object : Player.Listener {
			override fun onPlaybackStateChanged(state: Int) {
				if (state == Player.STATE_ENDED) {
					Log.i("MainActivity", "ExoPlayer ended, cleaning up local files")
					val vid = currentLocalVideoId
					currentLocalVideoId = null
					localPlaybackActive = false
					if (vid != null) videoDownloadManager.deleteAll(vid)
					// Auto-advance via the bridge's existing mechanism
					runOnUiThread {
						val handler = mainHandler  // alias for clarity in ExoPlayer listener
			handler.postDelayed({
							val app = application as PlayerApp
							app.queueEngine.onVideoEnded("local-ended")
						}, 500L)
					}
				}
			}
		})
	}

	private fun playLocalVideo(file: File, videoId: String) {
		Log.i("MainActivity", "playLocalVideo: $videoId (${file.length()} bytes)")
		localPlaybackActive = true
		currentLocalVideoId = videoId
		webView.visibility = View.GONE
		playerView.visibility = View.VISIBLE

		val vttFiles = videoDownloadManager.getLocalSubtitles(videoId)
		val subtitleConfigs = vttFiles.map { vttFile ->
			val lang = vttFile.name.replace("$videoId.", "").replace(".vtt", "")
			MediaItem.SubtitleConfiguration.Builder(Uri.fromFile(vttFile))
				.setMimeType(MimeTypes.TEXT_VTT)
				.setLanguage(lang)
				.setLabel(langToDisplay(lang))
				.setSelectionFlags(if (lang.contains("en")) C.SELECTION_FLAG_DEFAULT else 0)
				.build()
		}

		val mediaItem = MediaItem.Builder()
			.setUri(Uri.fromFile(file))
			.setSubtitleConfigurations(subtitleConfigs)
			.build()

		exoPlayer?.setMediaItem(mediaItem)
		exoPlayer?.prepare()
		exoPlayer?.playWhenReady = true
	}

	private fun langToDisplay(lang: String): String {
		return when (lang) {
			"en" -> "English"
			"es" -> "Español"
			"fr" -> "Français"
			"de" -> "Deutsch"
			"ja" -> "日本語"
			"ko" -> "한국어"
			"zh" -> "中文"
			"th" -> "ไทย"
			"pt" -> "Português"
			"ru" -> "Русский"
			"ar" -> "العربية"
			"hi" -> "हिन्दी"
			else -> lang.uppercase()
		}
	}


	private fun updateYouTubeAccountUi() {
		val app = application as PlayerApp
		YouTubeSessionHelper.syncVerifiedPreference(app.preferences)
		val signedIn = YouTubeSessionHelper.isSignedIn()
		val premium = YouTubeSessionHelper.isPremiumActive(app.preferences)
		if (signedIn) {
			YouTubeSessionHelper.markSignedIn(app.preferences)
		}
		when {
			signedIn && premium -> {
				youtubeAccountText.text = getString(R.string.youtube_premium_active)
				youtubeAccountText.setTextColor(
					ContextCompat.getColor(this, R.color.karol_connected),
				)
				signInYouTubeButton.visibility = View.GONE
			}
			signedIn -> {
				youtubeAccountText.text = getString(R.string.youtube_signed_in_no_premium)
				youtubeAccountText.setTextColor(
					ContextCompat.getColor(this, R.color.karol_warning),
				)
				signInYouTubeButton.text = getString(R.string.sign_in_youtube_retry)
				signInYouTubeButton.visibility = View.VISIBLE
			}
			else -> {
				youtubeAccountText.text =
					if (YouTubeSessionHelper.hasGoogleAuthCookies()) {
						getString(R.string.youtube_google_only)
					} else {
						getString(R.string.youtube_not_signed_in)
					}
				youtubeAccountText.setTextColor(
					ContextCompat.getColor(this, R.color.karol_warning),
				)
				signInYouTubeButton.text = getString(R.string.sign_in_youtube)
				signInYouTubeButton.visibility = View.VISIBLE
			}
		}
	}

	private fun ensureBridge(): YouTubeKioskBridge {
		val app = application as PlayerApp
		if (bridge == null) {
			bridge =
				YouTubeKioskBridge(this, webView, rootLayout) {
					enterImmersiveMode()
				}
			bridge?.setOnYouTubeSignedInListener {
				runOnUiThread { completeYouTubeSignIn() }
			}
			app.attachBridge(bridge!!)
		}
		return bridge!!
	}

	private fun beginYouTubeSignIn() {
		reauthOverlay.visibility = View.GONE
		if (tryRestoreYouTubeSessionIfNeeded()) return
		showSignInProgressOverlay()
		signInInProgress = true
		val bridge = ensureBridge()

		bridge.setOnSignInProgressListener { step ->
			runOnUiThread { updateSignInProgressOverlay(step) }
		}

		bridge.enterSignInMode { premium ->
			runOnUiThread {
				signInInProgress = false
				if (premium != null) {
					hideSignInProgressOverlay()
					completeYouTubeSignIn()
				} else {
					signInSpinner.visibility = View.GONE
					signInProgressTitle.text = getString(R.string.sign_in_overlay_timeout)
					signInProgressSubtitle.text = getString(R.string.sign_in_trouble_import)
					signInRetryButton.visibility = View.VISIBLE
					signInCancelButton.text = getString(R.string.stop_show)
				}
			}
		}
	}

	private fun tryRestoreYouTubeSessionIfNeeded(): Boolean {
		if (YouTubeSessionHelper.isSignedIn()) {
			updateYouTubeAccountUi()
			return true
		}
		YouTubeSessionBackup.tryRestoreOnStartup(this)
		if (YouTubeSessionHelper.isSignedIn()) {
			completeYouTubeSignIn()
			return true
		}
		return false
	}

	private fun importYouTubeSession() {
		try {
			importSessionLauncher.launch(arrayOf("application/json", "*/*"))
		} catch (_: Exception) {
			Toast.makeText(this, R.string.youtube_session_import_fail, Toast.LENGTH_LONG).show()
		}
	}

	private fun showSignInProgressOverlay() {
		signInProgressOverlay.visibility = View.VISIBLE
		signInProgressTitle.text = getString(R.string.sign_in_overlay_opening)
		signInProgressSubtitle.text = getString(R.string.sign_in_overlay_2fa_hint)
		signInSpinner.visibility = View.VISIBLE
		signInRetryButton.visibility = View.GONE
		signInCancelButton.text = getString(R.string.sign_in_overlay_cancel)
	}

	private fun hideSignInProgressOverlay() {
		signInProgressOverlay.visibility = View.GONE
	}

	private fun updateSignInProgressOverlay(step: YouTubeKioskBridge.SignInStep) {
		when (step) {
			YouTubeKioskBridge.SignInStep.OPENING_GOOGLE -> {
				signInProgressTitle.text = getString(R.string.sign_in_overlay_opening)
				signInProgressSubtitle.text = getString(R.string.sign_in_overlay_2fa_hint)
				signInSpinner.visibility = View.VISIBLE
				signInRetryButton.visibility = View.GONE
			}
			YouTubeKioskBridge.SignInStep.SIGNING_IN -> {
				signInProgressTitle.text = getString(R.string.sign_in_overlay_sign_in)
				signInSpinner.visibility = View.VISIBLE
				signInRetryButton.visibility = View.GONE
			}
			YouTubeKioskBridge.SignInStep.COOKIES_DETECTED -> {
				signInProgressTitle.text = getString(R.string.sign_in_overlay_cookies)
				signInProgressSubtitle.text = ""
				signInSpinner.visibility = View.VISIBLE
			}
			YouTubeKioskBridge.SignInStep.CHECKING_PREMIUM -> {
				signInProgressTitle.text = getString(R.string.sign_in_overlay_cookies)
				signInSpinner.visibility = View.VISIBLE
			}
			YouTubeKioskBridge.SignInStep.PREMIUM_CONFIRMED -> {
				signInProgressTitle.text = getString(R.string.sign_in_overlay_premium)
				signInProgressSubtitle.text = ""
				signInSpinner.visibility = View.GONE
				signInRetryButton.visibility = View.GONE
				mainHandler.postDelayed({ hideSignInProgressOverlay() }, 1_500L)
			}
			YouTubeKioskBridge.SignInStep.NO_PREMIUM -> {
				signInProgressTitle.text = getString(R.string.sign_in_overlay_no_premium)
				signInProgressSubtitle.text = ""
				signInSpinner.visibility = View.GONE
				signInRetryButton.visibility = View.GONE
				mainHandler.postDelayed({ hideSignInProgressOverlay() }, 1_500L)
			}
			YouTubeKioskBridge.SignInStep.TIMEOUT -> {
				signInProgressTitle.text = getString(R.string.sign_in_overlay_timeout)
				signInProgressSubtitle.text = getString(R.string.sign_in_trouble_import)
				signInSpinner.visibility = View.GONE
				signInRetryButton.visibility = View.VISIBLE
			}
		}
	}

	private fun cancelSignIn() {
		signInInProgress = false
		hideSignInProgressOverlay()
		bridge?.exitSignInMode(false) { }
	}

	private fun tryDeviceAccountSignIn() {
		YouTubeAccountSignIn.signIn(this) { ok ->
			runOnUiThread {
				if (ok) {
					completeYouTubeSignIn()
					Toast.makeText(this, R.string.youtube_sign_in_premium_ok, Toast.LENGTH_SHORT).show()
				} else {
					importYouTubeSession()
				}
			}
		}
	}

	private fun completeYouTubeSignIn() {
		if (!YouTubeSessionHelper.isSignedIn()) {
			return
		}
		val app = application as PlayerApp
		val bridge = bridge ?: return
		YouTubeSessionHelper.markSignedIn(app.preferences)
		YouTubeSessionHelper.flush()
		try {
			YouTubeSessionBackup.saveToDevice(this)
		} catch (_: Exception) {
		}
		Log.i("MainActivity", "completeYouTubeSignIn: running premium verification")
		bridge.verifyYouTubePremium { premium ->
			runOnUiThread {
				YouTubeSessionHelper.markPremiumVerified(app.preferences, premium)
				Handler(Looper.getMainLooper()).postDelayed({
					bridge.softRecoverPlayback()
					Log.i("MainActivity", "autoPlayTrigger: premium=$premium showStarted=$showStarted")
				}, 500)
				if (!showStarted) {
					updateYouTubeAccountUi()
					val msg =
						if (premium) {
							R.string.youtube_sign_in_premium_ok
						} else {
							R.string.youtube_sign_in_no_premium_warn
						}
					Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
				}
			}
		}
	}

	private fun requestRuntimePermissionsIfNeeded() {
		val app = application as PlayerApp
		if (app.preferences.hasAskedRuntimePermissions()) {
			return
		}
		app.preferences.setAskedRuntimePermissions()

		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
			if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS)
				!= android.content.pm.PackageManager.PERMISSION_GRANTED
			) {
				notificationPermissionLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
			}
		}

		val powerManager = getSystemService(POWER_SERVICE) as PowerManager
		if (!powerManager.isIgnoringBatteryOptimizations(packageName)) {
			try {
				startActivity(
					Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
						data = Uri.parse("package:$packageName")
					},
				)
			} catch (_: Exception) {
			}
		}
	}

	private fun startStatusRefresh() {
		statusRunnable?.let { statusHandler.removeCallbacks(it) }
		val runnable =
			object : Runnable {
				override fun run() {
					refreshStartPanelStatus()
					statusHandler.postDelayed(this, 2_000L)
				}
			}
		statusRunnable = runnable
		statusHandler.post(runnable)
	}

	private fun refreshStartPanelStatus() {
		if (showStarted) {
			return
		}
		updateYouTubeAccountUi()
		val app = application as PlayerApp
		val host = app.buildHostStatus()
		val queueLen = host.queueLength
		val title = host.currentTitle.ifBlank { "—" }
		statusText.text =
			if (host.showActive) {
				getString(R.string.status_show_active)
			} else {
				getString(R.string.status_idle)
			} + " · Queue: $queueLen · Now: $title"

		val error =
			host.interstitialMessage
				?: host.lastPlaybackError
		if (error.isNullOrBlank()) {
			errorText.visibility = View.GONE
		} else {
			errorText.visibility = View.VISIBLE
			errorText.text = error
		}
	}

	/**
	 * Try local ExoPlayer first, fall back to WebView YouTube on failure.
	 * Called by startShow and transport skip handlers.
	 */
	private fun tryLoadVideoOrFallback(videoId: String) {
		Log.i("MainActivity", "tryLoadVideoOrFallback: $videoId")
		// STOP the current player before loading the new video.
		// Without this, the old ExoPlayer or WebView YouTube keeps running
		// in the background while the new video loads, causing audio overlap.
		stopCurrentPlayback()
		showVideoLoading()
		// First, try local download
		videoDownloadManager.download(videoId,
			onProgress = { /* loading overlay handles progress visually */ },
			onReady = { file, subs ->
				runOnUiThread {
					hideVideoLoading()
					playLocalVideo(file, videoId)
					}
			},
			onError = { error ->
				Log.w("MainActivity", "Local download failed ($error), falling back to YouTube WebView")
				runOnUiThread {
					hideVideoLoading()
					localPlaybackActive = false
					playerView.visibility = View.GONE
					webView.visibility = View.VISIBLE
					bridge?.loadVideo(videoId)
					}
			}
		)
	}

	/**
	 * Stop whatever player is currently running — ExoPlayer or WebView YouTube.
	 * Called before loading a new video to prevent background audio overlap.
	 *
	 * For WebView→WebView transitions: just pause the JS player. The loadVideo()
	 * call that follows will navigate the WebView to the new video, which kills
	 * the old YouTube instance naturally. Using about:blank here would force
	 * YouTube to reload the entire SPA from scratch, adding 3-5s of delay.
	 *
	 * For ExoPlayer→anything: stop and hide ExoPlayer.
	 */
	private fun stopCurrentPlayback() {
		if (localPlaybackActive) {
			Log.i("MainActivity", "stopCurrentPlayback: stopping ExoPlayer ($currentLocalVideoId)")
			exoPlayer?.stop()
			localPlaybackActive = false
			currentLocalVideoId = null
			playerView.visibility = View.GONE
		} else {
			// WebView YouTube → just pause the JS player so the old video stops.
			// loadVideo() will handle the URL change; YouTube's SPA reload is instant.
			Log.i("MainActivity", "stopCurrentPlayback: pausing WebView YouTube")
			bridge?.pause()
			webView.stopLoading()
		}
	}

	private fun showVideoLoading() {
		loadingOverlay.visibility = View.VISIBLE
		loadingOverlay.animate().alpha(1f).setDuration(200).start()
	}

	private fun hideVideoLoading() {
		loadingOverlay.animate().alpha(0f).setDuration(200).withEndAction {
			loadingOverlay.visibility = View.GONE
		}.start()
	}

	private fun ensureShowStarted() {
		if (!showStarted) {
			startShow()
			return
		}
		// Already started — handle video change from queue advance
		val app = application as PlayerApp
		val currentId = app.queueEngine.getCurrentVideoId()
		if (currentId != null) {
			// Force load every time — the queue has advanced, this is a new video
			Log.i("MainActivity", "ensureShowStarted: loading new video $currentId")
			tryLoadVideoOrFallback(currentId)
		}
	}

	private fun startShow() {
		if (showStarted) {
			val currentId = (application as PlayerApp).queueEngine.getCurrentVideoId()
			if (currentId != null && bridge?.needsVideoLoad(currentId) == true) {
				tryLoadVideoOrFallback(currentId)
			}
			return
		}
		showStarted = true
		val app = application as PlayerApp
		app.showActive = true

		if (bridge == null) {
			bridge =
				YouTubeKioskBridge(this, webView, rootLayout) {
					enterImmersiveMode()
				}
			bridge?.setOnYouTubeSignedInListener {
				runOnUiThread { completeYouTubeSignIn() }
			}
			bridge?.onLoadingStateChanged = { loading ->
			runOnUiThread {
				if (loading) {
					Log.i("MainActivity", "loading overlay shown")
					loadingOverlay.visibility = View.VISIBLE
					loadingOverlay.animate().alpha(1f).setDuration(200).start()
				} else {
					loadingOverlay.animate().alpha(0f).setDuration(200).withEndAction {
						loadingOverlay.visibility = View.GONE
					}.start()
				}
			}
		}
			app.attachBridge(bridge!!)
		}

		startPanel.visibility = View.GONE
		webView.visibility = View.VISIBLE

		enterImmersiveMode()
		startImmersiveEnforcer()

		val currentId = app.queueEngine.getCurrentVideoId()
		if (currentId != null) {
			tryLoadVideoOrFallback(currentId)
			val prefs = getSharedPreferences("karol_resume", MODE_PRIVATE)
			val savedVideoId = prefs.getString("resume_videoId", null)
			val savedTimeMs = prefs.getLong("resume_time", 0L)
			val savedAt = prefs.getLong("resume_saved_at", 0L)
			val elapsed = System.currentTimeMillis() - savedAt
			if (savedVideoId == currentId && savedTimeMs > 0 && elapsed in 1..<7_200_000L) {
				mainHandler.postDelayed({
					bridge?.seek(savedTimeMs / 1000.0)
				}, 3000L)
			}
		} else if (app.queueEngine.getQueueSnapshot().queue.isNotEmpty()) {
			val first = app.queueEngine.getQueueSnapshot().queue.first()
			app.queueEngine.playNow(first.id)
		} else {
			bridge?.loadHomeLanding()
		}
	}


	private fun startImmersiveEnforcer() {
		stopImmersiveEnforcer()
		immersiveJob = lifecycleScope.launch {
			while (isActive && showStarted) {
				runOnUiThread { enterImmersiveMode() }
				delay(5000L)
			}
		}
	}

	private fun stopImmersiveEnforcer() {
		immersiveJob?.cancel()
		immersiveJob = null
	}

	private fun stopShow() {
		if (!showStarted) return
		showStarted = false
		(application as PlayerApp).showActive = false
		bridge?.prepareForStop()
		webView.stopLoading()
		stopImmersiveEnforcer()

		// Stop ExoPlayer if active
		if (localPlaybackActive) {
			localPlaybackActive = false
			exoPlayer?.stop()
			playerView.visibility = View.GONE
			val oldId = currentLocalVideoId
			currentLocalVideoId = null
			if (oldId != null) videoDownloadManager.deleteAll(oldId)
			webView.visibility = View.VISIBLE
		} else {
			webView.visibility = View.GONE
		}

		startPanel.visibility = View.VISIBLE
		enterImmersiveMode()
		refreshStartPanelStatus()
		Toast.makeText(this, R.string.show_paused_toast, Toast.LENGTH_SHORT).show()
	}

	private fun handleBack() {
		if (showStarted) {
			stopShow()
			return
		}
		moveTaskToBack(false)
	}

	override fun onSaveInstanceState(outState: Bundle) {
		super.onSaveInstanceState(outState)
		outState.putBoolean(SAVED_STARTED, showStarted)
	}

	override fun onResume() {
		super.onResume()
		if (this::webView.isInitialized) {
			webView.onResume()
		}
		enterImmersiveMode()
	}

	override fun onPause() {
		if (this::webView.isInitialized && showStarted) {
			webView.onResume()
		} else if (this::webView.isInitialized) {
			webView.onPause()
		}
		bridge?.onPause()
		if (showStarted && bridge != null) {
			val snap = bridge?.getSnapshot()
			if (snap != null && snap.videoId.isNotBlank() && snap.currentTime > 1.0) {
				getSharedPreferences("karol_resume", MODE_PRIVATE)
					.edit()
					.putString("resume_videoId", snap.videoId)
					.putLong("resume_time", (snap.currentTime * 1000).toLong())
					.putLong("resume_saved_at", System.currentTimeMillis())
					.apply()
			}
		}
		YouTubeSessionHelper.flush()
		if (YouTubeSessionHelper.isSignedIn()) {
			YouTubeSessionBackup.saveToDevice(this)
		}
		super.onPause()
	}

	override fun onWindowFocusChanged(hasFocus: Boolean) {
		super.onWindowFocusChanged(hasFocus)
		if (hasFocus) {
			enterImmersiveMode()
		}
	}

	override fun onDestroy() {
		statusRunnable?.let { statusHandler.removeCallbacks(it) }
		stopImmersiveEnforcer()
		bridge?.destroy()
		exoPlayer?.release()
		exoPlayer = null
		super.onDestroy()
	}

	private fun enterImmersiveMode() {
		Log.i("MainActivity", "enterImmersiveMode called")
		WindowInsetsControllerCompat(window, window.decorView).apply {
			hide(WindowInsetsCompat.Type.systemBars())
			systemBarsBehavior =
				WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
		}
	}



	companion object {
		const val EXTRA_AUTO_START_SHOW = "auto_start_show"
		private const val SAVED_STARTED = "show_started"
	}
}
