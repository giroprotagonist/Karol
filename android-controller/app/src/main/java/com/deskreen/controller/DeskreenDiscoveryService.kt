package com.deskreen.controller

import android.annotation.SuppressLint
import android.content.Context
import android.net.wifi.WifiManager
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL

data class DeskreenDiscovery(
	val controllerUrl: String,
	val host: String,
	val port: Int,
	val isPlayerHost: Boolean = false,
)

object DeskreenDiscoveryService {
	private const val TAG = "DeskreenControllerDiscovery"
	private const val BATCH_SIZE = 32

	@SuppressLint("WifiManagerPotentialLeak")
	suspend fun findDeskreenOnLan(context: Context): DeskreenDiscovery? {
		val wifiManager =
			context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
		val lock =
			try {
				wifiManager.createMulticastLock("deskreen-discovery")?.apply {
					setReferenceCounted(true)
					acquire()
				}
			} catch (_: Exception) {
				null
			}
		try {
			val mdns = DeskreenMdnsBrowser.findPlayerHost(context)
			if (mdns != null && isControllerReachable(mdns.host, mdns.port)) {
				Log.i(TAG, "found player via mDNS at ${mdns.host}:${mdns.port}")
				return mdns
			}
			return scanSubnet(context)
		} finally {
			lock?.let {
				if (it.isHeld) {
					it.release()
				}
			}
		}
	}

	suspend fun rediscover(context: Context, lastHost: String?): DeskreenDiscovery? {
		if (!lastHost.isNullOrBlank()) {
			for (port in listOf(3131, 3132)) {
				if (isControllerReachable(lastHost, port)) {
					return probeHost(lastHost, port)
				}
			}
		}
		return findDeskreenOnLan(context)
	}

	private suspend fun scanSubnet(context: Context): DeskreenDiscovery? =
		coroutineScope {
			val subnet = getSubnetPrefix(context) ?: return@coroutineScope null
			val ports = listOf(3131, 3132)
			val targets =
				(1..254).flatMap { hostSuffix ->
					ports.map { port -> "$subnet.$hostSuffix" to port }
				}

			for (batch in targets.chunked(BATCH_SIZE)) {
				val results =
					batch
						.map { (host, port) ->
							async(Dispatchers.IO) { probeHost(host, port) }
						}
						.awaitAll()
						.filterNotNull()
				val player = results.firstOrNull { it.isPlayerHost }
				if (player != null) {
					return@coroutineScope player
				}
				val any = results.firstOrNull()
				if (any != null) {
					return@coroutineScope any
				}
			}
			null
		}

	private fun probeHost(host: String, port: Int): DeskreenDiscovery? {
		return try {
			if (!InetAddress.getByName(host).isReachable(500)) {
				return null
			}
			val url = URL("http://$host:$port/api/discover.json")
			val connection =
				(url.openConnection() as HttpURLConnection).apply {
					connectTimeout = 800
					readTimeout = 800
					requestMethod = "GET"
				}
			if (connection.responseCode != HttpURLConnection.HTTP_OK) {
				connection.disconnect()
				return null
			}
			val body = connection.inputStream.bufferedReader().use { it.readText() }
			connection.disconnect()
			val json = JSONObject(body)
			val isPlayerHost = json.optString("role", "") == "dj-player"
			if (!isControllerReachable(host, port)) {
				return null
			}
			val controllerUrl =
				json.optString("djControllerUrl", "").ifBlank {
					"http://$host:$port/dj-controller/"
				}
			DeskreenDiscovery(
				controllerUrl = controllerUrl,
				host = json.optString("host", host),
				port = json.optInt("port", port),
				isPlayerHost = isPlayerHost,
			)
		} catch (error: Exception) {
			Log.d(TAG, "probe failed for $host:$port", error)
			null
		}
	}

	fun isControllerReachable(host: String, port: Int): Boolean {
		return try {
			val connection =
				(URL("http://$host:$port/api/youtube-dj/health").openConnection() as HttpURLConnection).apply {
					connectTimeout = 2_000
					readTimeout = 2_000
					requestMethod = "GET"
				}
			val ok = connection.responseCode == HttpURLConnection.HTTP_OK
			connection.disconnect()
			ok
		} catch (_: Exception) {
			false
		}
	}

	@SuppressLint("DefaultLocale")
	private fun getSubnetPrefix(context: Context): String? {
		val wifiManager =
			context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
		val dhcp = wifiManager.dhcpInfo ?: return null
		val ip = dhcp.ipAddress
		if (ip == 0) {
			return null
		}
		val octets =
			intArrayOf(
				ip and 0xff,
				ip shr 8 and 0xff,
				ip shr 16 and 0xff,
				ip shr 24 and 0xff,
			)
		return "${octets[0]}.${octets[1]}.${octets[2]}"
	}
}
