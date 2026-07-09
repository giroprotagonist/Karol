package com.deskreen.player

import android.accounts.Account
import android.accounts.AccountManager
import android.accounts.AccountManagerCallback
import android.accounts.AccountManagerFuture
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.CookieManager
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * Signs into YouTube on the device using the tablet's Google account.
 *
 * Mac-exported cookies authenticate in the WebView but YouTube's backend
 * detects the browser/platform mismatch and denies Premium.  This class
 * uses AccountManager to get a real device-scoped auth token, exchanges it
 * for YouTube session cookies, and injects them into the WebView.
 */
object YouTubeAccountSignIn {
	private const val TAG = "YouTubeAccountSignIn"
	private const val ACCOUNT_TYPE = "com.google"
	private const val OAUTH_SCOPE =
		"oauth2:https://www.googleapis.com/auth/youtube"

	private val client =
		OkHttpClient.Builder()
			.followRedirects(true)
			.followSslRedirects(true)
			.connectTimeout(15, TimeUnit.SECONDS)
			.readTimeout(15, TimeUnit.SECONDS)
			.build()

	private val mainHandler = Handler(Looper.getMainLooper())

	/** Callback: success=true means cookies were injected into CookieManager. */
	fun signIn(
		context: Context,
		callback: (Boolean) -> Unit,
	) {
		val accounts =
			AccountManager.get(context)
				.getAccountsByType(ACCOUNT_TYPE)
		if (accounts.isEmpty()) {
			Log.w(TAG, "no Google accounts on device")
			callback(false)
			return
		}
		val account = accounts.first()
		Log.i(TAG, "using Google account: ${account.name}")

		AccountManager.get(context).getAuthToken(
			account,
			OAUTH_SCOPE,
			Bundle(),
			true,
			{ future ->
				tryGetOAuthToken(future, callback)
			},
			mainHandler,
		)
	}

	private fun tryGetOAuthToken(
		future: AccountManagerFuture<Bundle>,
		callback: (Boolean) -> Unit,
	) {
		try {
			val result = future.result
			val token = result.getString(AccountManager.KEY_AUTHTOKEN)
			if (token.isNullOrBlank()) {
				Log.w(TAG, "OAuth token is empty, trying alternate scope...")
				callback(false)
				return
			}
			Log.i(TAG, "got OAuth token (len=${token.length}), converting to cookies...")
			oauthToCookies(token, callback)
		} catch (e: Exception) {
			Log.w(TAG, "OAuth token fetch failed", e)
			callback(false)
		}
	}

	/** Use an OAuth token to access YouTube and capture session cookies. */
	private fun oauthToCookies(
		token: String,
		callback: (Boolean) -> Unit,
	) {
		val thread =
			Thread {
				try {
					val cm = CookieManager.getInstance()
					cm.setAcceptCookie(true)

					// 1. Go to google.com first to establish auth cookies
					val step1 =
						client.newCall(
							Request.Builder()
								.url("https://accounts.google.com/ServiceLogin?service=youtube&passive=true&continue=https://www.youtube.com/")
								.header("Authorization", "Bearer $token")
								.build(),
						).execute()
					captureCookies(step1)

					// 2. Then youtube.com to finalize
					val step2 =
						client.newCall(
							Request.Builder()
								.url("https://www.youtube.com/")
								.build(),
						).execute()
					captureCookies(step2)

					cm.flush()

					val ytCookies = cm.getCookie("https://www.youtube.com").orEmpty()
					val signedIn =
						ytCookies.contains("LOGIN_INFO=") &&
							(ytCookies.contains("SAPISID=") || ytCookies.contains("SID="))
					Log.i(TAG, "OAuth cookie conversion complete, signedIn=$signedIn")
					mainHandler.post { callback(signedIn) }
				} catch (e: Exception) {
					Log.w(TAG, "OAuth cookie conversion failed", e)
					mainHandler.post { callback(false) }
				}
			}
		thread.start()
	}

	private fun captureCookies(response: okhttp3.Response) {
		val cm = CookieManager.getInstance()
		for (header in response.headers("Set-Cookie")) {
			val parts = header.split(";").firstOrNull()?.trim() ?: continue
			val eq = parts.indexOf('=')
			if (eq <= 0) continue
			val name = parts.substring(0, eq).trim()
			val value = parts.substring(eq + 1).trim()
			val domains = cookieDomains(name)
			for (domain in domains) {
				try {
					cm.setCookie(domain, "$name=$value")
				} catch (_: Exception) {}
			}
		}
	}

	private fun cookieDomains(name: String): List<String> =
		when {
			name.startsWith("__Host-") -> listOf("https://accounts.google.com")
			name == "LOGIN_INFO" || name.startsWith("PREF") ||
				name.startsWith("VISITOR") -> listOf(
				"https://www.youtube.com", "https://youtube.com",
			)
			else -> listOf(
				"https://www.youtube.com", "https://youtube.com",
				"https://google.com", "https://accounts.google.com",
			)
		}
}
