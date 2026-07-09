package com.deskreen.player

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
import android.widget.ImageView
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
import com.google.android.material.button.MaterialButton

class MainActivity : AppCompatActivity() {
	private lateinit var webView: WebView
	private lateinit var rootLayout: FrameLayout
	private lateinit var startPanel: View
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
	private lateinit var backCallback: OnBackPressedCallback
	private val statusHandler = Handler(Looper.getMainLooper())
	private var statusRunnable: Runnable? = null

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
		hostInfoText = findViewById(R.id.hostInfoText)
		controllerUrlText = findViewById(R.id.controllerUrlText)
		statusText = findViewById(R.id.statusText)
		errorText = findViewById(R.id.errorText)
		youtubeAccountText = findViewById(R.id.youtubeAccountText)
		signInYouTubeButton = findViewById(R.id.signInYouTubeButton)
		qrCodeImage = findViewById(R.id.qrCodeImage)
		autoBootSwitch = findViewById(R.id.autoBootSwitch)
		reauthOverlay = findViewById(R.id.reauthOverlay)
		findViewById<MaterialButton>(R.id.reauthButton).setOnClickListener {
			beginYouTubeSignIn()
		}
		findViewById<MaterialButton>(R.id.reauthStopShowButton).setOnClickListener {
			reauthOverlay.visibility = View.GONE
			stopShow()
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
			importYouTubeSession()
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

		startStatusRefresh()
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
					ContextCompat.getColor(this, R.color.deskreen_connected),
				)
				signInYouTubeButton.visibility = View.GONE
			}
			signedIn -> {
				youtubeAccountText.text = getString(R.string.youtube_signed_in_no_premium)
				youtubeAccountText.setTextColor(
					ContextCompat.getColor(this, R.color.deskreen_warning),
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
					ContextCompat.getColor(this, R.color.deskreen_warning),
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
		// Try device Google account sign-in before file import
		YouTubeAccountSignIn.signIn(this) { ok ->
			runOnUiThread {
				if (ok) {
					completeYouTubeSignIn()
					Toast.makeText(this, R.string.youtube_sign_in_premium_ok, Toast.LENGTH_SHORT).show()
				} else {
					// Fall back to file import
					importYouTubeSession()
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
			// MediaStore write may fail on some devices — non-fatal.
		}
		Log.i("MainActivity", "completeYouTubeSignIn: running premium verification")
		bridge.verifyYouTubePremium { premium ->
			runOnUiThread {
				YouTubeSessionHelper.markPremiumVerified(app.preferences, premium)
				// Trigger playback — on mobile YouTube, autoplay is blocked
				// and the video won't start without an explicit play command.
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
				// ignore
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
			app.attachBridge(bridge!!)
		}

		startPanel.visibility = View.GONE
		webView.visibility = View.VISIBLE
		enterImmersiveMode()

		val currentId = app.queueEngine.getCurrentVideoId()
		if (currentId != null) {
			bridge?.loadVideo(currentId)
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
		bridge?.prepareForStop()
		webView.stopLoading()
		webView.loadUrl("about:blank")
		webView.visibility = View.GONE
		startPanel.visibility = View.VISIBLE
		enterImmersiveMode()
		refreshStartPanelStatus()
		Toast.makeText(this, R.string.show_paused_toast, Toast.LENGTH_SHORT).show()
	}

	private fun handleBack() {
		val activeBridge = bridge
		if (activeBridge?.isInCustomView() == true) {
			activeBridge.exitFullscreen()
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
			// Keep WebView media session alive so audio continues when the activity
			// is backgrounded (e.g. user switches apps).  Without this the YouTube
			// player in the WebView pauses audio.
			webView.onResume()
		} else if (this::webView.isInitialized) {
			webView.onPause()
		}
		bridge?.onPause()
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

	companion object {
		const val EXTRA_AUTO_START_SHOW = "auto_start_show"
		private const val SAVED_STARTED = "show_started"
	}
}
