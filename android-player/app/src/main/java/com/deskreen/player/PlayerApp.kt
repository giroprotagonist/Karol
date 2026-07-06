package com.deskreen.player

import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob

class PlayerApp : Application() {
	val appScope = CoroutineScope(SupervisorJob())

	lateinit var preferences: PlayerPreferences
		private set
	lateinit var queueEngine: QueueEngine
		private set
	lateinit var dataClient: YouTubeDataClient
		private set
	lateinit var playlistSync: PlaylistSyncManager
		private set
	lateinit var djHttpServer: DjHttpServer
		private set

	var youtubeBridge: YouTubeKioskBridge? = null
		private set

	override fun onCreate() {
		super.onCreate()
		instance = this
		preferences = PlayerPreferences(this)
		queueEngine = QueueEngine(this)
		dataClient = YouTubeDataClient(preferences)
		playlistSync =
			PlaylistSyncManager(appScope, preferences, dataClient, queueEngine)
		djHttpServer =
			DjHttpServer(
				context = this,
				hostIpProvider = { NetworkUtils.getLocalIpAddress(this) },
				queueEngine = queueEngine,
				youtubeBridge = object : YouTubePlayerController {
					override fun loadVideo(videoId: String) {
						youtubeBridge?.loadVideo(videoId)
					}

					override fun play() {
						youtubeBridge?.play()
					}

					override fun pause() {
						youtubeBridge?.pause()
					}

					override fun seek(seconds: Double) {
						youtubeBridge?.seek(seconds)
					}

					override fun setVolume(level: Double) {
						youtubeBridge?.setVolume(level)
					}

					override fun getSnapshot(): PlayerSnapshot? = youtubeBridge?.getSnapshot()

					override val isReady: Boolean
						get() = youtubeBridge?.isReady == true
				},
				preferences = preferences,
				playlistSync = playlistSync,
				dataClient = dataClient,
			)
		queueEngine.onLoadVideo = { videoId ->
			youtubeBridge?.loadVideo(videoId)
		}
		playlistSync.startPollingIfEnabled()
	}

	fun attachBridge(bridge: YouTubeKioskBridge) {
		youtubeBridge = bridge
		bridge.setOnVideoEndedListener {
			queueEngine.onVideoEnded()
		}
	}

	fun applySnapshot(snapshot: PlayerSnapshot) {
		djHttpServer.latestSnapshot = snapshot
		if (snapshot.hasVideo) {
			queueEngine.setPlaybackProgress(snapshot.currentTime, snapshot.duration)
			if (snapshot.title.isNotBlank()) {
				val thumb =
					if (snapshot.videoId.isNotBlank()) {
						"https://i.ytimg.com/vi/${snapshot.videoId}/default.jpg"
					} else {
						""
					}
				queueEngine.setNowPlaying(
					snapshot.title,
					thumb,
					snapshot.currentTime,
					snapshot.duration,
				)
			}
		}
	}

	fun startHttpServer() {
		djHttpServer.start()
	}

	companion object {
		var instance: PlayerApp? = null
	}
}
