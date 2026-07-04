package com.deskreen.receiver

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

class CastForegroundService : Service() {

	private var castWakeLock: PowerManager.WakeLock? = null

	companion object {
		const val CHANNEL_ID = "deskreen_cast"
		const val NOTIFICATION_ID = 1
		const val ACTION_STOP = "com.deskreen.receiver.STOP_CAST"
		const val EXTRA_ACTIVE = "active"

		fun start(context: Context) {
			val intent = Intent(context, CastForegroundService::class.java)
			intent.putExtra(EXTRA_ACTIVE, true)
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
				context.startForegroundService(intent)
			} else {
				context.startService(intent)
			}
		}

		fun stop(context: Context) {
			val intent = Intent(context, CastForegroundService::class.java)
			context.stopService(intent)
		}
	}

	override fun onCreate() {
		super.onCreate()
		createNotificationChannel()
		acquireCastWakeLock()
	}

	override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
		val isActive = intent?.getBooleanExtra(EXTRA_ACTIVE, true) ?: true

		if (!isActive) {
			stopForeground(STOP_FOREGROUND_REMOVE)
			stopSelf()
			return START_NOT_STICKY
		}

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
		} catch (e: Exception) {
			// Fallback: try without the foreground service type
			try {
				startForeground(NOTIFICATION_ID, notification)
			} catch (e2: Exception) {
				// Last resort — just show the notification
				val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
				nm.notify(NOTIFICATION_ID, notification)
			}
		}

		return START_STICKY
	}

	override fun onBind(intent: Intent?): IBinder? = null

	override fun onDestroy() {
		releaseCastWakeLock()
		super.onDestroy()
	}

	private fun createNotificationChannel() {
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
			val channel = NotificationChannel(
				CHANNEL_ID,
				"Deskreen Cast",
				NotificationManager.IMPORTANCE_LOW,
			).apply {
				description = "Shows when Deskreen is actively streaming"
				setShowBadge(false)
			}
			val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
			manager.createNotificationChannel(channel)
		}
	}

	private fun buildForegroundNotification(): Notification {
		val openIntent = Intent(this, MainActivity::class.java).apply {
			flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
		}
		val openPendingIntent = PendingIntent.getActivity(
			this,
			0,
			openIntent,
			PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
		)

		val stopIntent = Intent(this, CastForegroundService::class.java).apply {
			action = ACTION_STOP
			putExtra(EXTRA_ACTIVE, false)
		}
		val stopPendingIntent = PendingIntent.getService(
			this,
			0,
			stopIntent,
			PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
		)

		val stopIcon = Icon.createWithResource(this, android.R.drawable.ic_media_pause)

		return Notification.Builder(this, CHANNEL_ID)
			.setContentTitle("Deskreen is casting")
			.setContentText("Streaming from your Mac")
			.setSmallIcon(android.R.drawable.ic_media_play)
			.setOngoing(true)
			.setContentIntent(openPendingIntent)
			.addAction(
				Notification.Action.Builder(stopIcon, "Stop", stopPendingIntent).build(),
			)
			.build()
	}

	private fun acquireCastWakeLock() {
		val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
		castWakeLock?.release()
		castWakeLock = powerManager.newWakeLock(
			PowerManager.PARTIAL_WAKE_LOCK,
			"DeskreenReceiver::CastService",
		).apply {
			acquire(10 * 60 * 60 * 1000L) // 10 hours
		}
	}

	private fun releaseCastWakeLock() {
		castWakeLock?.let {
			if (it.isHeld) it.release()
		}
		castWakeLock = null
	}
}
