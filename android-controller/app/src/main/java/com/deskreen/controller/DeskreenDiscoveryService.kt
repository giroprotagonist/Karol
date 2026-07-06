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
)

object DeskreenDiscoveryService {
	private const val TAG = "DeskreenControllerDiscovery"

	suspend fun findDeskreenOnLan(context: Context): DeskreenDiscovery? =
		coroutineScope {
			val subnet = getSubnetPrefix(context) ?: return@coroutineScope null
			val ports = listOf(3131, 3132)

			val results = (1..254)
				.map { hostSuffix ->
					async(Dispatchers.IO) {
						val host = "$subnet.$hostSuffix"
						for (port in ports) {
							probeHost(host, port)?.let { return@async it }
						}
						null
					}
				}
				.awaitAll()
				.filterNotNull()

			results.firstOrNull()
		}

	private fun probeHost(host: String, port: Int): DeskreenDiscovery? {
		return try {
			if (!InetAddress.getByName(host).isReachable(180)) {
				return null
			}
			val url = URL("http://$host:$port/api/discover.json")
			val connection = (url.openConnection() as HttpURLConnection).apply {
				connectTimeout = 400
				readTimeout = 400
				requestMethod = "GET"
			}
			if (connection.responseCode != HttpURLConnection.HTTP_OK) {
				connection.disconnect()
				return null
			}
			val body = connection.inputStream.bufferedReader().use { it.readText() }
			connection.disconnect()
			val json = JSONObject(body)
			val controllerUrl = json.optString("djControllerUrl", "").ifBlank {
				"http://$host:$port/dj-controller/"
			}
			if (!isControllerReachable(host, port)) {
				return null
			}
			DeskreenDiscovery(
				controllerUrl = controllerUrl,
				host = json.optString("host", host),
				port = json.optInt("port", port),
			)
		} catch (error: Exception) {
			Log.d(TAG, "probe failed for $host:$port", error)
			null
		}
	}

	private fun isControllerReachable(host: String, port: Int): Boolean {
		return try {
			val connection = (URL("http://$host:$port/api/youtube-dj/health").openConnection() as HttpURLConnection).apply {
				connectTimeout = 500
				readTimeout = 500
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
		if (ip == 0) return null
		val octets = intArrayOf(
			ip and 0xff,
			ip shr 8 and 0xff,
			ip shr 16 and 0xff,
			ip shr 24 and 0xff,
		)
		return "${octets[0]}.${octets[1]}.${octets[2]}"
	}
}
