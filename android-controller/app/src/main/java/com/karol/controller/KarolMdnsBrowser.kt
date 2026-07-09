package com.karol.controller

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

object KarolMdnsBrowser {
	private const val TAG = "KarolMdnsBrowser"
	private const val SERVICE_TYPE = "_karol-dj._tcp."

	suspend fun findPlayerHost(context: Context, timeoutMs: Long = 4_000L): KarolDiscovery? =
		suspendCancellableCoroutine { cont ->
			val nsdManager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
			var resolved = false
			val listenerHolder = arrayOf<NsdManager.DiscoveryListener?>(null)

			fun finish(result: KarolDiscovery?) {
				if (resolved) {
					return
				}
				resolved = true
				listenerHolder[0]?.let { listener ->
					try {
						nsdManager.stopServiceDiscovery(listener)
					} catch (_: Exception) {
						// ignore
					}
				}
				if (cont.isActive) {
					cont.resume(result)
				}
			}

			val discoveryListener =
				object : NsdManager.DiscoveryListener {
					override fun onDiscoveryStarted(serviceType: String) {
						Log.d(TAG, "discovery started: $serviceType")
					}

					override fun onServiceFound(service: NsdServiceInfo) {
						if (!service.serviceType.contains("karol-dj")) {
							return
						}
						nsdManager.resolveService(
							service,
							object : NsdManager.ResolveListener {
								override fun onResolveFailed(
									serviceInfo: NsdServiceInfo,
									errorCode: Int,
								) {
									Log.d(TAG, "resolve failed: $errorCode")
								}

								override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
									val host = serviceInfo.host?.hostAddress ?: return
									val port = serviceInfo.port
									if (port <= 0) {
										return
									}
									val base = "http://$host:$port"
									finish(
										KarolDiscovery(
											controllerUrl = "$base/dj-controller/",
											host = host,
											port = port,
											isPlayerHost = true,
										),
									)
								}
							},
						)
					}

					override fun onServiceLost(service: NsdServiceInfo) {}

					override fun onDiscoveryStopped(serviceType: String) {}

					override fun onStartDiscoveryFailed(
						serviceType: String,
						errorCode: Int,
					) {
						finish(null)
					}

					override fun onStopDiscoveryFailed(
						serviceType: String,
						errorCode: Int,
					) {}
				}
			listenerHolder[0] = discoveryListener

			try {
				nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener)
			} catch (error: Exception) {
				Log.w(TAG, "discover failed", error)
				finish(null)
				return@suspendCancellableCoroutine
			}

			android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
				finish(null)
			}, timeoutMs)

			cont.invokeOnCancellation {
				listenerHolder[0]?.let { listener ->
					try {
						nsdManager.stopServiceDiscovery(listener)
					} catch (_: Exception) {
						// ignore
					}
				}
			}
		}
}
