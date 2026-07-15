package com.karol.player

import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * Watches playback health: nudges, soft recovery, then hard reload as last resort.
 */
class PlaybackSupervisor(
	private val queueEngine: QueueEngine,
	private val localPlayer: LocalPlayerController,
) {
	private val mainHandler = Handler(Looper.getMainLooper())
	private var loadStartedAt = 0L
	private var currentVideoId: String? = null
	private var tickRunnable: Runnable? = null
	private var nudgeSent = false
	private var softRecoverSent = false
	private var hardReloadSent = false
	private var failMarked = false

	var interstitialMessage: String? = null
		private set

	fun onLoadStarted(videoId: String) {
		currentVideoId = videoId
		loadStartedAt = System.currentTimeMillis()
		nudgeSent = false
		softRecoverSent = false
		hardReloadSent = false
		failMarked = false
		interstitialMessage = null
		startTicking()
	}

	fun clearLoadState() {
		loadStartedAt = 0L
		nudgeSent = false
		softRecoverSent = false
		hardReloadSent = false
		failMarked = false
		interstitialMessage = null
	}

	fun stop() {
		tickRunnable?.let { mainHandler.removeCallbacks(it) }
		tickRunnable = null
	}

	private fun startTicking() {
		tickRunnable?.let { mainHandler.removeCallbacks(it) }
		val runnable =
			object : Runnable {
				override fun run() {
					tick()
					mainHandler.postDelayed(this, TICK_MS)
				}
			}
		tickRunnable = runnable
		mainHandler.postDelayed(runnable, TICK_MS)
	}

	private fun tick() {
		val started = loadStartedAt
		if (started <= 0L) {
			return
		}
		val now = System.currentTimeMillis()
		val elapsed = now - started
		if (!nudgeSent && elapsed > NUDGE_MS) {
			nudgeSent = true
			Log.i(TAG, "nudge playback for $currentVideoId")
			localPlayer.play()
			interstitialMessage = "Still loading — nudging playback…"
		}
		if (!softRecoverSent && elapsed > SOFT_RECOVER_MS) {
			softRecoverSent = true
			Log.w(TAG, "soft recover $currentVideoId")
			// ExoPlayer: just ensure volume and try play
			localPlayer.setVolume(1.0)
			localPlayer.play()
			interstitialMessage = "Recovering playback…"
			loadStartedAt = now
		}
		if (!hardReloadSent && elapsed > HARD_RELOAD_MS) {
			hardReloadSent = true
			Log.w(TAG, "hard reload current video $currentVideoId")
			currentVideoId?.let { localPlayer.loadVideo(it) }
			interstitialMessage = "Retrying video load…"
			loadStartedAt = now
		}
		if (!failMarked && elapsed > FAIL_MS) {
			failMarked = true
			Log.w(TAG, "load timeout for $currentVideoId")
			queueEngine.markCurrentError("Video load timed out")
			queueEngine.logAdvance("supervisor-load-timeout")
			interstitialMessage = "Video load timed out — tap skip or restart show"
			loadStartedAt = 0L
		}
	}

	companion object {
		private const val TAG = "PlaybackSupervisor"
		private const val TICK_MS = 3_000L
		private const val NUDGE_MS = 15_000L
		private const val SOFT_RECOVER_MS = 22_000L
		private const val HARD_RELOAD_MS = 40_000L
		private const val FAIL_MS = 55_000L
	}
}
