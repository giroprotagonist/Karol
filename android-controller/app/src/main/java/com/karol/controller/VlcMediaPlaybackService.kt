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

class VlcMediaPlaybackService : Service() {
	private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
	private lateinit var mediaSession: MediaSessionCompat
	private var pollJob: Job? = null
	private var artworkJob: Job? = null
	private var positionTickJob: Job? = null
	private var apiBase: String = ""
	private var lastTitle: String = ""
	private var lastIsPlaying: Boolean = false
	private var lastCoverUrl: String = ""
	private var cachedArtwork: Bitmap? = null
	private var consecutivePollFailures = 0
	private var pollIntervalMs = POLL_INTERVAL_MS
	private var playerUnreachable = false
	private var lastData: VlcNowPlayingData? = null
	private var lastPublishAtMs = 0L

	override fun onCreate() {
		super.onCreate()
		createNotificationChannel()
		mediaSession =
			MediaSessionCompat(this, TAG).apply {
				setFlags(
					MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS or
						MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS,
				)
				setCallback(sessionCallback)
				isActive = true
			}
		VlcPlaybackRelay.addListener(relayListener)
		restoreApiBase()
		if (apiBase.isNotBlank()) {
			startPolling()
			startForeground(NOTIFICATION_ID, buildNotification(null))
		}
	}

