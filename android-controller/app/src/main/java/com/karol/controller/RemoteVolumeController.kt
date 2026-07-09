package com.karol.controller

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject

/**
 * Proxies hardware volume keys to the tablet player via LAN API.
 * Single shared instance used by MainActivity and DjMediaPlaybackService.
 */
object RemoteVolumeController {
	const val MAX_VOLUME_STEPS = 100
	const val STEP_SIZE = 0.05

	private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
	private val ioScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
	private val mutex = Mutex()

	@Volatile
	var remoteLevel: Double = 1.0
		private set

	@Volatile
	var apiBase: String = ""

	private var pendingPostJob: Job? = null
	private var pendingLevel: Double? = null
	private var lastAdjustAtMs = 0L
	private val listeners = mutableSetOf<(Double) -> Unit>()

	fun addListener(listener: (Double) -> Unit) {
		synchronized(listeners) { listeners.add(listener) }
	}

	fun removeListener(listener: (Double) -> Unit) {
		synchronized(listeners) { listeners.remove(listener) }
	}

	fun bindApiBase(base: String) {
		apiBase = base
	}

	fun clear() {
		apiBase = ""
		remoteLevel = 1.0
		pendingPostJob?.cancel()
		pendingLevel = null
	}

	/** Sync from tablet poll without posting back to API. */
	fun syncFromTablet(level: Double) {
		val clamped = level.coerceIn(0.0, 1.0)
		if (kotlin.math.abs(clamped - remoteLevel) < 0.001) {
			return
		}
		remoteLevel = clamped
		notifyListeners(clamped)
	}

	suspend fun seedFromTablet(base: String) {
		apiBase = base
		val level = DjApiClient.fetchVolumeLevel(base) ?: return
		syncFromTablet(level)
	}

	fun adjustVolume(deltaSteps: Int) {
		if (deltaSteps == 0) {
			return
		}
		val now = System.currentTimeMillis()
		if (now - lastAdjustAtMs < ADJUST_DEDUPE_MS) {
			// #region agent log
			volDbg(
				"V2",
				"adjustVolume",
				"deduped-dual-path",
				mapOf("delta" to deltaSteps, "msSinceLast" to (now - lastAdjustAtMs)),
			)
			// #endregion
			return
		}
		lastAdjustAtMs = now
		val next = (remoteLevel + deltaSteps * STEP_SIZE).coerceIn(0.0, 1.0)
		setLevel(next, "adjust")
	}

	fun setLevel(
		level: Double,
		source: String = "set",
	) {
		val clamped = level.coerceIn(0.0, 1.0)
		remoteLevel = clamped
		notifyListeners(clamped)
		// #region agent log
		volDbg("V1", "setLevel", "ui-updated", mapOf("level" to clamped, "source" to source))
		// #endregion
		schedulePost(clamped)
	}

	/** VolumeProvider uses 0..100 steps. */
	fun levelToSteps(level: Double): Int =
		(level.coerceIn(0.0, 1.0) * MAX_VOLUME_STEPS).toInt()

	fun stepsToLevel(steps: Int): Double =
		(steps.coerceIn(0, MAX_VOLUME_STEPS).toDouble() / MAX_VOLUME_STEPS)

	private fun notifyListeners(level: Double) {
		val snapshot = synchronized(listeners) { listeners.toList() }
		snapshot.forEach { it(level) }
	}

	private fun schedulePost(level: Double) {
		pendingLevel = level
		val base = apiBase
		if (base.isBlank()) {
			return
		}
		if (pendingPostJob?.isActive == true) {
			return
		}
		val postedAt = System.currentTimeMillis()
		pendingPostJob =
			ioScope.launch {
				delay(POST_DEBOUNCE_MS)
				val toPost =
					mutex.withLock {
						val latest = pendingLevel ?: return@withLock null
						pendingLevel = null
						latest
					} ?: return@launch
				val apiStart = System.currentTimeMillis()
				val ok = DjApiClient.setVolume(base, toPost)
				// #region agent log
				volDbg(
					"V1",
					"schedulePost",
					"api-complete",
					mapOf(
						"level" to toPost,
						"ok" to ok,
						"debounceMs" to POST_DEBOUNCE_MS,
						"waitMs" to (apiStart - postedAt),
						"apiMs" to (System.currentTimeMillis() - apiStart),
					),
				)
				// #endregion
			}
		// Leading-edge post: tablet hears the press immediately; trailing debounce coalesces holds.
		ioScope.launch {
			val apiStart = System.currentTimeMillis()
			val ok = DjApiClient.setVolume(base, level)
			// #region agent log
			volDbg(
				"V1",
				"schedulePost",
				"leading-edge-post",
				mapOf("level" to level, "ok" to ok, "apiMs" to (System.currentTimeMillis() - apiStart)),
			)
			// #endregion
		}
	}

	// #region agent log
	private fun volDbg(
		hypothesisId: String,
		location: String,
		message: String,
		data: Map<String, Any?>,
	) {
		val payload =
			JSONObject()
				.put("sessionId", "25b906")
				.put("hypothesisId", hypothesisId)
				.put("location", "RemoteVolumeController.$location")
				.put("message", message)
				.put("data", JSONObject(data))
				.put("timestamp", System.currentTimeMillis())
		Log.i("KarolVolDbg", payload.toString())
	}
	// #endregion

	private const val POST_DEBOUNCE_MS = 20L
	private const val ADJUST_DEDUPE_MS = 35L
}
