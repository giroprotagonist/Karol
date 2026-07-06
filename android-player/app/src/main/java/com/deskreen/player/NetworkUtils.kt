package com.deskreen.player

import android.content.Context
import android.net.wifi.WifiManager
import java.net.Inet4Address
import java.net.NetworkInterface

object NetworkUtils {
	fun getLocalIpAddress(context: Context): String {
		try {
			val interfaces = NetworkInterface.getNetworkInterfaces()
			while (interfaces.hasMoreElements()) {
				val addresses = interfaces.nextElement().inetAddresses
				while (addresses.hasMoreElements()) {
					val addr = addresses.nextElement()
					if (!addr.isLoopbackAddress && addr is Inet4Address) {
						return addr.hostAddress ?: continue
					}
				}
			}
		} catch (_: Exception) {
			// fall through
		}
		@Suppress("DEPRECATION")
		val wifiManager =
			context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
		val ip = wifiManager.connectionInfo.ipAddress
		if (ip != 0) {
			return String.format(
				"%d.%d.%d.%d",
				ip and 0xff,
				ip shr 8 and 0xff,
				ip shr 16 and 0xff,
				ip shr 24 and 0xff,
			)
		}
		return "127.0.0.1"
	}
}
