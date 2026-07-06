package com.deskreen.player

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

class PlayerForegroundService : Service() {
	private var wakeLock: PowerManager.WakeLock? = null

	companion object {
		const val CHANNEL_ID = "deskreen_player"
		const val NOTIFICATION_ID = 2

		fun start(context: Context) {
			val intent = Intent(context, PlayerForegroundService::class.java)
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
				context.startForegroundService(intent)
			} else {
				context.startService(intent)
			}
		}

		fun stop(context: Context) {
			context.stopService(Intent(context, PlayerForegroundService::class.java))
		}
	}

	override fun onCreate() {
		super.onCreate()
		createNotificationChannel()
		acquireWakeLock()
	}

	override fun onStartCommand(
		intent: Intent?,
		flags: Int,
		startId: Int,
	): Int {
		val notification = buildForegroundNotification()
		try {
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
				startForeground(
					NOTIFICATION_ID,
					notification,
					ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
				)
			} else {
				startForeground(NOTIFICATION_ID, notification)
			}
		} catch (_: Exception) {
			startForeground(NOTIFICATION_ID, notification)
		}
		return START_STICKY
	}

	override fun onBind(intent: Intent?): IBinder? = null

	override fun onDestroy() {
		releaseWakeLock()
		super.onDestroy()
	}

	private fun createNotificationChannel() {
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
			val channel =
				NotificationChannel(
					CHANNEL_ID,
					"Deskreen Player",
					NotificationManager.IMPORTANCE_LOW,
				)
			val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
			manager.createNotificationChannel(channel)
		}
	}

	private fun buildForegroundNotification(): Notification {
		val openIntent =
			PendingIntent.getActivity(
				this,
				0,
				Intent(this, MainActivity::class.java),
				PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
			)
		return Notification.Builder(this, CHANNEL_ID)
			.setContentTitle(getString(R.string.player_notification_title))
			.setContentText(getString(R.string.player_notification_text))
			.setSmallIcon(android.R.drawable.ic_media_play)
			.setOngoing(true)
			.setContentIntent(openIntent)
			.build()
	}

	private fun acquireWakeLock() {
		val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
		wakeLock =
			powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "DeskreenPlayer::Service").apply {
				acquire(10 * 60 * 60 * 1000L)
			}
	}

	private fun releaseWakeLock() {
		wakeLock?.let {
			if (it.isHeld) {
				it.release()
			}
		}
		wakeLock = null
	}
}
