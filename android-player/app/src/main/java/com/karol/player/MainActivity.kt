package com.karol.player

import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.Player
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.SimpleCache
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import java.io.File

class MainActivity : AppCompatActivity() {

	private lateinit var loadingOverlay: FrameLayout
	private lateinit var loadingPercentText: TextView
	private lateinit var loadingProgressBar: android.widget.ProgressBar
	private lateinit var loadingTitleText: TextView
	private lateinit var loadingDetailText: TextView

	private val mainHandler = Handler(Looper.getMainLooper())
	private var immersiveJob: Job? = null

	private var exoPlayer: ExoPlayer? = null
	private lateinit var playerView: PlayerView
	private lateinit var videoDownloadManager: VideoDownloadManager
	private var localPlaybackActive = false
	private var currentLocalVideoId: String? = null
	private var downloadingVideoId: String? = null
	private var preloadingVideoId: String? = null // next video being preloaded
	private var progressJob: Job? = null

	private val notificationPermissionLauncher =
		registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

	// Queue marquee — continuously scrolls upcoming singers
	private lateinit var queueMarquee: MarqueeView
	private var marqueeJob: Job? = null

	// Karaoke lyric overlay
	private lateinit var lyricOverlay: FrameLayout
	private lateinit var lyricCountdown: TextView
	private lateinit var lyricActiveText: TextView
	private lateinit var lyricPreviewText: TextView
	private val lyricEngine = LyricEngine()

	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		WindowCompat.setDecorFitsSystemWindows(window, false)
		window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
		setContentView(R.layout.activity_main)
		enterImmersiveMode()

		loadingOverlay = findViewById(R.id.loadingOverlay)
		loadingPercentText = findViewById(R.id.loadingPercentText)
		loadingProgressBar = findViewById(R.id.loadingProgressBar)
		loadingTitleText = findViewById(R.id.loadingTitleText)
		loadingDetailText = findViewById(R.id.loadingDetailText)
		playerView = findViewById(R.id.playerView)
		videoDownloadManager = VideoDownloadManager(this)
		videoDownloadManager.refreshMacHostAsync() // Fire-and-forget mDNS discovery

		initExoPlayer()
		wireController()
		requestRuntimePermissionsIfNeeded()
		(application as PlayerApp).startForegroundHost()
		startImmersiveEnforcer()

		// Always ready to play — the controller (S24/Mac) drives everything
		val app = application as PlayerApp
		app.showActive = true

		// Queue marquee
		queueMarquee = findViewById(R.id.queueMarquee)
		startMarqueeUpdater()

