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

	@Volatile
	var showActive: Boolean = false

	var onRequestStartShow: (() -> Unit)? = null
	var onSeekRequested: ((Double) -> Unit)? = null

	/**
	 * LocalPlayerController settable from MainActivity once ExoPlayer is ready.
	 * This is set before startShow is ever called.
	 */
	var localPlayerController: LocalPlayerController? = null

	override fun onCreate() {
		super.onCreate()
		instance = this
		preferences = PlayerPreferences(this)
		migrateTrustedUserAgentIfNeeded()
		queueEngine = QueueEngine(this)
		dataClient = YouTubeDataClient(preferences)
		playlistSync =
			PlaylistSyncManager(appScope, preferences, dataClient, queueEngine)

		val localPlayer = object : LocalPlayerController {
			override fun play(): Boolean {
				localPlayerController?.play()
				return true
			}

			override fun pause(): Boolean {
				localPlayerController?.pause()
				return true
			}

			override fun seek(seconds: Double): Boolean {
				localPlayerController?.seek(seconds)
				return true
			}

			override fun setVolume(level: Double): Boolean {
				localPlayerController?.setVolume(level)
				return true
			}

			override fun skipNext(): Boolean {
				onRequestStartShow?.invoke()
				queueEngine.skipNext("transport-skip")
				return true
			}

			override fun skipPrev(): Boolean {
				onRequestStartShow?.invoke()
				queueEngine.skipPrev("transport-skip")
				return true
			}

			override fun needsVideoLoad(videoId: String): Boolean {
				return localPlayerController?.needsVideoLoad(videoId) ?: true
			}

			override fun loadVideo(videoId: String) {
				onRequestStartShow?.invoke()
			}

			override fun getCurrentTime(): Double {
				return localPlayerController?.getCurrentTime() ?: 0.0
			}

			override fun getDuration(): Double {
				return localPlayerController?.getDuration() ?: 0.0
			}

			override fun isPlaying(): Boolean {
				return localPlayerController?.isPlaying() ?: false
			}

			override fun listCaptions(): JSONArray {
				return localPlayerController?.listCaptions() ?: JSONArray()
			}

			override fun setCaption(index: Int) {
				localPlayerController?.setCaption(index)
			}

			override fun setCaptionOff() {
				localPlayerController?.setCaptionOff()
			}
		}

		djHttpServer =
			DjHttpServer(
				context = this,
				hostIpProvider = { NetworkUtils.getLocalIpAddress(this) },
				queueEngine = queueEngine,
				localPlayer = localPlayer,
				preferences = preferences,
				playlistSync = playlistSync,
				dataClient = dataClient,
				statusProvider = { buildHostStatus() },
			)
		playbackSupervisor =
			PlaybackSupervisor(
				queueEngine = queueEngine,
				localPlayer = localPlayer,
			)
		djHttpServer.onTransportAdvance = {
			playbackSupervisor.clearLoadState()
			queueEngine.clearCurrentError()
		}
		djHttpServer.onPlaybackRequested = {
			onRequestStartShow?.invoke()
		}
		queueEngine.onLoadVideo = { videoId ->
			playbackSupervisor.onLoadStarted(videoId)
			onRequestStartShow?.invoke()
		}
		queueEngine.onSeekVideo = { seconds ->
			if (onSeekRequested != null) {
				onSeekRequested?.invoke(seconds)
			} else {
				localPlayerController?.seek(seconds)
			}
			queueEngine.setPlaybackProgress(seconds, queueEngine.duration)
		}
		playlistSync.startPollingIfEnabled()
		startHostServices()
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
