package com.deskreen.receiver

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.view.ViewGroup
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {
	private lateinit var webView: WebView
	private lateinit var rootLayout: FrameLayout
	private lateinit var connectPanel: LinearLayout
	private lateinit var statusPanel: LinearLayout
	private lateinit var statusText: TextView
	private lateinit var urlInput: EditText
	private lateinit var connectButton: Button
	private lateinit var scanQrButton: Button
	private lateinit var scanQrStatusButton: Button
	private lateinit var openInChromeButton: Button

	private var customView: View? = null
	private var customViewCallback: WebChromeClient.CustomViewCallback? = null

	private var isConnected = false
	private var discoveryJob: Job? = null
	private var lastLoadedUrl: String = ""

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
			loadDeskreenUrl(url)
		}

	@SuppressLint("SetJavaScriptEnabled")
	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		setContentView(R.layout.activity_main)

		enterImmersiveMode()

		webView = findViewById(R.id.webView)
		rootLayout = findViewById(R.id.rootLayout)
		connectPanel = findViewById(R.id.connectPanel)
		statusPanel = findViewById(R.id.statusPanel)
		statusText = findViewById(R.id.statusText)
		urlInput = findViewById(R.id.urlInput)
		connectButton = findViewById(R.id.connectButton)
		scanQrButton = findViewById(R.id.scanQrButton)
		scanQrStatusButton = findViewById(R.id.scanQrStatusButton)
		openInChromeButton = findViewById(R.id.openInChromeButton)

		val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
		val savedUrl = prefs.getString(KEY_URL, "") ?: ""
		if (savedUrl.isNotBlank()) {
			urlInput.setText(savedUrl)
		}

		configureWebView()

		// Restore state after process death
		savedInstanceState?.let {
			isConnected = it.getBoolean(SAVED_CONNECTED, false)
			lastLoadedUrl = it.getString(SAVED_LAST_URL, "") ?: ""
		}

		val openQrScanner = {
			discoveryJob?.cancel()
			qrScanLauncher.launch(Intent(this, QrScanActivity::class.java))
		}
		scanQrButton.setOnClickListener { openQrScanner() }
		scanQrStatusButton.setOnClickListener { openQrScanner() }

		openInChromeButton.setOnClickListener {
			val url = DeskreenUrl.normalize(urlInput.text.toString())
				?: lastLoadedUrl.takeIf { it.isNotBlank() }
				?: return@setOnClickListener
			openInChromeCustomTab(url)
		}

		connectButton.setOnClickListener {
			val url = DeskreenUrl.normalize(urlInput.text.toString())
			if (url != null) {
				prefs.edit().putString(KEY_URL, url).apply()
				loadDeskreenUrl(url)
			}
		}

		intent?.data?.toString()?.let { incoming ->
			DeskreenUrl.normalize(incoming)?.let { loadDeskreenUrl(it) }
			return
		}

		startAutoDiscovery()
	}

	private fun startAutoDiscovery() {
		discoveryJob?.cancel()
		showStatus(getString(R.string.searching_for_deskreen))
		discoveryJob = lifecycleScope.launch {
			var attempts = 0
			while (isActive && !isConnected) {
				val discovery = DeskreenDiscoveryService.findDeskreenOnLan(this@MainActivity)
				if (discovery != null) {
					getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
						.edit()
						.putString(KEY_URL, discovery.shareUrl)
						.apply()
					loadDeskreenUrl(discovery.shareUrl)
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
		webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)
		webView.settings.apply {
			javaScriptEnabled = true
			domStorageEnabled = true
			mediaPlaybackRequiresUserGesture = false
			javaScriptCanOpenWindowsAutomatically = true
			loadWithOverviewMode = true
			useWideViewPort = true
			cacheMode = WebSettings.LOAD_NO_CACHE
			mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
			userAgentString = "$userAgentString DeskreenReceiver/1.0"
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
				setOffscreenPreRaster(true)
			}
		}

		webView.webViewClient = object : WebViewClient() {
			override fun shouldOverrideUrlLoading(
				view: WebView?,
				request: WebResourceRequest?,
			): Boolean = false

			override fun onPageFinished(view: WebView?, url: String?) {
				super.onPageFinished(view, url)
				if (!isConnected) {
					isConnected = true
					showConnected()
				}
			}

			@Suppress("DEPRECATION")
	override fun onReceivedError(
				view: WebView?,
				errorCode: Int,
				description: String?,
				failingUrl: String?,
			) {
				android.util.Log.e(
					"DeskreenWebView",
					"onReceivedError code=$errorCode desc=$description url=$failingUrl isConnected=$isConnected",
				)
				// Don't disconnect — let the page JavaScript handle retry
			}

			override fun onReceivedHttpError(
				view: WebView?,
				request: WebResourceRequest?,
				errorResponse: android.webkit.WebResourceResponse?,
			) {
				android.util.Log.w(
					"DeskreenWebView",
					"onReceivedHttpError status=${errorResponse?.statusCode} url=${request?.url} isConnected=$isConnected",
				)
				// Don't disconnect — let the page JavaScript handle retry
			}

			override fun onRenderProcessGone(
				view: WebView?,
				detail: RenderProcessGoneDetail?,
			): Boolean {
				android.util.Log.e(
					"DeskreenWebView",
					"WebView renderer process gone didCrash=${detail?.didCrash()}",
				)
				isConnected = false
				if (lastLoadedUrl.isNotBlank()) {
					webView.clearCache(true)
					webView.loadUrl(bustClientViewerCache(lastLoadedUrl))
					showConnected()
				} else {
					recreate()
				}
				return true
			}
		}

		webView.webChromeClient = object : WebChromeClient() {
			override fun onPermissionRequest(request: PermissionRequest?) {
				request?.grant(request.resources)
			}

			override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
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
				rootLayout.addView(
					view,
					FrameLayout.LayoutParams(
						ViewGroup.LayoutParams.MATCH_PARENT,
						ViewGroup.LayoutParams.MATCH_PARENT,
					),
				)
				webView.visibility = View.GONE
				enterImmersiveMode()
			}

			override fun onHideCustomView() {
				val view = customView ?: return
				rootLayout.removeView(view)
				customView = null
				customViewCallback?.onCustomViewHidden()
				customViewCallback = null
				if (isConnected) {
					webView.visibility = View.VISIBLE
				}
				enterImmersiveMode()
			}

			override fun onConsoleMessage(message: android.webkit.ConsoleMessage?): Boolean {
				if (message != null) {
					android.util.Log.d(
						"DeskreenWebView",
						"${message.messageLevel()}: ${message.message()} @${message.sourceId()}:${message.lineNumber()}",
					)
				}
				return super.onConsoleMessage(message)
			}
		}
	}

	private fun hideHtml5FullscreenView() {
		val view = customView ?: return
		rootLayout.removeView(view)
		customView = null
		customViewCallback?.onCustomViewHidden()
		customViewCallback = null
		if (isConnected) {
			webView.visibility = View.VISIBLE
		}
		enterImmersiveMode()
	}

	private fun loadDeskreenUrl(rawUrl: String) {
		discoveryJob?.cancel()
		val url = appendReceiverFlag(rawUrl)
		lastLoadedUrl = url
		isConnected = false
		showStatus(getString(R.string.connecting_to_deskreen))
		connectPanel.visibility = View.GONE
		statusPanel.visibility = View.VISIBLE
		webView.visibility = View.VISIBLE
		webView.clearCache(true)
		webView.loadUrl(bustClientViewerCache(url))
	}

	private fun bustClientViewerCache(url: String): String {
		val cacheBust = System.currentTimeMillis()
		return if (url.contains("_cv=")) {
			url.replace(Regex("_cv=\\d+"), "_cv=$cacheBust")
		} else if (url.contains("?")) {
			"$url&_cv=$cacheBust"
		} else {
			"$url?_cv=$cacheBust"
		}
	}

	private fun openInChromeCustomTab(url: String) {
		val receiverUrl = appendReceiverFlag(url)
		try {
			CustomTabsIntent.Builder().build().launchUrl(this, Uri.parse(receiverUrl))
		} catch (_: Exception) {
			startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(receiverUrl)))
		}
	}

	private fun showStatus(message: String) {
		connectPanel.visibility = View.GONE
		statusPanel.visibility = View.VISIBLE
		webView.visibility = View.GONE
		statusText.text = message
	}

	private fun showManualConnect() {
		discoveryJob?.cancel()
		connectPanel.visibility = View.VISIBLE
		statusPanel.visibility = View.GONE
		webView.visibility = View.GONE
	}

	private fun showConnected() {
		connectPanel.visibility = View.GONE
		statusPanel.visibility = View.GONE
		webView.visibility = View.VISIBLE
		CastForegroundService.start(this)
		requestBatteryOptimizationExemption()
	}

	private fun appendReceiverFlag(url: String): String {
		return if (url.contains("receiver=1")) {
			url
		} else if (url.contains("?")) {
			"$url&receiver=1"
		} else {
			"$url?receiver=1"
		}
	}

	private fun enterImmersiveMode() {
		WindowCompat.setDecorFitsSystemWindows(window, false)
		WindowInsetsControllerCompat(window, window.decorView).apply {
			hide(WindowInsetsCompat.Type.systemBars())
			systemBarsBehavior =
				WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
		}
	}

	@SuppressLint("WakelockTimeout")
	private fun requestBatteryOptimizationExemption() {
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
		val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
		if (powerManager.isIgnoringBatteryOptimizations(packageName)) return

		val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
			data = Uri.parse("package:$packageName")
		}
		try {
			startActivity(intent)
		} catch (_: Exception) {
			// Some devices / launchers don't support this intent
		}
	}

	private fun stopCasting() {
		isConnected = false
		CastForegroundService.stop(this)
		webView.loadUrl("about:blank")
		webView.visibility = View.GONE
	}

	override fun onDestroy() {
		stopCasting()
		super.onDestroy()
	}

	override fun onStop() {
		super.onStop()
		// Keep the WebView alive — the foreground service owns the wake lock now
		if (isConnected && this::webView.isInitialized) {
			webView.onResume()
		}
	}

	override fun onTrimMemory(level: Int) {
		super.onTrimMemory(level)
		android.util.Log.w("DeskreenLifecycle", "onTrimMemory level=$level isConnected=$isConnected")
		// Never destroy — the foreground service keeps things alive
	}

	override fun onSaveInstanceState(outState: Bundle) {
		super.onSaveInstanceState(outState)
		outState.putBoolean(SAVED_CONNECTED, isConnected)
		outState.putString(SAVED_LAST_URL, lastLoadedUrl)
	}

	/**
	 * When connected and streaming, keep the WebView rendering pipeline alive
	 * even when the Activity loses focus. The foreground service holds the
	 * actual wake lock — we just prevent the WebView from pausing its timers.
	 */
	override fun onPause() {
		super.onPause()
		if (isConnected && this::webView.isInitialized) {
			webView.onResume()
		} else if (this::webView.isInitialized) {
			webView.onPause()
		}
	}

	override fun onResume() {
		super.onResume()
		if (this::webView.isInitialized) {
			webView.onResume()
		}
	}

	/**
	 * When the window loses focus (screen lock), keep the WebView
	 * rendering pipeline active.
	 */
	override fun onWindowFocusChanged(hasFocus: Boolean) {
		super.onWindowFocusChanged(hasFocus)
		if (!hasFocus && isConnected && this::webView.isInitialized) {
			webView.onResume()
		}
	}

	override fun onNewIntent(intent: Intent) {
		super.onNewIntent(intent)
		setIntent(intent)
		intent.data?.toString()?.let { incoming ->
			DeskreenUrl.normalize(incoming)?.let { loadDeskreenUrl(it) }
		}
	}

	@Deprecated("Deprecated in Java")
	override fun onBackPressed() {
		if (customView != null) {
			hideHtml5FullscreenView()
			return
		}
		if (webView.visibility == View.VISIBLE) {
			showStatus(getString(R.string.searching_for_deskreen))
			webView.loadUrl("about:blank")
			webView.visibility = View.GONE
			isConnected = false
			CastForegroundService.stop(this)
			startAutoDiscovery()
			return
		}
		if (connectPanel.visibility != View.VISIBLE) {
			showManualConnect()
			return
		}
		startAutoDiscovery()
	}

	companion object {
		private const val PREFS_NAME = "deskreen_receiver"
		private const val KEY_URL = "deskreen_url"
		private const val SAVED_CONNECTED = "isConnected"
		private const val SAVED_LAST_URL = "lastLoadedUrl"
	}
}
