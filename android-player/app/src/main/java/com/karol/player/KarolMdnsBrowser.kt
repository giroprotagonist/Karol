package com.karol.player

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * mDNS browser that discovers the Mac "Karol API Server" service
 * advertised as _karol-dj._tcp. Returns the Mac's host:port so the
 * player can talk directly to it without a hardcoded IP.
 */
object KarolMdnsBrowser {
	private const val TAG = "KarolMdnsBrowser"
	private const val SERVICE_TYPE = "_karol-dj._tcp."

	/**
	 * Returns a pair of (host, port) discovered via mDNS, or null.
	 * Filters for the "Karol API Server" instance (the Mac host),
	 * ignoring any "KarolPlayer" (this tablet itself).
	 */
	suspend fun findMacHost(context: Context, timeoutMs: Long = 4_000L): Pair<String, Int>? =
		suspendCancellableCoroutine { cont ->
			val nsdManager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
			var resolved = false
			val listenerHolder = arrayOf<NsdManager.DiscoveryListener?>(null)

			fun finish(result: Pair<String, Int>?) {
				if (resolved) return
				resolved = true
				listenerHolder[0]?.let { listener ->
					try { nsdManager.stopServiceDiscovery(listener) } catch (_: Exception) {}
				}
				if (cont.isActive) cont.resume(result)
			}

			val discoveryListener = object : NsdManager.DiscoveryListener {
				override fun onDiscoveryStarted(serviceType: String) {
					Log.d(TAG, "discovery started: $serviceType")
				}

				override fun onServiceFound(service: NsdServiceInfo) {
					// Only resolve services whose name contains "Karol" but not "KarolPlayer"
					// (the Mac advertises as "Karol API Server")
					val name = service.serviceName ?: ""
					if (!name.contains("Karol") || name.contains("KarolPlayer")) return

					nsdManager.resolveService(service, object : NsdManager.ResolveListener {
						override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
							Log.d(TAG, "resolve failed for $name: $errorCode")
						}

						override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
							val host = serviceInfo.host?.hostAddress ?: return
							val port = serviceInfo.port
							if (port <= 0) return
							Log.i(TAG, "found Mac host via mDNS: $host:$port")
							finish(Pair(host, port))
						}
					})
				}

				override fun onServiceLost(service: NsdServiceInfo) {}

				override fun onDiscoveryStopped(serviceType: String) {}

				override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
					finish(null)
				}

				override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
			}
			listenerHolder[0] = discoveryListener

			try {
				nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener)
			} catch (error: Exception) {
				Log.w(TAG, "discovery failed", error)
				finish(null)
				return@suspendCancellableCoroutine
			}

			android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
				finish(null)
			}, timeoutMs)

			cont.invokeOnCancellation {
				listenerHolder[0]?.let { listener ->
					try { nsdManager.stopServiceDiscovery(listener) } catch (_: Exception) {}
				}
			}
		}
}
