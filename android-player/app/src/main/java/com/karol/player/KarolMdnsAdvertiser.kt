package com.karol.player

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log

class KarolMdnsAdvertiser(private val context: Context) {
	private var nsdManager: NsdManager? = null
	private var registrationListener: NsdManager.RegistrationListener? = null

	fun start(port: Int = DjHttpServer.SERVER_PORT) {
		stop()
		val manager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
		nsdManager = manager
		val serviceInfo =
			NsdServiceInfo().apply {
				serviceName = SERVICE_NAME
				serviceType = SERVICE_TYPE
				setPort(port)
			}
		val listener =
			object : NsdManager.RegistrationListener {
				override fun onServiceRegistered(info: NsdServiceInfo) {
					Log.i(TAG, "mDNS registered: ${info.serviceName}")
				}

				override fun onRegistrationFailed(
					serviceInfo: NsdServiceInfo,
					errorCode: Int,
				) {
					Log.w(TAG, "mDNS registration failed: $errorCode")
				}

				override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) {
					Log.i(TAG, "mDNS unregistered")
				}

				override fun onUnregistrationFailed(
					serviceInfo: NsdServiceInfo,
					errorCode: Int,
				) {
					Log.w(TAG, "mDNS unregistration failed: $errorCode")
				}
			}
		registrationListener = listener
		try {
			manager.registerService(serviceInfo, NsdManager.PROTOCOL_DNS_SD, listener)
		} catch (error: Exception) {
			Log.w(TAG, "mDNS register error", error)
		}
	}

	fun stop() {
		val manager = nsdManager ?: return
		val listener = registrationListener ?: return
		try {
			manager.unregisterService(listener)
		} catch (_: Exception) {
			// ignore
		}
		registrationListener = null
		nsdManager = null
	}

	companion object {
		private const val TAG = "KarolMdnsAdvertiser"
		const val SERVICE_TYPE = "_karol-dj._tcp."
		const val SERVICE_NAME = "KarolPlayer"
	}
}