		// Karaoke lyric overlay views
		lyricOverlay = findViewById(R.id.lyricOverlay)
		lyricCountdown = findViewById(R.id.lyricCountdown)
		lyricActiveText = findViewById(R.id.lyricActiveText)
		lyricPreviewText = findViewById(R.id.lyricPreviewText)
	}

	private fun initExoPlayer() {
		// Disk cache: 500MB for video data — makes replays instant
		val cacheDir = File(cacheDir, "exoplayer-cache")
		if (!cacheDir.exists()) cacheDir.mkdirs()
		var cache: SimpleCache? = null
		try {
			cache = SimpleCache(cacheDir, androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor(500 * 1024 * 1024), StandaloneDatabaseProvider(this))
		} catch (e: Exception) {
		}
		val upstreamFactory = DefaultDataSource.Factory(this,
			DefaultHttpDataSource.Factory().setUserAgent("KarolPlayer/1.0"))
		val builder = if (cache != null) {
			val cacheFactory = CacheDataSource.Factory()
				.setCache(cache)
				.setUpstreamDataSourceFactory(upstreamFactory)
				.setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
			ExoPlayer.Builder(this).setMediaSourceFactory(DefaultMediaSourceFactory(cacheFactory))
		} else {
			ExoPlayer.Builder(this)
		}

		exoPlayer = builder.build()
		playerView.player = exoPlayer
		playerView.useController = false
		playerView.visibility = View.GONE

		exoPlayer?.addListener(object : Player.Listener {
			override fun onPlaybackStateChanged(state: Int) {
				if (state == Player.STATE_READY && exoPlayer?.playWhenReady == true) {
					// Video started — clear the PlaybackSupervisor watchdog and hide loading screen
					(application as PlayerApp).playbackSupervisor.clearLoadState()
					hideLoading()
					startProgressReporter()
					// Preload next video while current plays
					preloadNextVideo()
				}
				if (state == Player.STATE_ENDED) {
					progressJob?.cancel()
					Log.i("MainActivity", "ExoPlayer ended")
					val vid = currentLocalVideoId
					currentLocalVideoId = null
					localPlaybackActive = false
					// Clear karaoke lyrics
					runOnUiThread {
						lyricEngine.clear()
						lyricOverlay.visibility = View.GONE
					}
					// Don't delete cache — keep it for replay or next session
					mainHandler.postDelayed({
						val app = application as PlayerApp
						app.queueEngine.onVideoEnded("local-ended")
					}, 500L)
				}
			}
		})
	}

	private fun wireController() {
		val app = application as PlayerApp
		app.localPlayerController = object : LocalPlayerController {
			override fun play(): Boolean { runOnUiThread { exoPlayer?.play() }; return true }
			override fun pause(): Boolean { runOnUiThread { exoPlayer?.pause() }; return true }
			override fun seek(seconds: Double): Boolean {
				runOnUiThread { exoPlayer?.seekTo((seconds * 1000).toLong()) }; return true
			}
			override fun setVolume(level: Double): Boolean {
				runOnUiThread { exoPlayer?.volume = level.toFloat().coerceIn(0f, 1f) }; return true
			}
			override fun skipNext(): Boolean {
				app.queueEngine.skipNext("local-transport"); return true
			}
			override fun skipPrev(): Boolean {
				app.queueEngine.skipPrev("local-transport"); return true
			}
			override fun needsVideoLoad(videoId: String): Boolean = currentLocalVideoId != videoId && downloadingVideoId != videoId
			override fun loadVideo(videoId: String) { runOnUiThread { loadVideo(videoId) } }
			override fun getCurrentTime(): Double = (exoPlayer?.currentPosition?.toDouble() ?: 0.0) / 1000.0
			override fun getDuration(): Double = ((exoPlayer?.duration?.takeIf { it > 0 })?.toDouble() ?: 0.0) / 1000.0
			override fun isPlaying(): Boolean = exoPlayer?.isPlaying == true
			override fun listCaptions(): JSONArray {
				val arr = JSONArray()
				val vttFiles = videoDownloadManager.getLocalSubtitles(currentLocalVideoId ?: "")
				for (f in vttFiles) {
					val lang = f.name.replace("${currentLocalVideoId ?: ""}.", "").replace(".vtt", "")
					arr.put(JSONArray().put(lang).put(langToDisplay(lang)))
				}
				return arr
			}
			override fun setCaption(index: Int) {}
			override fun setCaptionOff() { disableSubtitles() }
			override fun loadLyrics(json: String) { runOnUiThread { lyricEngine.load(json) } }
			override fun clearLyrics() {
				runOnUiThread {
					lyricEngine.clear()
					lyricOverlay.visibility = View.GONE
					lyricCountdown.visibility = View.GONE
				}
			}
		}

		app.onRequestStartShow = { runOnUiThread { ensurePlaying() } }
		app.onSeekRequested = { seconds ->
			runOnUiThread {
				if (localPlaybackActive) exoPlayer?.seekTo((seconds * 1000).toLong())
			}
		}
	}

	private fun loadVideo(videoId: String) {
		val t0 = System.currentTimeMillis()
		Log.i("MainActivity", "loadVideo: $videoId")
		stopPlayback()
		downloadingVideoId = null

		// Already cached locally — play immediately
		val local = videoDownloadManager.getLocalFile(videoId)
		if (local != null) {
			hideLoading()
			playFile(local, videoId)
			fetchLyricsIfKaraoke(videoId)
			return
		}

		// ── Download from Mac then play locally (avoids unreliable live yt-dlp stream)
		downloadingVideoId = videoId
		showLoading()
		updateLoadingText(videoId, "Syncing from Mac...")
		fetchLyricsIfKaraoke(videoId)
		videoDownloadManager.download(videoId,
			onProgress = { pct ->
				runOnUiThread {
					val pctInt = (pct * 100).toInt().coerceIn(0, 100)
					loadingPercentText.text = "$pctInt%"
					loadingProgressBar.progress = pctInt
					if (pctInt < 100) {
						updateLoadingText(videoId, "Downloading from Mac...")
					} else {
						updateLoadingText(videoId, "Caching on device...")
					}
				}
			},
			onReady = { file, subs ->
				runOnUiThread {
					Log.i("MainActivity", "Downloaded: $videoId (${file.length()} bytes)")
					downloadingVideoId = null
					hideLoading()
					playFile(file, videoId)
				}
			},
			onError = { msg ->
				runOnUiThread {
					Log.w("MainActivity", "Download failed, retrying: $msg")
					downloadingVideoId = null
					// Retry once immediately — yt-dlp may still be downloading on Mac
					updateLoadingText(videoId, "Retrying download...")
					if (videoId == currentLocalVideoId || downloadingVideoId != videoId) {
						videoDownloadManager.download(videoId,
							onProgress = { pct ->
								runOnUiThread {
									val pctInt = (pct * 100).toInt().coerceIn(0, 100)
									loadingPercentText.text = "$pctInt%"
									loadingProgressBar.progress = pctInt
								}
							},
							onReady = { file, subs ->
								runOnUiThread {
									downloadingVideoId = null
									hideLoading()
									playFile(file, videoId)
								}
							},
							onError = { msg2 ->
								runOnUiThread {
									Log.e("MainActivity", "Second attempt failed: $msg2")
									downloadingVideoId = null
									hideLoading()
									val app = application as PlayerApp
									app.queueEngine.skipNext("download-failed-2x")
								}
							}
						)
					}
				}
			}
		)
	}

	private fun playFile(file: File, videoId: String) {
		Log.i("MainActivity", "playFile: $videoId (${file.length()} bytes)")
		localPlaybackActive = true
		currentLocalVideoId = videoId
		playerView.visibility = View.VISIBLE

		val vttFiles = videoDownloadManager.getLocalSubtitles(videoId)
		val subConfigs = vttFiles.map { f ->
			val lang = f.name.replace("$videoId.", "").replace(".vtt", "")
			MediaItem.SubtitleConfiguration.Builder(Uri.fromFile(f))
				.setMimeType(MimeTypes.TEXT_VTT).setLanguage(lang)
				.setLabel(langToDisplay(lang))
				.setSelectionFlags(if (lang.contains("en")) C.SELECTION_FLAG_DEFAULT else 0)
				.build()
		}
		exoPlayer?.setMediaItem(MediaItem.Builder()
			.setUri(Uri.fromFile(file)).setSubtitleConfigurations(subConfigs).build())
		exoPlayer?.prepare()
		exoPlayer?.playWhenReady = true
	}

	private fun playStream(url: String, videoId: String) {
		Log.i("MainActivity", "playStream: $videoId <- $url")
		localPlaybackActive = true
		currentLocalVideoId = videoId
		playerView.visibility = View.VISIBLE
		exoPlayer?.setMediaItem(MediaItem.Builder().setUri(Uri.parse(url)).build())
		exoPlayer?.prepare()
		exoPlayer?.playWhenReady = true
	}

	private fun stopPlayback() {
		if (localPlaybackActive) {
			exoPlayer?.stop()
			localPlaybackActive = false
			currentLocalVideoId = null
			playerView.visibility = View.GONE
		}
	}

	/** Preload next video into cache while current is playing */
	private fun preloadNextVideo() {
		try {
			val app = application as PlayerApp
			val nextId = app.queueEngine.getNextVideoId() ?: return
			if (nextId == preloadingVideoId) return // already preloading
			// Only preload if not already cached
			val local = videoDownloadManager.getLocalFile(nextId)
			if (local != null) return // already cached, instant
			preloadingVideoId = nextId
			Log.i("MainActivity", "Preloading next: $nextId")
			videoDownloadManager.download(nextId,
				onProgress = { _ -> },
				onReady = { _, _ ->
					Log.i("MainActivity", "Preload complete: $nextId")
					preloadingVideoId = null
				},
				onError = { msg ->
					Log.w("MainActivity", "Preload failed: $msg")
					preloadingVideoId = null
				}
			)
		} catch (_: Exception) {}
	}

	private fun disableSubtitles() {
		exoPlayer?.trackSelectionParameters = exoPlayer?.trackSelectionParameters
			?.buildUpon()?.clearOverridesOfType(C.TRACK_TYPE_TEXT)
			?.setPreferredTextLanguage(null)?.build() ?: return
	}

	private fun showLoading() {
		loadingPercentText.text = "0%"
		loadingProgressBar.progress = 0
		loadingTitleText.text = "Loading..."
		loadingDetailText.text = "Downloading from Mac..."
		loadingOverlay.visibility = View.VISIBLE
		loadingOverlay.alpha = 1f
	}

	private fun updateLoadingText(videoId: String, detail: String) {
		loadingTitleText.text = videoId
		loadingDetailText.text = detail
	}

	private fun hideLoading() {
		loadingOverlay.animate().alpha(0f).setDuration(200)
			.withEndAction { loadingOverlay.visibility = View.GONE }.start()
	}

	/** Poll ExoPlayer position+duration every 250ms and push to queue engine + lyric engine */
	private fun startProgressReporter() {
		progressJob?.cancel()
		progressJob = lifecycleScope.launch {
			while (isActive) {
				val p = exoPlayer ?: break
				if (p.isPlaying) {
					val t = p.currentPosition / 1000.0
					val d = p.duration.takeIf { it > 0 }?.let { it / 1000.0 } ?: -1.0
					val app = application as PlayerApp
					app.queueEngine.setPlaybackProgress(t, if (d > 0) d else app.queueEngine.duration)
					// Drive karaoke lyric overlay
					runOnUiThread { updateLyrics(t, true) }
				}
				delay(250L)
			}
		}
	}

	/** Apply LyricEngine render state to the overlay TextViews. */
	private fun updateLyrics(currentTimeSec: Double, isPlaying: Boolean) {
		val state = lyricEngine.update(currentTimeSec, isPlaying)
		if (!state.showOverlay) {
			lyricOverlay.visibility = View.GONE
			return
		}
		lyricOverlay.visibility = View.VISIBLE

		// Countdown
		if (state.countdownText != null) {
			lyricCountdown.visibility = View.VISIBLE
			lyricCountdown.text = state.countdownText
			lyricActiveText.visibility = View.GONE
			lyricPreviewText.visibility = View.GONE
		} else {
			lyricCountdown.visibility = View.GONE

			// Active lyric with progressive fill
			if (state.activeText != null) {
				lyricActiveText.visibility = View.VISIBLE
				lyricActiveText.text = state.activeText
			} else {
				lyricActiveText.visibility = View.GONE
			}

			// Preview (next) lyric
			if (state.previewText != null) {
				lyricPreviewText.visibility = View.VISIBLE
				lyricPreviewText.text = state.previewText
			} else {
				lyricPreviewText.visibility = View.GONE
			}
		}
	}

	/** Auto-fetch karaoke lyrics from the Mac API when a karaoke video loads. */
	private fun fetchLyricsIfKaraoke(videoId: String) {
		lifecycleScope.launch {
			try {
				val baseUrl = videoDownloadManager.getServerBaseUrl()
				val urlText = baseUrl + "/api/library/lyrics/" + videoId
				val url = java.net.URL(urlText)
				val conn = url.openConnection() as java.net.HttpURLConnection
				conn.connectTimeout = 8000
				conn.readTimeout = 8000
				if (conn.responseCode == 200) {
					val json = conn.inputStream.bufferedReader().readText()
					runOnUiThread { lyricEngine.load(json) }
					Log.i("MainActivity", "Auto-loaded lyrics for " + videoId)
				}
				conn.disconnect()
			} catch (e: Exception) {
				Log.i("MainActivity", "No lyrics for " + videoId + ": " + e.message)
				runOnUiThread {
					lyricEngine.clear()
					lyricOverlay.visibility = View.GONE
				}
			}
		}
	}

	private fun ensurePlaying() {
		val app = application as PlayerApp
		val id = app.queueEngine.getCurrentVideoId() ?: return
		// Don't reload while a download is already in progress for this video
		if (downloadingVideoId == id) return
		val playbackState = exoPlayer?.playbackState ?: Player.STATE_IDLE
		// If a video is already loaded and player is in READY/BUFFERING state,
		// just resume — don't restart from beginning
		if (id == currentLocalVideoId && playbackState == Player.STATE_READY) {
			exoPlayer?.play()
			return
		}
		if (id == currentLocalVideoId && playbackState == Player.STATE_BUFFERING) {
			exoPlayer?.playWhenReady = true
			return
		}
		// Otherwise, load the video (first time or new video)
		if (id != currentLocalVideoId || playbackState == Player.STATE_IDLE || playbackState == Player.STATE_ENDED) {
			loadVideo(id)
		}
	}

	private fun requestRuntimePermissionsIfNeeded() {
		val app = application as PlayerApp
		if (app.preferences.hasAskedRuntimePermissions()) return
		app.preferences.setAskedRuntimePermissions()
		if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
			if (ContextCompat.checkSelfPermission(this, android.Manifest.permission.POST_NOTIFICATIONS)
				!= android.content.pm.PackageManager.PERMISSION_GRANTED
			) {
				notificationPermissionLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
			}
		}
	}

	private fun startImmersiveEnforcer() {
		immersiveJob = lifecycleScope.launch {
			while (isActive) {
				runOnUiThread { enterImmersiveMode() }
				delay(5000L)
			}
		}
	}

	override fun onResume() { super.onResume(); enterImmersiveMode() }
	override fun onWindowFocusChanged(hasFocus: Boolean) {
		super.onWindowFocusChanged(hasFocus); if (hasFocus) enterImmersiveMode()
	}
	override fun onDestroy() {
		immersiveJob?.cancel()
		marqueeJob?.cancel()
		progressJob?.cancel()
		lyricEngine.clear()
		exoPlayer?.release(); exoPlayer = null
		super.onDestroy()
	}

	/** Update the bottom marquee with current queue showing singer + song with numbered order */
	private fun startMarqueeUpdater() {
		marqueeJob = lifecycleScope.launch {
			while (isActive) {
				val app = application as PlayerApp
				val q = app.queueEngine.queue
				val ci = app.queueEngine.currentIndex
				val sb = StringBuilder()

				// Current: "NOW: [Requester] — [Title]"
				if (ci in q.indices) {
					val cur = q[ci]
					val displayTitle = cur.title.take(70)
					val reqName = cur.requester?.take(25)
					sb.append("NOW: ")
					if (!reqName.isNullOrBlank()) {
						sb.append(reqName)
						sb.append("  \u2014  ")
					}
					sb.append(displayTitle)
				}

				// Upcoming (next 8) with numbered order
				val upcomingStart = ci + 1
				if (upcomingStart in q.indices) {
					sb.append("     \u25B6  UP NEXT: ")
					val upcoming = q.drop(upcomingStart).take(8)
					sb.append(upcoming.joinToString("     ") { item ->
						val idx = q.indexOf(item) + 1
						val name = item.requester?.take(18)
						val t = item.title.take(40)
						val prefix = "#$idx "
						if (!name.isNullOrBlank()) "$prefix$name: $t" else "$prefix$t"
					})
				}

				// Tip appended inline — scrolls as part of same continuous loop
				sb.append("     \uD83D\uDCB8  Tips: Venmo @karolpdx  |  CashApp \$karolpdx  \uD83D\uDCB8")

				runOnUiThread { queueMarquee.setMarqueeText(sb.toString()) }
				delay(4000L)
			}
		}
	}

	private fun enterImmersiveMode() {
		WindowInsetsControllerCompat(window, window.decorView).apply {
			hide(WindowInsetsCompat.Type.systemBars())
			systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
		}
		@Suppress("DEPRECATION")
		window.decorView.systemUiVisibility = (
			android.view.View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
			or android.view.View.SYSTEM_UI_FLAG_FULLSCREEN
			or android.view.View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
			or android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE
			or android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
			or android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
		)
	}

	private fun langToDisplay(lang: String): String = when (lang) {
		"en" -> "English"; "es" -> "Español"; "fr" -> "Français"; "de" -> "Deutsch"
		"ja" -> "日本語"; "ko" -> "한국어"; "zh" -> "中文"; "th" -> "ไทย"
		"pt" -> "Português"; "ru" -> "Русский"; "ar" -> "العربية"; "hi" -> "हिन्दी"
		else -> lang.uppercase()
	}

	companion object {
		const val EXTRA_AUTO_START_SHOW = "auto_start_show"
	}
}
