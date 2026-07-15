package com.karol.player

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
	override fun onReceive(context: Context, intent: Intent?) {
		if (intent?.action != Intent.ACTION_BOOT_COMPLETED) {
			return
		}
		val prefs = PlayerPreferences(context)
		if (!prefs.getAutoStartOnBoot()) {
			return
		}
		val launch =
			Intent(context, MainActivity::class.java).apply {
				addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
				putExtra(MainActivity.EXTRA_AUTO_START_SHOW, true)
			}
		context.startActivity(launch)
	}
}
