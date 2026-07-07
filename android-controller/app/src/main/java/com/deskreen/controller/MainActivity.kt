package com.deskreen.controller

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.TextInputEditText
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {
	private lateinit var webView: WebView
	private lateinit var connectPanel: LinearLayout
	private lateinit var statusPanel: LinearLayout
	private lateinit var connectionBanner: LinearLayout
	private lateinit var bannerText: TextView
	private lateinit var bannerDot: View
	private lateinit var statusText: TextView
	private lateinit var urlInput: TextInputEditText
	private lateinit var connectErrorText: TextView
	private lateinit var connectButton: MaterialButton
	private lateinit var scanQrButton: MaterialButton
	private lateinit var disconnectButton: MaterialButton
	private lateinit var openInChromeButton: MaterialButton

	private var isConnected = false
	private var hostHealthy = true
	private var discoveryJob: Job? = null
	private var healthJob: Job? = null
	private var lastLoadedUrl: String = ""
	private var consecutiveHealthFailures = 0
	private var lastWebViewReloadAt = 0L
	private lateinit var nativeBridge: DeskreenNativeBridge
	private val volumeListener: (Double) -> Unit = { level ->
		if (::nativeBridge.isInitialized) {
			nativeBridge.pushVolumeToWebView(level)
		}
	}
	private val playbackRelayListener: (DjNowPlaying?, PlaybackStateRelay.Source) -> Unit =
		{ nowPlaying, source ->
			if (source == PlaybackStateRelay.Source.NOTIFICATION && nowPlaying != null && ::nativeBridge.isInitialized) {
				// #region agent log
				ControllerDbg.log(
					"H7",
					"MainActivity.playbackRelayListener",
					"push-to-webview",
					mapOf(
						"state" to nowPlaying.state,
						"videoId" to nowPlaying.videoId,
						"time" to nowPlaying.currentTimeSec,
					),
				)
				// #endregion
				nativeBridge.pushNowPlayingToWebView(nowPlaying)
			}
		}

	private val notificationPermissionLauncher =
		registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
			if (granted && lastLoadedUrl.isNotBlank()) {
				DjMediaPlaybackService.start(this, lastLoadedUrl)
			}
		}

	private val qrScanLauncher =
		registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
			if (result.resultCode != RESULT_OK) {
				if (!isConnected && connectPanel.visibility != View.VISIBLE) {
					startAutoDiscovery()
				}
				return@registerForActivityResult
			}
			val url = result.data?.getStringExtra(QrScanActivity.EXTRA_URL) ?: return@registerForActivityResult
			getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
				.edit()
				.putString(KEY_URL, url)
				.apply()
			urlInput.setText(url)
			loadControllerUrl(url)
		}

	@SuppressLint("SetJavaScriptEnabled")
	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		setContentView(R.layout.activity_main)

		webView = findViewById(R.id.webView)
		connectPanel = findViewById(R.id.connectPanel)
		statusPanel = findViewById(R.id.statusPanel)
		connectionBanner = findViewById(R.id.connectionBanner)
		bannerText = findViewById(R.id.bannerText)
		bannerDot = findViewById(R.id.bannerDot)
		statusText = findViewById(R.id.statusText)
		urlInput = findViewById(R.id.urlInput)
		connectErrorText = findViewById(R.id.connectErrorText)
		connectButton = findViewById(R.id.connectButton)
		scanQrButton = findViewById(R.id.scanQrButton)
		disconnectButton = findViewById(R.id.disconnectButton)
		openInChromeButton = findViewById(R.id.openInChromeButton)

		val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
		val savedUrl = prefs.getString(KEY_URL, "") ?: ""
		if (savedUrl.isNotBlank()) {
			urlInput.setText(savedUrl)
		}

		configureWebView()
		RemoteVolumeController.addListener(volumeListener)
		PlaybackStateRelay.addListener(playbackRelayListener)

		savedInstanceState?.let {
			isConnected = it.getBoolean(SAVED_CONNECTED, false)
			lastLoadedUrl = it.getString(SAVED_LAST_URL, "") ?: ""
		}

		scanQrButton.setOnClickListener {
			discoveryJob?.cancel()
			qrScanLauncher.launch(Intent(this, QrScanActivity::class.java))
		}

		openInChromeButton.setOnClickListener {
			val url = DeskreenUrl.normalize(urlInput.text?.toString().orEmpty())
				?: lastLoadedUrl.takeIf { it.isNotBlank() }
				?: return@setOnClickListener
			CustomTabsIntent.Builder().build().launchUrl(this, Uri.parse(url))
		}

		connectButton.setOnClickListener {
			val url = DeskreenUrl.normalize(urlInput.text?.toString().orEmpty())
			if (url == null) {
				connectErrorText.text = getString(R.string.invalid_url)
				connectErrorText.visibility = View.VISIBLE
				return@setOnClickListener
			}
			connectErrorText.visibility = View.GONE
			connectButton.isEnabled = false
			connectButton.text = getString(R.string.connecting)
			prefs.edit().putString(KEY_URL, url).apply()
			loadControllerUrl(url)
		}

		disconnectButton.setOnClickListener { disconnect() }

		intent?.data?.toString()?.let { incoming ->
			DeskreenUrl.normalize(incoming)?.let { url ->
				prefs.edit().putString(KEY_URL, url).apply()
				urlInput.setText(url)
				loadControllerUrl(url)
			}
			return
		}

		if (lastLoadedUrl.isNotBlank()) {
			loadControllerUrl(lastLoadedUrl)
		} else if (savedUrl.isNotBlank()) {
			lifecycleScope.launch {
				val host = extractHostFromUrl(savedUrl) ?: run {
					startAutoDiscovery()
					return@launch
				}
				val port = extractPortFromUrl(savedUrl)
				val healthy =
					withContext(Dispatchers.IO) {
						DeskreenDiscoveryService.isControllerReachable(host, port)
					}
				if (healthy) {
					loadControllerUrl(savedUrl)
				} else {
					startAutoDiscovery()
				}
			}
		} else {
			startAutoDiscovery()
		}
	}

	override fun onDestroy() {
		PlaybackStateRelay.removeListener(playbackRelayListener)
		RemoteVolumeController.removeListener(volumeListener)
		discoveryJob?.cancel()
		healthJob?.cancel()
		webView.destroy()
		super.onDestroy()
	}

	private fun disconnect() {
		DjMediaPlaybackService.stop(this)
		RemoteVolumeController.clear()
		lastLoadedUrl = ""
		isConnected = false
		hostHealthy = false
		getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().remove(KEY_URL).apply()
		webView.loadUrl("about:blank")
		showManualConnect()
		updateConnectionBanner(false, reconnecting = false)
	}

	private fun updateConnectionBanner(
		healthy: Boolean,
		reconnecting: Boolean,
	) {
		hostHealthy = healthy
		if (!isConnected || connectPanel.visibility == View.VISIBLE || statusPanel.visibility == View.VISIBLE) {
			connectionBanner.visibility = View.GONE
			return
		}
		connectionBanner.visibility = View.VISIBLE
		when {
			healthy -> {
				bannerText.text = getString(R.string.native_connected)
				bannerDot.setBackgroundColor(
					ContextCompat.getColor(this, R.color.deskreen_connected),
				)
			}
			reconnecting -> {
				bannerText.text = getString(R.string.native_reconnecting)
				bannerDot.setBackgroundColor(
					ContextCompat.getColor(this, R.color.deskreen_warning),
				)
			}
			else -> {
				bannerText.text = getString(R.string.native_offline)
				bannerDot.setBackgroundColor(
					ContextCompat.getColor(this, R.color.deskreen_error),
				)
			}
		}
	}

	private fun startAutoDiscovery() {
		discoveryJob?.cancel()
		showStatus(getString(R.string.searching_for_deskreen))
		discoveryJob = lifecycleScope.launch {
			var attempts = 0
			while (isActive && !isConnected) {
				val discovery = DeskreenDiscoveryService.findDeskreenOnLan(this@MainActivity)
				if (discovery != null) {
					val label =
						if (discovery.isPlayerHost) {
							getString(R.string.discovery_tablet_player, discovery.host, discovery.port)
						} else {
							getString(R.string.discovery_mac_host, discovery.host, discovery.port)
						}
					showStatus(label)
					getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
						.edit()
						.putString(KEY_URL, discovery.controllerUrl)
						.apply()
					loadControllerUrl(discovery.controllerUrl)
					return@launch
				}
				attempts++
				if (attempts >= 6) {
					showManualConnect()
					return@launch
				}
				delay(2500)
			}
		}
	}

	@SuppressLint("SetJavaScriptEnabled")
	private fun configureWebView() {
		webView.isNestedScrollingEnabled = true
		webView.overScrollMode = View.OVER_SCROLL_ALWAYS
		webView.settings.apply {
			javaScriptEnabled = true
			domStorageEnabled = true
			loadWithOverviewMode = true
			useWideViewPort = true
			cacheMode = WebSettings.LOAD_DEFAULT
			mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
			userAgentString = "$userAgentString DeskreenController/1.0"
		}

		webView.addJavascriptInterface(
			DeskreenNativeBridge(this, webView) { healthy ->
				runOnUiThread {
					updateConnectionBanner(healthy, reconnecting = !healthy && isConnected)
				}
			}.also { nativeBridge = it },
			"DeskreenNative",
		)

		webView.webViewClient =
			object : WebViewClient() {
				override fun shouldOverrideUrlLoading(
					view: WebView?,
					request: WebResourceRequest?,
				): Boolean = false

				override fun onPageFinished(
					view: WebView?,
					url: String?,
				) {
					super.onPageFinished(view, url)
					if (url?.contains("dj-controller") != true) {
						return
					}
					connectButton.isEnabled = true
					connectButton.text = getString(R.string.connect)
					val probeUrl = url ?: lastLoadedUrl
					lifecycleScope.launch {
						val host = extractHostFromUrl(probeUrl) ?: return@launch
						val port = extractPortFromUrl(probeUrl)
						val healthy =
							withContext(Dispatchers.IO) {
								DeskreenDiscoveryService.isControllerReachable(host, port)
							}
						isConnected = healthy
						showConnected()
						updateConnectionBanner(healthy, reconnecting = !healthy)
						if (healthy) {
							syncWebHostToPageOrigin()
							PlaybackStateRelay.latest?.let { latest ->
								if (::nativeBridge.isInitialized) {
									nativeBridge.pushNowPlayingToWebView(latest)
								}
							}
						}
					}
				}

				override fun onReceivedError(
					view: WebView?,
					request: WebResourceRequest?,
					error: WebResourceError?,
				) {
					if (request?.isForMainFrame != true) {
						return
					}
					android.util.Log.e(
						"DeskreenController",
						"main frame error code=${error?.errorCode} desc=${error?.description} url=${request.url}",
					)
					runOnUiThread {
						connectErrorText.text = getString(R.string.controller_load_error)
						connectErrorText.visibility = View.VISIBLE
						updateConnectionBanner(false, reconnecting = true)
					}
				}

				override fun onReceivedHttpError(
					view: WebView?,
					request: WebResourceRequest?,
					errorResponse: android.webkit.WebResourceResponse?,
				) {
					if (request?.isForMainFrame != true) {
						return
					}
					if ((errorResponse?.statusCode ?: 0) >= 400) {
						runOnUiThread {
							connectErrorText.text = getString(R.string.controller_load_error)
							connectErrorText.visibility = View.VISIBLE
						}
					}
				}

				override fun onRenderProcessGone(
					view: WebView?,
					detail: RenderProcessGoneDetail?,
				): Boolean {
					val now = System.currentTimeMillis()
					if (now - lastWebViewReloadAt < MIN_RELOAD_INTERVAL_MS) {
						return true
					}
					lastWebViewReloadAt = now
					isConnected = false
					if (lastLoadedUrl.isNotBlank()) {
						webView.loadUrl(lastLoadedUrl)
						showConnected()
					} else {
						showManualConnect()
					}
					return true
				}
			}
	}

	private fun loadControllerUrl(url: String) {
		discoveryJob?.cancel()
		consecutiveHealthFailures = 0
		DjApiClient.apiBaseFromControllerUrl(url)?.let { base ->
			RemoteVolumeController.bindApiBase(base)
			lifecycleScope.launch {
				RemoteVolumeController.seedFromTablet(base)
			}
		}
		if (url == lastLoadedUrl && webView.url?.contains("dj-controller") == true) {
			showConnected()
			startHealthMonitor()
			startHeadlessPlayback(url)
			return
		}
		lastLoadedUrl = url
		webView.visibility = View.VISIBLE
		connectPanel.visibility = View.GONE
		statusPanel.visibility = View.GONE
		disconnectButton.visibility = View.VISIBLE
		connectErrorText.visibility = View.GONE
		webView.loadUrl(url)
		syncWebHostToPageOrigin()
		startHealthMonitor()
		startHeadlessPlayback(url)
	}

	private fun startHeadlessPlayback(controllerUrl: String) {
		DjApiClient.apiBaseFromControllerUrl(controllerUrl)?.let { base ->
			RemoteVolumeController.bindApiBase(base)
			lifecycleScope.launch {
				RemoteVolumeController.seedFromTablet(base)
			}
		}
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
			if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
				!= PackageManager.PERMISSION_GRANTED
			) {
				notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
				return
			}
		}
		DjMediaPlaybackService.start(this, controllerUrl)
	}

	private fun startHealthMonitor() {
		healthJob?.cancel()
		healthJob =
			lifecycleScope.launch {
				while (isActive && lastLoadedUrl.isNotBlank()) {
					delay(HEALTH_CHECK_INTERVAL_MS)
					val host = extractHostFromUrl(lastLoadedUrl) ?: continue
					val port = extractPortFromUrl(lastLoadedUrl)
					val healthy =
						withContext(Dispatchers.IO) {
							DeskreenDiscoveryService.isControllerReachable(host, port)
						}
					if (healthy) {
						consecutiveHealthFailures = 0
						updateConnectionBanner(true, reconnecting = false)
						continue
					}
					consecutiveHealthFailures++
					updateConnectionBanner(false, reconnecting = true)
					if (consecutiveHealthFailures < HEALTH_FAILURE_THRESHOLD) {
						continue
					}
					val rediscovered =
						withContext(Dispatchers.IO) {
							DeskreenDiscoveryService.rediscover(this@MainActivity, host)
						}
					consecutiveHealthFailures = 0
					if (rediscovered == null || rediscovered.host == host) {
						continue
					}
					getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
						.edit()
						.putString(KEY_URL, rediscovered.controllerUrl)
						.apply()
					loadControllerUrl(rediscovered.controllerUrl)
				}
			}
	}

	private fun extractHostFromUrl(url: String): String? =
		try {
			Uri.parse(url).host
		} catch (_: Exception) {
			null
		}

	private fun extractPortFromUrl(url: String): Int =
		try {
			Uri.parse(url).port.takeIf { it > 0 } ?: 3131
		} catch (_: Exception) {
			3131
		}

	private fun showStatus(message: String) {
		statusPanel.visibility = View.VISIBLE
		connectPanel.visibility = View.GONE
		webView.visibility = View.GONE
		connectionBanner.visibility = View.GONE
		statusText.text = message
	}

	private fun showManualConnect() {
		DjMediaPlaybackService.stop(this)
		statusPanel.visibility = View.GONE
		connectPanel.visibility = View.VISIBLE
		webView.visibility = View.GONE
		connectionBanner.visibility = View.GONE
		connectButton.isEnabled = true
		connectButton.text = getString(R.string.connect)
	}

	private fun showConnected() {
		statusPanel.visibility = View.GONE
		connectPanel.visibility = View.GONE
		webView.visibility = View.VISIBLE
		updateConnectionBanner(hostHealthy, reconnecting = false)
	}

	/** Keep dj-controller WebView API host aligned with the loaded tablet URL. */
	private fun syncWebHostToPageOrigin() {
		webView.evaluateJavascript(
			"(function(){var o=location.origin.replace(/\\/+\$/,'');" +
				"try{localStorage.setItem('deskreen_dj_host',o);}catch(e){}})();",
			null,
		)
	}

	override fun onSaveInstanceState(outState: Bundle) {
		super.onSaveInstanceState(outState)
		outState.putBoolean(SAVED_CONNECTED, isConnected)
		outState.putString(SAVED_LAST_URL, lastLoadedUrl)
	}

	override fun dispatchKeyEvent(event: KeyEvent): Boolean {
		if (
			event.action == KeyEvent.ACTION_DOWN &&
			isConnected &&
			connectPanel.visibility != View.VISIBLE &&
			statusPanel.visibility != View.VISIBLE
		) {
			when (event.keyCode) {
				KeyEvent.KEYCODE_VOLUME_UP -> {
					RemoteVolumeController.adjustVolume(1)
					return true
				}
				KeyEvent.KEYCODE_VOLUME_DOWN -> {
					RemoteVolumeController.adjustVolume(-1)
					return true
				}
			}
		}
		return super.dispatchKeyEvent(event)
	}

	companion object {
		private const val PREFS_NAME = "deskreen_controller_prefs"
		private const val KEY_URL = "controller_url"
		private const val SAVED_CONNECTED = "saved_connected"
		private const val SAVED_LAST_URL = "saved_last_url"
		private const val HEALTH_CHECK_INTERVAL_MS = 20_000L
		private const val HEALTH_FAILURE_THRESHOLD = 4
		private const val MIN_RELOAD_INTERVAL_MS = 30_000L
	}
}