	override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
		when (intent?.action) {
			ACTION_STOP -> {
				clearApiBase()
				stopSelf()
				return START_NOT_STICKY
			}
			ACTION_PLAY -> serviceScope.launch { runTransport("play") { VlcApiClient.vlcPlay(apiBase) } }
			ACTION_PAUSE -> serviceScope.launch { runTransport("pause") { VlcApiClient.vlcPause(apiBase) } }
			ACTION_SKIP_NEXT -> serviceScope.launch { runTransport("skip-next") { VlcApiClient.vlcSkipNext(apiBase) } }
			ACTION_SKIP_PREV -> serviceScope.launch { runTransport("skip-prev") { VlcApiClient.vlcSkipPrev(apiBase) } }
			else -> {
				val controllerUrl = intent?.getStringExtra(EXTRA_CONTROLLER_URL).orEmpty()
				val nextBase = VlcApiClient.vlcApiBaseFromControllerUrl(controllerUrl)
				if (!nextBase.isNullOrBlank()) {
					persistApiBase(nextBase)
					startPolling()
				}
			}
		}
		ensureApiBase()
		startForeground(NOTIFICATION_ID, buildNotification(null))
		return START_STICKY
	}

	override fun onDestroy() {
		VlcPlaybackRelay.removeListener(relayListener)
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

	private val sessionCallback = object : MediaSessionCompat.Callback() {
		override fun onPlay() {
			serviceScope.launch { runTransport("play") { VlcApiClient.vlcPlay(apiBase) } }
		}
		override fun onPause() {
			serviceScope.launch { runTransport("pause") { VlcApiClient.vlcPause(apiBase) } }
		}
		override fun onSkipToNext() {
			serviceScope.launch { runTransport("skip-next") { VlcApiClient.vlcSkipNext(apiBase) } }
		}
		override fun onSkipToPrevious() {
			serviceScope.launch { runTransport("skip-prev") { VlcApiClient.vlcSkipPrev(apiBase) } }
		}
		override fun onSeekTo(pos: Long) {
			val seconds = pos.coerceAtLeast(0L) / 1000.0
			serviceScope.launch {
				VlcApiClient.vlcSeek(apiBase, seconds)
				delay(200)
				refreshNowPlaying()
			}
		}
	}

	private suspend fun runTransport(command: String, action: suspend () -> Boolean) {
		ensureApiBase()
		if (apiBase.isBlank()) return
		action()
		delay(200)
		refreshNowPlaying()
	}

	private fun startPolling() {
		pollJob?.cancel()
		positionTickJob?.cancel()
		pollIntervalMs = POLL_INTERVAL_MS
		consecutivePollFailures = 0
		playerUnreachable = false
		pollJob = serviceScope.launch {
			while (isActive && apiBase.isNotBlank()) {
				refreshNowPlaying()
				delay(pollIntervalMs)
			}
		}
		positionTickJob = serviceScope.launch {
			while (isActive && apiBase.isNotBlank()) {
				val d = lastData
				if (d != null && d.isPlaying && d.duration > 0) {
					publishNowPlaying(d, extrapolate = true)
				}
				delay(POSITION_TICK_MS)
			}
		}
	}

	private suspend fun refreshNowPlaying() {
		ensureApiBase()
		if (apiBase.isBlank()) return
		val data = VlcApiClient.fetchVlcNowPlaying(apiBase)
		if (data == null) {
			consecutivePollFailures++
			playerUnreachable = consecutivePollFailures >= 3
			pollIntervalMs = when {
				consecutivePollFailures >= 6 -> 15_000L
				consecutivePollFailures >= 3 -> 5_000L
				else -> POLL_INTERVAL_MS
			}
		} else {
			consecutivePollFailures = 0
			playerUnreachable = false
			pollIntervalMs = POLL_INTERVAL_MS
		}
		publishNowPlaying(data)
	}

	private fun publishNowPlaying(data: VlcNowPlayingData?, extrapolate: Boolean = false) {
		if (data == null) {
			updateSession(null)
			getSystemService(NotificationManager::class.java)
				.notify(NOTIFICATION_ID, buildNotification(null))
			return
		}

		val trackChanged = lastData != null &&
			lastData!!.id.isNotBlank() &&
			data.id.isNotBlank() &&
			lastData!!.id != data.id
		val unchanged = !extrapolate && !trackChanged &&
			lastData != null &&
			lastData!!.id == data.id &&
			lastData!!.state == data.state &&
			kotlin.math.abs(lastData!!.position - data.position) < 1.0

		if (!unchanged) {
			lastData = data
			if (!extrapolate || trackChanged) {
				lastPublishAtMs = System.currentTimeMillis()
			}
			if (!extrapolate) {
				VlcPlaybackRelay.publish(data, VlcPlaybackRelay.Source.NOTIFICATION)
			}
		}

		val resolvedPosMs = resolvedPositionMs(data, extrapolate)
		updateSession(data, extrapolate)

		if (extrapolate || !unchanged) {
			val resolved = data.copy(position = resolvedPosMs / 1000.0)
			VlcPlaybackRelay.publishPosition(resolved)
		}

		if (!extrapolate && !unchanged) {
			loadArtworkIfNeeded(data)
		}

		getSystemService(NotificationManager::class.java)
			.notify(NOTIFICATION_ID, buildNotification(data, resolvedPosMs))
	}

	private fun resolvedPositionMs(data: VlcNowPlayingData, extrapolate: Boolean): Long {
		val baseMs = (data.position * 1000).toLong().coerceAtLeast(0L)
		if (!extrapolate || !data.isPlaying) return baseMs
		val elapsed = System.currentTimeMillis() - lastPublishAtMs
		val durationMs = (data.duration * 1000).toLong()
		val next = baseMs + elapsed
		return if (durationMs > 0) next.coerceAtMost(durationMs) else next
	}

	private fun loadArtworkIfNeeded(data: VlcNowPlayingData) {
		if (data.coverUrl.isBlank() || data.coverUrl == lastCoverUrl) return
		lastCoverUrl = data.coverUrl
		artworkJob?.cancel()
		artworkJob = serviceScope.launch {
			try {
				val bitmap = VlcApiClient.loadCoverBitmap(apiBase, data.coverUrl)
				if (bitmap != null) {
					cachedArtwork = bitmap
					updateSession(VlcApiClient.fetchVlcNowPlaying(apiBase))
					getSystemService(NotificationManager::class.java)
						.notify(NOTIFICATION_ID, buildNotification(VlcApiClient.fetchVlcNowPlaying(apiBase)))
				}
			} catch (_: Exception) {
				// Don't crash the service over artwork loading failures
			}
		}
	}

	private fun updateSession(data: VlcNowPlayingData?, extrapolate: Boolean = false) {
		if (data == null) {
			mediaSession.setPlaybackState(
				PlaybackStateCompat.Builder()
					.setActions(transportActions)
					.setState(PlaybackStateCompat.STATE_NONE, 0, 0f)
					.build(),
			)
			return
		}

		val durationMs = ((data.duration * 1000).toLong()).coerceAtLeast(0L)
		val positionMs = resolvedPositionMs(data, extrapolate)

		val metadataBuilder = MediaMetadataCompat.Builder()
			.putString(MediaMetadataCompat.METADATA_KEY_TITLE, data.title.ifBlank { "Karol VLC" })
			.putString(MediaMetadataCompat.METADATA_KEY_ARTIST, data.artist.ifBlank { "VLC Player" })
			.putString(MediaMetadataCompat.METADATA_KEY_ALBUM, data.album.ifBlank { "VLC DJ" })
			.apply {
				if (durationMs > 0) putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs)
			}
		cachedArtwork?.let { metadataBuilder.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it) }
		mediaSession.setMetadata(metadataBuilder.build())

		val playbackState = when {
			data.isPlaying -> PlaybackStateCompat.STATE_PLAYING
			data.state == "paused" -> PlaybackStateCompat.STATE_PAUSED
			else -> PlaybackStateCompat.STATE_STOPPED
		}

		mediaSession.setPlaybackState(
			PlaybackStateCompat.Builder()
				.setActions(transportActions)
				.setState(playbackState, positionMs, if (data.isPlaying) 1f else 0f)
				.build(),
		)

		lastTitle = data.title
		lastIsPlaying = data.isPlaying
	}

	private fun buildNotification(data: VlcNowPlayingData?, positionMs: Long = 0L): Notification {
		val title = data?.title?.takeIf { it.isNotBlank() }
			?: lastTitle.takeIf { it.isNotBlank() }
			?: "VLC DJ"
		val subtitle = when {
			playerUnreachable -> "VLC unreachable"
			data?.isPlaying == true -> "Playing — VLC"
			data?.state == "paused" -> "Paused — VLC"
			else -> "Ready — VLC"
		}

		val contentIntent = PendingIntent.getActivity(
			this, 0,
			Intent(this, MainActivity::class.java).apply {
				flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
			},
			PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
		)

		val showPause = when {
			playerUnreachable -> lastIsPlaying
			data?.isPlaying == true -> true
			data == null -> lastIsPlaying
			else -> false
		}
		val playPauseAction = if (showPause) {
			NotificationCompat.Action(
				android.R.drawable.ic_media_pause, "Pause",
				servicePendingIntent(ACTION_PAUSE),
			)
		} else {
			NotificationCompat.Action(
				android.R.drawable.ic_media_play, "Play",
				servicePendingIntent(ACTION_PLAY),
			)
		}

		val builder = NotificationCompat.Builder(this, CHANNEL_ID)
			.setSmallIcon(R.drawable.ic_stat_media)
			.setContentTitle(title)
			.setContentText(subtitle)
			.setSubText("Karol VLC")
			.apply {
				val durationSec = data?.duration ?: 0.0
				val durationMs = (durationSec * 1000).toInt()
				if (durationMs > 0 && data != null) {
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
					android.R.drawable.ic_media_previous, "Previous",
					servicePendingIntent(ACTION_SKIP_PREV),
				),
			)
			.addAction(playPauseAction)
			.addAction(
				NotificationCompat.Action(
					android.R.drawable.ic_media_next, "Next",
					servicePendingIntent(ACTION_SKIP_NEXT),
				),
			)
			.addAction(
				NotificationCompat.Action(
					android.R.drawable.ic_menu_close_clear_cancel, "Stop VLC",
					servicePendingIntent(ACTION_STOP),
				),
			)
			.setStyle(
				androidx.media.app.NotificationCompat.MediaStyle()
					.setMediaSession(mediaSession.sessionToken)
					.setShowActionsInCompactView(0, 1, 2),
			)

		cachedArtwork?.let { builder.setLargeIcon(it) }
			?: builder.setLargeIcon(BitmapFactory.decodeResource(resources, R.mipmap.ic_launcher))

		return builder.build()
	}

	private val relayListener: (VlcNowPlayingData?, VlcPlaybackRelay.Source) -> Unit = { data, source ->
		if (source == VlcPlaybackRelay.Source.WEBVIEW && data != null) {
			publishNowPlaying(data)
		}
	}

	private fun servicePendingIntent(action: String): PendingIntent =
		PendingIntent.getService(
			this, action.hashCode(),
			Intent(this, VlcMediaPlaybackService::class.java).setAction(action),
			PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
		)

	private fun createNotificationChannel() {
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
		val channel = NotificationChannel(
			CHANNEL_ID, "Karol VLC Playback",
			NotificationManager.IMPORTANCE_DEFAULT,
		).apply {
			description = "Media controls for VLC DJ playback"
			setShowBadge(false)
			lockscreenVisibility = Notification.VISIBILITY_PUBLIC
		}
		getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
	}

	private fun prefs() = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

	private fun persistApiBase(base: String) {
		apiBase = base
		prefs().edit().putString(KEY_API_BASE, base).apply()
	}

	private fun restoreApiBase() {
		apiBase = prefs().getString(KEY_API_BASE, "").orEmpty()
	}

	private fun clearApiBase() {
		apiBase = ""
		lastCoverUrl = ""
		cachedArtwork = null
		prefs().edit().remove(KEY_API_BASE).apply()
	}

	private fun ensureApiBase() {
		if (apiBase.isBlank()) restoreApiBase()
	}

	companion object {
		private const val TAG = "VlcMediaPlayback"
		private const val PREFS_NAME = "karol_vlc_playback"
		private const val KEY_API_BASE = "vlc_api_base"
		private const val CHANNEL_ID = "karol_vlc_playback"
		private const val NOTIFICATION_ID = 43
		private const val POLL_INTERVAL_MS = 500L
		private const val POSITION_TICK_MS = 500L
		private const val EXTRA_CONTROLLER_URL = "controller_url"

		private const val ACTION_PLAY = "com.karol.controller.action.VLC_PLAY"
		private const val ACTION_PAUSE = "com.karol.controller.action.VLC_PAUSE"
		private const val ACTION_SKIP_NEXT = "com.karol.controller.action.VLC_SKIP_NEXT"
		private const val ACTION_SKIP_PREV = "com.karol.controller.action.VLC_SKIP_PREV"
		private const val ACTION_STOP = "com.karol.controller.action.VLC_STOP"

		private const val transportActions =
			PlaybackStateCompat.ACTION_PLAY or
				PlaybackStateCompat.ACTION_PAUSE or
				PlaybackStateCompat.ACTION_PLAY_PAUSE or
				PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
				PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
				PlaybackStateCompat.ACTION_SEEK_TO

		fun start(context: Context, controllerUrl: String) {
			val intent = Intent(context, VlcMediaPlaybackService::class.java).apply {
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
				Intent(context, VlcMediaPlaybackService::class.java).setAction(ACTION_STOP),
			)
		}
	}
}
