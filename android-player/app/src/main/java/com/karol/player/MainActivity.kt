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

	// --- Windowed / fullscreen controls ---
	private lateinit var controlsPanel: LinearLayout
	private lateinit var toggleFullscreenBtn: ImageButton
	private lateinit var ctlPlayPause: MaterialButton
	private lateinit var ctlPrev: MaterialButton
	private lateinit var ctlNext: MaterialButton
	private lateinit var ctlSkipBack: MaterialButton
	private lateinit var ctlSkipFwd: MaterialButton
	private lateinit var ctlCC: MaterialButton
	private lateinit var ctlQueue: MaterialButton
	private lateinit var ctlSeekBar: SeekBar
	private lateinit var ctlCurrentTime: TextView
	private lateinit var ctlTotalTime: TextView
	private var isFullscreen = false
	private var isSeekDragging = false
	private var controlsRefreshJob: Job? = null
	private var controlsAutoHideRunnable: Runnable? = null

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

		// --- New windowed/fullscreen controls ---
		controlsPanel = findViewById(R.id.controlsPanel)
		toggleFullscreenBtn = findViewById(R.id.toggleFullscreenBtn)
		ctlPlayPause = findViewById(R.id.ctlPlayPause)
		ctlPrev = findViewById(R.id.ctlPrev)
		ctlNext = findViewById(R.id.ctlNext)
		ctlSkipBack = findViewById(R.id.ctlSkipBack)
		ctlSkipFwd = findViewById(R.id.ctlSkipFwd)
		ctlCC = findViewById(R.id.ctlCC)
		ctlQueue = findViewById(R.id.ctlQueue)
		ctlSeekBar = findViewById(R.id.ctlSeekBar)
		ctlCurrentTime = findViewById(R.id.ctlCurrentTime)
		ctlTotalTime = findViewById(R.id.ctlTotalTime)

		toggleFullscreenBtn.apply {
			elevation = 20f
			setOnClickListener {
				if (isFullscreen) {
					// Show controls briefly
					toggleFullscreenBtn.animate().alpha(1f).setDuration(200).start()
					mainHandler.removeCallbacks(controlsAutoHideRunnable ?: return@setOnClickListener)
					controlsAutoHideRunnable = Runnable {
						toggleFullscreenBtn.animate().alpha(0f).setDuration(500).start()
					}
					mainHandler.postDelayed(controlsAutoHideRunnable!!, 3000)
				}
				toggleFullscreen()
			}
		}

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

		setupControls()

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

	private fun setupControls() {
		// Transport buttons
		ctlPlayPause.setOnClickListener {
			val app = application as PlayerApp
			if (app.queueEngine.isPlaying) pauseTransport() else playTransport()
		}
		ctlPrev.setOnClickListener { skipPrevTransport() }
		ctlNext.setOnClickListener { skipNextTransport() }
		ctlSkipBack.setOnClickListener { seekRelativeTransport(-10.0) }
		ctlSkipFwd.setOnClickListener { seekRelativeTransport(10.0) }

		// Seek bar
		ctlSeekBar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
			override fun onProgressChanged(seekBar: SeekBar, progress: Int, fromUser: Boolean) {
				if (fromUser) {
					val dur = (application as PlayerApp).queueEngine.duration
					if (dur > 0) ctlCurrentTime.text = formatTime(dur * progress / seekBar.max)
				}
			}
			override fun onStartTrackingTouch(seekBar: SeekBar) { isSeekDragging = true }
			override fun onStopTrackingTouch(seekBar: SeekBar) {
				isSeekDragging = false
				val dur = (application as PlayerApp).queueEngine.duration
				if (dur > 0) bridge?.seek(dur * seekBar.progress.toDouble() / seekBar.max)
			}
		})

		ctlCC.setOnClickListener { showCcDialog() }

		ctlQueue.setOnClickListener {
			val app = application as PlayerApp
			val snapshot = app.queueEngine.getQueueSnapshot()
			val items = snapshot.queue
			if (items.isEmpty()) {
				Toast.makeText(this, "Queue is empty", Toast.LENGTH_SHORT).show()
				return@setOnClickListener
			}
			val titles = items.mapIndexed { idx, item ->
				val prefix = if (idx == snapshot.currentIndex) "▶ " else "${idx + 1}. "
				"$prefix${item.title}"
			}.toTypedArray()
			AlertDialog.Builder(this)
				.setTitle("Playlist (${items.size} tracks)")
				.setItems(titles) { _, which ->
					val app2 = application as PlayerApp
					app2.queueEngine.playNow(items[which].id)
				}
				.show()
		}
	}

	private fun toggleFullscreen() {
		isFullscreen = !isFullscreen
		if (isFullscreen) {
			controlsPanel.visibility = View.GONE
			toggleFullscreenBtn.alpha = 0.4f
			bridge?.enterFullscreen()

			// Auto-hide FAB after 3s
			mainHandler.removeCallbacks(controlsAutoHideRunnable ?: Runnable {})
			controlsAutoHideRunnable = Runnable {
				if (isFullscreen) {
					toggleFullscreenBtn.animate().alpha(0f).setDuration(500).start()
				}
			}
			mainHandler.postDelayed(controlsAutoHideRunnable!!, 3000)
		} else {
			controlsPanel.visibility = View.VISIBLE
			toggleFullscreenBtn.alpha = 1f
			bridge?.exitYouTubeFullscreen()

			mainHandler.removeCallbacks(controlsAutoHideRunnable ?: Runnable {})
			controlsAutoHideRunnable = null
		}
	}

	private fun showCcDialog() {
		Thread {
			val tracks = bridge?.listCaptions() ?: org.json.JSONArray()
			runOnUiThread {
				if (tracks.length() == 0) {
					AlertDialog.Builder(this)
						.setTitle("Captions / Subtitles")
						.setMessage("No captions available")
						.setPositiveButton(android.R.string.ok, null)
						.show()
					return@runOnUiThread
				}
				val labels = Array(tracks.length()) { i ->
					val track = tracks.getJSONObject(i)
					val label = track.optString("label", "Unknown")
					val lang = track.optString("lang", "")
					"$label ($lang)"
				}
				val indices = IntArray(tracks.length()) { tracks.getJSONObject(it).getInt("index") }

				AlertDialog.Builder(this)
					.setTitle("Captions / Subtitles")
					.setItems(labels) { _, which ->
						bridge?.setCaption(indices[which])
					}
					.setNegativeButton("Turn off") { _, _ ->
						bridge?.setCaptionOff()
					}
					.show()
			}
		}.start()
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

	private fun ensureShowStarted() {
		if (!showStarted) {
			startShow()
		}
	}

	private fun startShow() {
		if (showStarted) {
			val currentId = (application as PlayerApp).queueEngine.getCurrentVideoId()
			if (currentId != null && bridge?.needsVideoLoad(currentId) == true) {
				bridge?.loadVideo(currentId)
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
						loadingOverlay.visibility = View.VISIBLE
						loadingOverlay.animate().alpha(1f).setDuration(300).start()
					} else {
						loadingOverlay.animate().alpha(0f).setDuration(300).withEndAction {
							loadingOverlay.visibility = View.GONE
						}.start()
					}
				}
			}
			app.attachBridge(bridge!!)
		}

		startPanel.visibility = View.GONE
		webView.visibility = View.VISIBLE
		toggleFullscreenBtn.visibility = View.VISIBLE

		// Start in windowed mode (controls visible, WebView always fills screen)
		isFullscreen = false
		controlsPanel.visibility = View.VISIBLE
		toggleFullscreenBtn.alpha = 1f

		enterImmersiveMode()
		startControlsRefresh()

		val currentId = app.queueEngine.getCurrentVideoId()
		if (currentId != null) {
			bridge?.loadVideo(currentId)
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

	private fun stopShow() {
		if (!showStarted) {
			return
		}
		showStarted = false
		(application as PlayerApp).showActive = false
		isFullscreen = false
		mainHandler.removeCallbacks(controlsAutoHideRunnable ?: Runnable {})
		controlsAutoHideRunnable = null
		bridge?.prepareForStop()
		webView.stopLoading()
		stopControlsRefresh()
		webView.visibility = View.GONE
		controlsPanel.visibility = View.GONE
		toggleFullscreenBtn.visibility = View.GONE
		startPanel.visibility = View.VISIBLE
		enterImmersiveMode()
		refreshStartPanelStatus()
		Toast.makeText(this, R.string.show_paused_toast, Toast.LENGTH_SHORT).show()
	}

	private fun handleBack() {
		val activeBridge = bridge
		if (activeBridge?.isInCustomView() == true) {
			activeBridge.exitYouTubeFullscreen()
			return
		}
		if (showStarted) {
			if (activeBridge?.shouldWebViewGoBack() == true) {
				activeBridge.goBackInWebView()
				return
			}
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
		stopControlsRefresh()
		bridge?.destroy()
		super.onDestroy()
	}

	private fun enterImmersiveMode() {
		WindowCompat.setDecorFitsSystemWindows(window, false)
		window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
		WindowInsetsControllerCompat(window, window.decorView).apply {
			hide(WindowInsetsCompat.Type.systemBars())
			systemBarsBehavior =
				WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
		}
	}

	// ──────────────────────────────────────────────
	//  Controls Refresh (coroutine-based, 500ms interval)
	// ──────────────────────────────────────────────

	private fun startControlsRefresh() {
		stopControlsRefresh()
		controlsRefreshJob = lifecycleScope.launch {
			while (isActive) {
				runOnUiThread { refreshControlsState() }
				delay(500L)
			}
		}
	}

	private fun stopControlsRefresh() {
		controlsRefreshJob?.cancel()
		controlsRefreshJob = null
	}

	private fun refreshControlsState() {
		if (isSeekDragging) return
		if (!showStarted) return
		bridge?.readSnapshot { snap ->
			if (snap == null) return@readSnapshot
			val app = application as PlayerApp
			val playing = app.queueEngine.isPlaying && (snap.state == 1 || !snap.paused)
			val dur = snap.duration.takeIf { it > 0 } ?: app.queueEngine.duration
			val ct = snap.currentTime.takeIf { it >= 0 } ?: app.queueEngine.currentTime

			ctlPlayPause.text = if (playing) "\u23F8" else "\u25B6"
			if (dur > 0) {
				ctlTotalTime.text = formatTime(dur)
				ctlSeekBar.progress = ((ct / dur) * ctlSeekBar.max).toInt().coerceIn(0, ctlSeekBar.max)
				ctlCurrentTime.text = formatTime(ct)
			}
		}
	}

	// ──────────────────────────────────────────────
	//  Transport helpers
	// ──────────────────────────────────────────────

	private fun playTransport() {
		val app = application as PlayerApp
		app.onRequestStartShow?.invoke()
		bridge?.play()
		app.queueEngine.setTransportPlaying(true)
		app.djHttpServer.onTransportAdvance?.invoke()
	}

	private fun pauseTransport() {
		val app = application as PlayerApp
		bridge?.pause()
		app.queueEngine.setTransportPlaying(false)
	}

	private fun skipNextTransport() {
		val app = application as PlayerApp
		app.djHttpServer.invalidatePlaybackSnapshot()
		app.onRequestStartShow?.invoke()
		app.djHttpServer.onTransportAdvance?.invoke()
		app.queueEngine.skipNext("user-skip-controls")
	}

	private fun skipPrevTransport() {
		val app = application as PlayerApp
		app.djHttpServer.invalidatePlaybackSnapshot()
		app.onRequestStartShow?.invoke()
		app.djHttpServer.onTransportAdvance?.invoke()
		app.queueEngine.skipPrev("user-skip-controls")
	}

	private fun seekRelativeTransport(delta: Double) {
		val app = application as PlayerApp
		val snap = bridge?.getSnapshot()
		val base = snap?.currentTime?.takeIf { it > 0 } ?: app.queueEngine.currentTime
		val target = maxOf(0.0, base + delta)
		bridge?.seek(target)
	}

	private fun formatTime(seconds: Double): String {
		val totalSecs = seconds.toInt().coerceAtLeast(0)
		val mins = totalSecs / 60
		val secs = totalSecs % 60
		return "%d:%02d".format(mins, secs)
	}

	companion object {
		const val EXTRA_AUTO_START_SHOW = "auto_start_show"
		private const val SAVED_STARTED = "show_started"
	}
}
