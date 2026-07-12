package com.karol.player

import android.app.Application
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import org.json.JSONArray

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
	lateinit var playbackSupervisor: PlaybackSupervisor
		private set

	private var mdnsAdvertiser: KarolMdnsAdvertiser? = null

	var youtubeBridge: YouTubeKioskBridge? = null
		private set

	@Volatile
	var showActive: Boolean = false

	var onRequestStartShow: (() -> Unit)? = null
	var onSeekRequested: ((Double) -> Unit)? = null

	override fun onCreate() {
		super.onCreate()
		instance = this
		preferences = PlayerPreferences(this)
		migrateTrustedUserAgentIfNeeded()
		YouTubeSessionBackup.tryRestoreOnStartup(this)
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

					override fun needsVideoLoad(videoId: String): Boolean =
						youtubeBridge?.needsVideoLoad(videoId) ?: true

				override fun getLastKnownPlaybackTime(): Double =
					youtubeBridge?.getLastKnownPlaybackTime() ?: 0.0

				override fun listCaptions(): JSONArray =
					youtubeBridge?.listCaptions() ?: JSONArray()

				override fun setCaption(index: Int) {
					youtubeBridge?.setCaption(index)
				}

				override fun setCaptionOff() {
					youtubeBridge?.setCaptionOff()
				}

					override val isReady: Boolean
						get() = youtubeBridge?.isReady == true
				},
				preferences = preferences,
				playlistSync = playlistSync,
				dataClient = dataClient,
				statusProvider = { buildHostStatus() },
			)
		playbackSupervisor =
			PlaybackSupervisor(
				queueEngine = queueEngine,
				onNudgePlayback = {
					youtubeBridge?.setVolume(djHttpServer.volumeLevel)
					youtubeBridge?.play()
				},
				onSoftRecover = {
					youtubeBridge?.setVolume(djHttpServer.volumeLevel)
					youtubeBridge?.softRecoverPlayback()
				},
				onHardReload = {
					queueEngine.getCurrentVideoId()?.let { videoId ->
						youtubeBridge?.loadVideo(videoId)
					}
				},
			)
		djHttpServer.onTransportAdvance = {
			playbackSupervisor.clearLoadState()
			queueEngine.clearCurrentError()
		}
		djHttpServer.onPlaybackRequested = {
			onRequestStartShow?.invoke()
		}
		queueEngine.onLoadVideo = { videoId ->
			// #region agent log
			if (BuildConfig.DEBUG) {
			Log.i(
				"KarolDbg",
				org.json.JSONObject()
					.put("sessionId", "25b906")
					.put("hypothesisId", "H5")
					.put("location", "PlayerApp.onLoadVideo")
					.put("message", "queue-advance-load")
					.put(
						"data",
						org.json.JSONObject()
							.put("videoId", videoId)
							.put("showActive", showActive),
					)
					.put("timestamp", System.currentTimeMillis())
					.toString(),
			)
			}
			// #endregion
			playbackSupervisor.onLoadStarted(videoId)
			djHttpServer.invalidatePlaybackSnapshot()
			if (showActive) {
				youtubeBridge?.setVolume(djHttpServer.volumeLevel)
			}
			onRequestStartShow?.invoke()
		}
		queueEngine.onSeekVideo = { seconds ->
			if (onSeekRequested != null) {
				onSeekRequested?.invoke(seconds)
			} else {
				youtubeBridge?.seek(seconds)
			}
			queueEngine.setPlaybackProgress(seconds, queueEngine.duration)
		}
		playlistSync.startPollingIfEnabled()
		startHostServices()
	}

	fun attachBridge(bridge: YouTubeKioskBridge) {
		youtubeBridge = bridge
		bridge.syncVolumeLevel(djHttpServer.volumeLevel)
		bridge.setOnVideoEndedListener {
			queueEngine.onVideoEnded("ended-confirmed")
		}
		bridge.setOnInterstitialListener { url ->
			playbackSupervisor.onInterstitial(url)
		}
	}

	fun applySnapshot(snapshot: PlayerSnapshot) {
		val resolved = djHttpServer.reconcileSnapshotProgress(snapshot)
		djHttpServer.latestSnapshot = resolved
		djHttpServer.notePlaybackSample(resolved)
		playbackSupervisor.onSnapshot(resolved)
		if (resolved.hasVideo) {
			queueEngine.setPlaybackProgress(resolved.currentTime, resolved.duration)
			if (resolved.state == 1 || resolved.state == 2) {
				val title =
					resolved.title.ifBlank {
						queueEngine.queue.getOrNull(queueEngine.currentIndex)?.title ?: ""
					}
				queueEngine.setNowPlaying(
					title,
					resolveThumbnail(resolved),
					resolved.currentTime,
					resolved.duration,
				)
			}
			// Update thumbnail any time a new videoId is seen, regardless of state
			if (resolved.videoId.isNotBlank()) {
				val thumb = resolveThumbnail(resolved)
				if (thumb.isNotBlank() && thumb != queueEngine.currentThumbnail) {
					queueEngine.currentThumbnail = thumb
				}
			}
		}
	}

	private fun resolveThumbnail(snapshot: PlayerSnapshot): String {
		if (snapshot.thumbnail.isNotBlank()) {
			return snapshot.thumbnail
		}
		if (snapshot.videoId.isNotBlank()) {
			return "https://i.ytimg.com/vi/${snapshot.videoId}/default.jpg"
		}
		return queueEngine.currentThumbnail
	}

	fun startHostServices() {
		djHttpServer.start()
		if (mdnsAdvertiser == null) {
			mdnsAdvertiser = KarolMdnsAdvertiser(this).also { it.start() }
		}
	}

	fun startForegroundHost() {
		PlayerForegroundService.start(this)
	}

	fun buildHostStatus(): HostStatus =
		HostStatus(
			showActive = showActive,
			queueLength = queueEngine.queue.size,
			currentTitle = queueEngine.currentTitle,
			interstitialMessage = playbackSupervisor.interstitialMessage,
			lastPlaybackError =
				queueEngine.queue
					.getOrNull(queueEngine.currentIndex)
					?.errorReason,
		)

	private fun migrateTrustedUserAgentIfNeeded() {
		val version = preferences.getTrustedUserAgentVersion()
		if (version >= TRUSTED_UA_VERSION) {
			return
		}
		preferences.setTrustedUserAgentVersion(TRUSTED_UA_VERSION)
		preferences.setYouTubePremiumVerified(false)
		YouTubeSessionHelper.clearPremiumCache()
	}

	companion object {
		var instance: PlayerApp? = null
		private const val TRUSTED_UA_VERSION = 1
	}
}

data class HostStatus(
	val showActive: Boolean,
	val queueLength: Int,
	val currentTitle: String,
	val interstitialMessage: String?,
	val lastPlaybackError: String?,
)
