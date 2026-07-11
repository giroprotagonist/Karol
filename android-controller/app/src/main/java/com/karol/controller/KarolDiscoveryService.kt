package com.karol.controller

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

data class KarolDiscovery(
	val controllerUrl: String,
	val host: String,
	val port: Int,
	val isPlayerHost: Boolean = false,
)

object KarolDiscoveryService {
	private const val TAG = "KarolControllerDiscovery"
	private const val BATCH_SIZE = 32

	@SuppressLint("WifiManagerPotentialLeak")
	suspend fun findKarolOnLan(context: Context): KarolDiscovery? {
		val wifiManager =
			context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
		val lock =
			try {
				wifiManager.createMulticastLock("karol-discovery")?.apply {
					setReferenceCounted(true)
					acquire()
				}
			} catch (_: Exception) {
				null
			}
		try {
			val mdns = KarolMdnsBrowser.findPlayerHost(context)
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

	suspend fun rediscover(context: Context, lastHost: String?): KarolDiscovery? {
		if (!lastHost.isNullOrBlank()) {
			for (port in listOf(3131, 3132)) {
				if (isControllerReachable(lastHost, port)) {
					return probeHost(lastHost, port)
				}
			}
		}
		return findKarolOnLan(context)
	}

	private suspend fun scanSubnet(context: Context): KarolDiscovery? =
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
				// Prefer the dj-host (has VLC + YouTube) over a dj-player (YouTube only).
				// The host runs on the Mac and proxies YouTube DJ from the player tablet
				// while also serving VLC DJ endpoints that the player lacks.
				val host = results.firstOrNull { !it.isPlayerHost }
				if (host != null) {
					return@coroutineScope host
				}
				val player = results.firstOrNull { it.isPlayerHost }
				if (player != null) {
					return@coroutineScope player
				}
			}
			null
		}

	private fun probeHost(host: String, port: Int): KarolDiscovery? {
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
			KarolDiscovery(
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
		var socket: java.net.Socket? = null
		return try {
			socket = java.net.Socket()
			// Use Socket.connect(InetSocketAddress, timeout) which reliably enforces
			// the OS-level TCP connect timeout.  Unlike HttpURLConnection, this
			// does NOT get overridden by kernel TCP retransmission on unreachable hosts.
			socket.connect(java.net.InetSocketAddress(host, port), 2_000)
			socket.soTimeout = 3_000

			val writer = socket.getOutputStream().bufferedWriter()
			// Use /api/discover.json for the health check — it is served directly
			// by the Karol host without proxying to the player tablet (unlike
			// /api/youtube-dj/health which fails when the tablet is asleep).
			writer.write("GET /api/discover.json HTTP/1.1\r\n")
			writer.write("Host: $host:$port\r\n")
			writer.write("Connection: close\r\n")
			writer.write("User-Agent: KarolController/1.0\r\n")
			writer.write("\r\n")
			writer.flush()

			val reader = socket.getInputStream().bufferedReader()
			val statusLine = reader.readLine() ?: return false
			statusLine.contains(" 200 ")
		} catch (_: Exception) {
			false
		} finally {
			try {
				socket?.close()
			} catch (_: Exception) {
			}
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
