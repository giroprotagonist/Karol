package com.deskreen.player

import android.annotation.SuppressLint
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.google.android.material.button.MaterialButton

class MainActivity : AppCompatActivity() {
	private lateinit var webView: WebView
	private lateinit var rootLayout: FrameLayout
	private lateinit var startPanel: View
	private lateinit var hostInfoText: TextView
	private var bridge: YouTubeKioskBridge? = null
	private var showStarted = false

	@SuppressLint("SetJavaScriptEnabled")
	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		setContentView(R.layout.activity_main)
		enterImmersiveMode()

		rootLayout = findViewById(R.id.rootLayout)
		webView = findViewById(R.id.webView)
		startPanel = findViewById(R.id.startPanel)
		hostInfoText = findViewById(R.id.hostInfoText)

		val ip = NetworkUtils.getLocalIpAddress(this)
		hostInfoText.text =
			"Controller: http://$ip:${DjHttpServer.SERVER_PORT}/dj-controller/\nAPI: http://$ip:${DjHttpServer.SERVER_PORT}/api/youtube-dj/health"

		findViewById<MaterialButton>(R.id.startShowButton).setOnClickListener {
			startShow()
		}

		if (savedInstanceState?.getBoolean(SAVED_STARTED, false) == true) {
			startShow()
		}
	}

	private fun startShow() {
		if (showStarted) {
			return
		}
		showStarted = true
		val app = application as PlayerApp

		bridge = YouTubeKioskBridge(this, webView, rootLayout)
		app.attachBridge(bridge!!)
		app.startHttpServer()
		PlayerForegroundService.start(this)

		startPanel.visibility = View.GONE
		webView.visibility = View.VISIBLE

		val currentId = app.queueEngine.getCurrentVideoId()
		if (currentId != null) {
			bridge?.loadVideo(currentId)
		} else if (app.queueEngine.getQueueSnapshot().queue.isNotEmpty()) {
			val first = app.queueEngine.getQueueSnapshot().queue.first()
			app.queueEngine.playNow(first.id)
		} else {
			webView.loadUrl("https://www.youtube.com")
		}
	}

	override fun onSaveInstanceState(outState: Bundle) {
		super.onSaveInstanceState(outState)
		outState.putBoolean(SAVED_STARTED, showStarted)
	}

	override fun onDestroy() {
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
		private const val SAVED_STARTED = "show_started"
	}
}
