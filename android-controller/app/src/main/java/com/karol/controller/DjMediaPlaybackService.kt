package com.karol.controller

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.IBinder
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.media.VolumeProviderCompat
import androidx.core.app.NotificationCompat
import androidx.media.app.NotificationCompat.MediaStyle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class DjMediaPlaybackService : Service() {
	private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
	private lateinit var mediaSession: MediaSessionCompat
	private var pollJob: Job? = null
	private var artworkJob: Job? = null
	private var apiBase: String = ""
	private var lastTitle: String = ""
	private var lastIsPlaying: Boolean = false
	private var lastArtworkVideoId: String = ""
	private var cachedArtwork: Bitmap? = null
	private var consecutivePollFailures = 0
	private var pollIntervalMs = POLL_INTERVAL_MS
	private var playerUnreachable = false
	private lateinit var volumeProvider: VolumeProviderCompat
	private var lastNowPlaying: DjNowPlaying? = null
	private var lastPublishAtMs = 0L
	private var positionTickJob: Job? = null

	override fun onCreate() {
		super.onCreate()
		createNotificationChannel()
		volumeProvider = createVolumeProvider()
		mediaSession =
			MediaSessionCompat(this, TAG).apply {
				setFlags(
					MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS or
						MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS,
				)
				setPlaybackToRemote(volumeProvider)
				setCallback(sessionCallback)
				isActive = true
			}
		RemoteVolumeController.addListener(volumeListener)
		PlaybackStateRelay.addListener(webViewRelayListener)
		restoreApiBase()
		if (apiBase.isNotBlank()) {
			startPolling()
			startForeground(NOTIFICATION_ID, buildNotification(null))
		}
	}

	override fun onStartCommand(
		intent: Intent?,
		flags: Int,
		startId: Int,
	): Int {
		when (intent?.action) {
			ACTION_STOP -> {
				clearApiBase()
				stopSelf()
				return START_NOT_STICKY
			}
			ACTION_PLAY -> serviceScope.launch { runTransport("play") { DjApiClient.play(apiBase) } }
			ACTION_PAUSE -> serviceScope.launch { runTransport("pause") { DjApiClient.pause(apiBase) } }
			ACTION_SKIP_NEXT -> serviceScope.launch { runTransport("skip-next") { DjApiClient.skipNext(apiBase) } }
			ACTION_SKIP_PREV -> serviceScope.launch { runTransport("skip-prev") { DjApiClient.skipPrev(apiBase) } }
			else -> {
				val controllerUrl = intent?.getStringExtra(EXTRA_CONTROLLER_URL).orEmpty()
				val nextBase = DjApiClient.apiBaseFromControllerUrl(controllerUrl)
				if (!nextBase.isNullOrBlank()) {
					persistApiBase(nextBase)
					RemoteVolumeController.bindApiBase(nextBase)
					serviceScope.launch { RemoteVolumeController.seedFromTablet(nextBase) }
					startPolling()
				}
			}
		}
		ensureApiBase()
		startForeground(NOTIFICATION_ID, buildNotification(null))
		return START_STICKY
	}

	override fun onDestroy() {
		PlaybackStateRelay.removeListener(webViewRelayListener)
		RemoteVolumeController.removeListener(volumeListener)
		pollJob?.cancel()
		positionTickJob?.cancel()
		artworkJob?.cancel()
		serviceScope.cancel()
		mediaSession.run {
			isActive = false
			release()
		}
		super.onDestroy()
	}

	override fun onBind(intent: Intent?): IBinder? = null

	private val sessionCallback =
		object : MediaSessionCompat.Callback() {
			override fun onPlay() {
				serviceScope.launch { runTransport("play") { DjApiClient.play(apiBase) } }
			}

			override fun onPause() {
				serviceScope.launch { runTransport("pause") { DjApiClient.pause(apiBase) } }
			}

			override fun onSkipToNext() {
				serviceScope.launch { runTransport("skip-next") { DjApiClient.skipNext(apiBase) } }
			}

			override fun onSkipToPrevious() {
				serviceScope.launch { runTransport("skip-prev") { DjApiClient.skipPrev(apiBase) } }
			}

			override fun onSeekTo(pos: Long) {
				val seconds = pos.coerceAtLeast(0L) / 1000.0
				// #region agent log
				ControllerDbg.log(
					"H11",
					"DjMediaPlaybackService.onSeekTo",
					"notification-seek",
					mapOf("posMs" to pos, "seconds" to seconds),
				)
				// #endregion
				serviceScope.launch {
					runTransport("seek") { DjApiClient.seek(apiBase, seconds) }
				}
			}
		}

	private suspend fun runTransport(
		command: String,
		action: suspend () -> TransportResult,
	) {
		ensureApiBase()
		if (apiBase.isBlank()) {
			return
		}
		// #region agent log
		ControllerDbg.log(
			"H2",
			"DjMediaPlaybackService.runTransport",
			"command-start",
			mapOf(
				"command" to command,
				"preState" to lastNowPlaying?.state,
				"preVideoId" to lastNowPlaying?.videoId,
			),
		)
		// #endregion
		val result = action()
		if (result.nowPlaying != null) {
			publishNowPlaying(result.nowPlaying)
			// #region agent log
			ControllerDbg.log(
				"H2",
				"DjMediaPlaybackService.runTransport",
				"inline-now-playing",
				mapOf(
					"command" to command,
					"state" to result.nowPlaying.state,
					"videoId" to result.nowPlaying.videoId,
				),
			)
			// #endregion
			return
		}
		if (result.ok) {
			delay(200)
			refreshNowPlaying()
		}
	}

	private fun startPolling() {
		pollJob?.cancel()
		positionTickJob?.cancel()
		pollIntervalMs = POLL_INTERVAL_MS
		consecutivePollFailures = 0
		playerUnreachable = false
		pollJob =
			serviceScope.launch {
				while (isActive && apiBase.isNotBlank()) {
					refreshNowPlaying()
					delay(pollIntervalMs)
				}
			}
		positionTickJob =
			serviceScope.launch {
				while (isActive && apiBase.isNotBlank()) {
					val np = lastNowPlaying
					if (np != null && np.isPlaying && np.durationSec > 0) {
						publishNowPlaying(np, extrapolate = false)
					}
					delay(POSITION_TICK_MS)
				}
			}
	}

	private suspend fun refreshNowPlaying() {
		ensureApiBase()
		if (apiBase.isBlank()) {
			return
		}
		val nowPlaying = DjApiClient.fetchNowPlaying(apiBase)
		if (nowPlaying == null) {
			consecutivePollFailures++
			playerUnreachable = consecutivePollFailures >= 3
			pollIntervalMs =
				when {
					consecutivePollFailures >= 6 -> 15_000L
					consecutivePollFailures >= 3 -> 5_000L
					else -> POLL_INTERVAL_MS
				}
		} else {
			consecutivePollFailures = 0
			playerUnreachable = false
			pollIntervalMs = POLL_INTERVAL_MS
			DjApiClient.fetchVolumeLevel(apiBase)?.let { RemoteVolumeController.syncFromTablet(it) }
		}
		publishNowPlaying(nowPlaying)
	}

	private fun createVolumeProvider(): VolumeProviderCompat {
		val initial = RemoteVolumeController.levelToSteps(RemoteVolumeController.remoteLevel)
		return object : VolumeProviderCompat(
			VolumeProviderCompat.VOLUME_CONTROL_ABSOLUTE,
			RemoteVolumeController.MAX_VOLUME_STEPS,
			initial,
		) {
			override fun onSetVolumeTo(volume: Int) {
				RemoteVolumeController.setLevel(RemoteVolumeController.stepsToLevel(volume))
			}

			override fun onAdjustVolume(direction: Int) {
				RemoteVolumeController.adjustVolume(direction)
			}
		}
	}

	private val volumeListener: (Double) -> Unit = { level ->
		volumeProvider.setCurrentVolume(RemoteVolumeController.levelToSteps(level))
	}

	private val webViewRelayListener: (DjNowPlaying?, PlaybackStateRelay.Source) -> Unit =
		{ nowPlaying, source ->
			if (source == PlaybackStateRelay.Source.WEBVIEW && nowPlaying != null) {
				// #region agent log
				ControllerDbg.log(
					"H2",
					"DjMediaPlaybackService.webViewRelayListener",
					"apply-webview-state",
					mapOf(
						"state" to nowPlaying.state,
						"videoId" to nowPlaying.videoId,
					),
				)
				// #endregion
				publishNowPlaying(nowPlaying)
			}
		}

	private fun publishNowPlaying(
		nowPlaying: DjNowPlaying?,
		extrapolate: Boolean = false,
	) {
		if (nowPlaying == null) {
			updateSession(null)
			val manager = getSystemService(NotificationManager::class.java)
			manager.notify(NOTIFICATION_ID, buildNotification(null))
			return
		}

		val trackChanged =
			lastNowPlaying != null &&
				lastNowPlaying!!.videoId.isNotBlank() &&
				nowPlaying.videoId.isNotBlank() &&
				lastNowPlaying!!.videoId != nowPlaying.videoId
		val unchanged =
			!extrapolate &&
				!trackChanged &&
				lastNowPlaying != null &&
				lastNowPlaying!!.videoId == nowPlaying.videoId &&
				lastNowPlaying!!.state == nowPlaying.state &&
				kotlin.math.abs(lastNowPlaying!!.currentTimeSec - nowPlaying.currentTimeSec) < 1.0

		if (!unchanged) {
			lastNowPlaying = nowPlaying
			if (!extrapolate || trackChanged) {
				lastPublishAtMs = System.currentTimeMillis()
			}
			if (!extrapolate) {
				PlaybackStateRelay.publish(nowPlaying, PlaybackStateRelay.Source.NOTIFICATION)
			}
		}

		val resolvedSec = resolvedPositionMs(nowPlaying, extrapolate) / 1000.0
		val resolved = nowPlaying.copy(currentTimeSec = resolvedSec)
		val resolvedPosMs = resolvedPositionMs(nowPlaying, extrapolate)
		updateSession(nowPlaying, extrapolate)

		if (extrapolate || !unchanged) {
			PlaybackStateRelay.publishPosition(resolved)
			// #region agent log
			if (extrapolate) {
				ControllerDbg.log(
					"H7",
					"DjMediaPlaybackService.publishNowPlaying",
					"position-tick",
					mapOf(
						"apiTime" to nowPlaying.currentTimeSec,
						"resolvedTime" to resolvedSec,
						"videoId" to nowPlaying.videoId,
					),
				)
			}
			// #endregion
		}

		if (!extrapolate && !unchanged) {
			loadArtworkIfNeeded(nowPlaying)
			// #region agent log
			ControllerDbg.log(
				"H1",
				"DjMediaPlaybackService.publishNowPlaying",
				"published",
				mapOf(
					"extrapolate" to false,
					"apiTime" to nowPlaying.currentTimeSec,
					"resolvedTime" to resolvedSec,
					"state" to nowPlaying.state,
					"videoId" to nowPlaying.videoId,
				),
			)
			// #endregion
		}

		val manager = getSystemService(NotificationManager::class.java)
		manager.notify(NOTIFICATION_ID, buildNotification(nowPlaying, resolvedPosMs))
	}

	private fun resolvedPositionMs(
		nowPlaying: DjNowPlaying,
		extrapolate: Boolean,
	): Long {
		val baseMs = (nowPlaying.currentTimeSec * 1000).toLong().coerceAtLeast(0L)
		if (!extrapolate || !nowPlaying.isPlaying) {
			return baseMs
		}
		val elapsed = System.currentTimeMillis() - lastPublishAtMs
		val durationMs = (nowPlaying.durationSec * 1000).toLong()
		val next = baseMs + elapsed
		return if (durationMs > 0) next.coerceAtMost(durationMs) else next
	}

	private fun loadArtworkIfNeeded(nowPlaying: DjNowPlaying?) {
		val videoId = nowPlaying?.videoId.orEmpty()
		if (videoId.isBlank() || videoId == lastArtworkVideoId) {
			return
		}
		lastArtworkVideoId = videoId
		val thumbnailUrl =
			nowPlaying?.thumbnailUrl?.takeIf { it.isNotBlank() }
				?: "https://i.ytimg.com/vi/$videoId/hqdefault.jpg"
		artworkJob?.cancel()
		artworkJob =
			serviceScope.launch {
				val bitmap = DjApiClient.loadBitmap(thumbnailUrl) ?: return@launch
				cachedArtwork = bitmap
				val latest = DjApiClient.fetchNowPlaying(apiBase)
				updateSession(latest)
				getSystemService(NotificationManager::class.java)
					.notify(NOTIFICATION_ID, buildNotification(latest))
			}
	}

	private fun updateSession(
		nowPlaying: DjNowPlaying?,
		extrapolate: Boolean = false,
	) {
		if (nowPlaying == null) {
			mediaSession.setPlaybackState(
				PlaybackStateCompat.Builder()
					.setActions(transportActions)
					.setState(PlaybackStateCompat.STATE_NONE, 0, 0f)
					.build(),
			)
			return
		}

		val durationMs =
			if (nowPlaying.durationSec > 0) {
				(nowPlaying.durationSec * 1000).toLong()
			} else {
				0L
			}
		val positionMs = resolvedPositionMs(nowPlaying, extrapolate)

		val metadataBuilder =
			MediaMetadataCompat.Builder()
				.putString(MediaMetadataCompat.METADATA_KEY_TITLE, nowPlaying.title.ifBlank { "Karol DJ" })
				.putString(MediaMetadataCompat.METADATA_KEY_ARTIST, getString(R.string.notification_artist))
				.putString(MediaMetadataCompat.METADATA_KEY_ALBUM, getString(R.string.app_name))
				.apply {
					if (durationMs > 0) {
						putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs)
					}
					if (nowPlaying.videoId.isNotBlank()) {
						putString(
							MediaMetadataCompat.METADATA_KEY_MEDIA_URI,
							"https://www.youtube.com/watch?v=${nowPlaying.videoId}",
						)
					}
					cachedArtwork?.let { putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it) }
				}
		mediaSession.setMetadata(metadataBuilder.build())

		val playbackState =
			when {
				nowPlaying.isPlaying ->
					PlaybackStateCompat.STATE_PLAYING
				nowPlaying.isPaused ->
					PlaybackStateCompat.STATE_PAUSED
				nowPlaying.state == 0 ->
					PlaybackStateCompat.STATE_STOPPED
				else ->
					PlaybackStateCompat.STATE_PAUSED
			}

		mediaSession.setPlaybackState(
			PlaybackStateCompat.Builder()
				.setActions(transportActions)
				.setState(playbackState, positionMs, if (nowPlaying.isPlaying) 1f else 0f)
				.build(),
		)

		lastTitle = nowPlaying.title
		lastIsPlaying = nowPlaying.isPlaying
	}

	private fun buildNotification(nowPlaying: DjNowPlaying?, positionMs: Long = 0L): Notification {
		val title =
			nowPlaying?.title?.takeIf { it.isNotBlank() }
				?: lastTitle.takeIf { it.isNotBlank() }
				?: getString(R.string.notification_idle_title)
		val subtitle =
			when {
				playerUnreachable -> getString(R.string.notification_unreachable)
				nowPlaying?.isPlaying == true -> getString(R.string.notification_playing)
				nowPlaying?.isPaused == true -> getString(R.string.notification_paused)
				lastIsPlaying -> getString(R.string.notification_playing)
				else -> getString(R.string.notification_ready)
			}

		val contentIntent =
			PendingIntent.getActivity(
				this,
				0,
				Intent(this, MainActivity::class.java).apply {
					flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
				},
				PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
			)

		val showPause =
			when {
				playerUnreachable -> lastIsPlaying
				nowPlaying?.isPlaying == true -> true
				nowPlaying?.isPaused == true -> false
				nowPlaying == null -> lastIsPlaying
				else -> false
			}
		val playPauseAction =
			if (showPause) {
				NotificationCompat.Action(
					android.R.drawable.ic_media_pause,
					getString(R.string.notification_action_pause),
					servicePendingIntent(ACTION_PAUSE),
				)
			} else {
				NotificationCompat.Action(
					android.R.drawable.ic_media_play,
					getString(R.string.notification_action_play),
					servicePendingIntent(ACTION_PLAY),
				)
			}

		val builder =
			NotificationCompat.Builder(this, CHANNEL_ID)
				.setSmallIcon(R.drawable.ic_stat_media)
				.setContentTitle(title)
				.setContentText(subtitle)
				.setSubText(getString(R.string.app_name))
				.apply {
					val durationSec = nowPlaying?.durationSec ?: 0.0
					val durationMs = (durationSec * 1000).toInt()
					if (durationMs > 0 && nowPlaying != null) {
						setProgress(durationMs, positionMs.toInt().coerceIn(0, durationMs), false)
					} else {
						setProgress(0, 0, true)
					}
				}
				.setContentIntent(contentIntent)
				.setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
				.setCategory(NotificationCompat.CATEGORY_TRANSPORT)
				.setPriority(NotificationCompat.PRIORITY_DEFAULT)
				.setOnlyAlertOnce(true)
				.setOngoing(true)
				.setShowWhen(false)
				.addAction(
					NotificationCompat.Action(
						android.R.drawable.ic_media_previous,
						getString(R.string.notification_action_previous),
						servicePendingIntent(ACTION_SKIP_PREV),
					),
				)
				.addAction(playPauseAction)
				.addAction(
					NotificationCompat.Action(
						android.R.drawable.ic_media_next,
						getString(R.string.notification_action_next),
						servicePendingIntent(ACTION_SKIP_NEXT),
					),
				)
				.addAction(
					NotificationCompat.Action(
						android.R.drawable.ic_menu_close_clear_cancel,
						getString(R.string.notification_action_disconnect),
						servicePendingIntent(ACTION_STOP),
					),
				)
				.setStyle(
					MediaStyle()
						.setMediaSession(mediaSession.sessionToken)
						.setShowActionsInCompactView(0, 1, 2),
				)

		cachedArtwork?.let { builder.setLargeIcon(it) }
			?: builder.setLargeIcon(BitmapFactory.decodeResource(resources, R.mipmap.ic_launcher))

		return builder.build()
	}

	private fun servicePendingIntent(action: String): PendingIntent =
		PendingIntent.getService(
			this,
			action.hashCode(),
			Intent(this, DjMediaPlaybackService::class.java).setAction(action),
			PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
		)

	private fun createNotificationChannel() {
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
			return
		}
		val channel =
			NotificationChannel(
				CHANNEL_ID,
				getString(R.string.notification_channel_name),
				NotificationManager.IMPORTANCE_DEFAULT,
			).apply {
				description = getString(R.string.notification_channel_desc)
				setShowBadge(false)
				lockscreenVisibility = Notification.VISIBILITY_PUBLIC
			}
		val manager = getSystemService(NotificationManager::class.java)
		manager.createNotificationChannel(channel)
	}

	private fun prefs() = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

	private fun persistApiBase(base: String) {
		apiBase = base
		RemoteVolumeController.bindApiBase(base)
		prefs().edit().putString(KEY_API_BASE, base).apply()
	}

	private fun restoreApiBase() {
		apiBase = prefs().getString(KEY_API_BASE, "").orEmpty()
	}

	private fun clearApiBase() {
		apiBase = ""
		lastArtworkVideoId = ""
		cachedArtwork = null
		RemoteVolumeController.clear()
		prefs().edit().remove(KEY_API_BASE).apply()
	}

	private fun ensureApiBase() {
		if (apiBase.isBlank()) {
			restoreApiBase()
		}
	}

	companion object {
		private const val TAG = "DjMediaPlayback"
		private const val PREFS_NAME = "karol_dj_playback"
		private const val KEY_API_BASE = "api_base"
		private const val CHANNEL_ID = "karol_dj_playback"
		private const val NOTIFICATION_ID = 42
		private const val POLL_INTERVAL_MS = 500L
		private const val POSITION_TICK_MS = 500L
		private const val EXTRA_CONTROLLER_URL = "controller_url"

		private const val ACTION_PLAY = "com.karol.controller.action.PLAY"
		private const val ACTION_PAUSE = "com.karol.controller.action.PAUSE"
		private const val ACTION_SKIP_NEXT = "com.karol.controller.action.SKIP_NEXT"
		private const val ACTION_SKIP_PREV = "com.karol.controller.action.SKIP_PREV"
		private const val ACTION_STOP = "com.karol.controller.action.STOP"

		private const val transportActions =
			PlaybackStateCompat.ACTION_PLAY or
				PlaybackStateCompat.ACTION_PAUSE or
				PlaybackStateCompat.ACTION_PLAY_PAUSE or
				PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
				PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
				PlaybackStateCompat.ACTION_SEEK_TO

		fun start(
			context: Context,
			controllerUrl: String,
		) {
			val intent =
				Intent(context, DjMediaPlaybackService::class.java).apply {
					putExtra(EXTRA_CONTROLLER_URL, controllerUrl)
				}
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
				context.startForegroundService(intent)
			} else {
				context.startService(intent)
			}
		}

		fun stop(context: Context) {
			context.stopService(
				Intent(context, DjMediaPlaybackService::class.java).setAction(ACTION_STOP),
			)
		}
	}
}
