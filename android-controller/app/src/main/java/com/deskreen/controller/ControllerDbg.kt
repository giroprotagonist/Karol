package com.deskreen.controller

import android.util.Log
import org.json.JSONObject

/** Structured debug logs for controller sync (tag: DeskreenCtrlDbg). */
object ControllerDbg {
	private const val SESSION = "25b906"

	fun log(
		hypothesisId: String,
		location: String,
		message: String,
		data: Map<String, Any?> = emptyMap(),
	) {
		val payload =
			JSONObject()
				.put("sessionId", SESSION)
				.put("hypothesisId", hypothesisId)
				.put("location", location)
				.put("message", message)
				.put("data", JSONObject(data))
				.put("timestamp", System.currentTimeMillis())
		Log.i("DeskreenCtrlDbg", payload.toString())
	}
}
