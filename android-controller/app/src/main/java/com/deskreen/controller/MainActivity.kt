package com.deskreen.controller

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {
	private lateinit var webView: WebView
	private lateinit var connectPanel: LinearLayout
	private lateinit var statusPanel: LinearLayout
	private lateinit var statusText: TextView
	private lateinit var urlInput: EditText
	private lateinit var connectButton: Button
	private lateinit var scanQrButton: Button
	private lateinit var openInChromeButton: Button

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
			loadControllerUrl(url)
		}

	@SuppressLint("SetJavaScriptEnabled")
	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		setContentView(R.layout.activity_main)

		webView = findViewById(R.id.webView)
		connectPanel = findViewById(R.id.connectPanel)
		statusPanel = findViewById(R.id.statusPanel)
		statusText = findViewById(R.id.statusText)
		urlInput = findViewById(R.id.urlInput)
		connectButton = findViewById(R.id.connectButton)
		scanQrButton = findViewById(R.id.scanQrButton)
		openInChromeButton = findViewById(R.id.openInChromeButton)

		val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
		val savedUrl = prefs.getString(KEY_URL, "") ?: ""
		if (savedUrl.isNotBlank()) {
			urlInput.setText(savedUrl)
		}

		configureWebView()

		savedInstanceState?.let {
			isConnected = it.getBoolean(SAVED_CONNECTED, false)
			lastLoadedUrl = it.getString(SAVED_LAST_URL, "") ?: ""
		}

		val openQrScanner = {
			discoveryJob?.cancel()
			qrScanLauncher.launch(Intent(this, QrScanActivity::class.java))
		}
		scanQrButton.setOnClickListener { openQrScanner() }

		openInChromeButton.setOnClickListener {
			val url = DeskreenUrl.normalize(urlInput.text.toString())
				?: lastLoadedUrl.takeIf { it.isNotBlank() }
				?: return@setOnClickListener
			CustomTabsIntent.Builder().build().launchUrl(this, Uri.parse(url))
		}

		connectButton.setOnClickListener {
			val url = DeskreenUrl.normalize(urlInput.text.toString())
			if (url != null) {
				prefs.edit().putString(KEY_URL, url).apply()
				loadControllerUrl(url)
			}
		}

		intent?.data?.toString()?.let { incoming ->
			DeskreenUrl.normalize(incoming)?.let { loadControllerUrl(it) }
			return
		}

		if (lastLoadedUrl.isNotBlank()) {
			loadControllerUrl(lastLoadedUrl)
		} else {
			startAutoDiscovery()
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
		webView.settings.apply {
			javaScriptEnabled = true
			domStorageEnabled = true
			loadWithOverviewMode = true
			useWideViewPort = true
			cacheMode = WebSettings.LOAD_NO_CACHE
			mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
			userAgentString = "$userAgentString DeskreenController/1.0"
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
		}
	}

	private fun loadControllerUrl(url: String) {
		discoveryJob?.cancel()
		lastLoadedUrl = url
		webView.visibility = View.VISIBLE
		connectPanel.visibility = View.GONE
		statusPanel.visibility = View.GONE
		webView.loadUrl(url)
	}

	private fun showStatus(message: String) {
		statusPanel.visibility = View.VISIBLE
		connectPanel.visibility = View.GONE
		webView.visibility = View.GONE
		statusText.text = message
	}

	private fun showManualConnect() {
		statusPanel.visibility = View.GONE
		connectPanel.visibility = View.VISIBLE
		webView.visibility = View.GONE
	}

	private fun showConnected() {
		statusPanel.visibility = View.GONE
		connectPanel.visibility = View.GONE
		webView.visibility = View.VISIBLE
	}

	override fun onSaveInstanceState(outState: Bundle) {
		super.onSaveInstanceState(outState)
		outState.putBoolean(SAVED_CONNECTED, isConnected)
		outState.putString(SAVED_LAST_URL, lastLoadedUrl)
	}

	companion object {
		private const val PREFS_NAME = "deskreen_controller_prefs"
		private const val KEY_URL = "controller_url"
		private const val SAVED_CONNECTED = "saved_connected"
		private const val SAVED_LAST_URL = "saved_last_url"
	}
}
