package com.deskreen.player

import android.util.Log
import android.webkit.CookieManager
import android.webkit.WebView

/**
 * Keeps the kiosk WebView signed into YouTube via standard Google cookies.
 * Premium ad-free playback requires a valid Premium account in a trusted browser UA.
 */
object YouTubeSessionHelper {
	private const val TAG = "YouTubeSession"
	private const val SIGN_IN_URL =
		"https://accounts.google.com/ServiceLogin?service=youtube&uilel=3&passive=false" +
			"&continue=https%3A%2F%2Fwww.youtube.com%2F"

	@Volatile
	private var premiumCached: Boolean = false

	fun configure(webView: WebView) {
		val cookieManager = CookieManager.getInstance()
		cookieManager.setAcceptCookie(true)
		cookieManager.setAcceptThirdPartyCookies(webView, true)
	}

	fun flush() {
		try {
			CookieManager.getInstance().flush()
		} catch (e: Exception) {
			Log.w(TAG, "cookie flush failed", e)
		}
	}

	/** True when Google/YouTube auth cookies are present in the WebView jar. */
	fun isSignedIn(): Boolean {
		val cookieManager = CookieManager.getInstance()
		val youtubeCookies = cookieManager.getCookie("https://www.youtube.com").orEmpty()
		val googleCookies = cookieManager.getCookie("https://google.com").orEmpty()
		val combined = "$youtubeCookies;$googleCookies"
		return AUTH_COOKIE_MARKERS.any { combined.contains(it) }
	}

	/** Best-effort Premium flag (set after JS verification on the tablet). */
	fun isPremiumActive(preferences: PlayerPreferences): Boolean {
		if (!isSignedIn()) {
			return false
		}
		return premiumCached || preferences.isYouTubePremiumVerified()
	}

	fun markSignedIn(preferences: PlayerPreferences) {
		preferences.setYouTubeSessionVerified(true)
		preferences.setYouTubeSignedInAt(System.currentTimeMillis())
	}

	fun markPremiumVerified(
		preferences: PlayerPreferences,
		verified: Boolean,
	) {
		premiumCached = verified
		preferences.setYouTubePremiumVerified(verified)
	}

	fun clearPremiumCache() {
		premiumCached = false
	}

	fun clearVerifiedFlag(preferences: PlayerPreferences) {
		preferences.setYouTubeSessionVerified(false)
		preferences.setYouTubePremiumVerified(false)
		premiumCached = false
	}

	fun signInUrl(): String = SIGN_IN_URL

	/** Evaluated in the YouTube WebView after sign-in or on a watch page. */
	val PREMIUM_CHECK_JS: String =
		"""
		(function(){
		  try {
		    if (window.ytcfg && typeof ytcfg.get === 'function') {
		      if (ytcfg.get('IS_PREMIUM_SUBSCRIBER') === true) return 'true';
		      if (ytcfg.get('PREMIUM_MEMBER') === true) return 'true';
		      if (ytcfg.get('LOGGED_IN') !== true) return 'false';
		    }
		    var ir = window.ytInitialPlayerResponse;
		    if (ir && ir.playabilityStatus && ir.playabilityStatus.status === 'OK') {
		      var ads = ir.adPlacements;
		      var playerAds = ir.playerAds;
		      var noAds = (!ads || ads.length === 0) &&
		        (!playerAds || (typeof playerAds === 'object' && Object.keys(playerAds).length === 0));
		      if (noAds && ir.playabilityStatus.playableInEmbed !== false) return 'true';
		    }
		    var html = document.documentElement && document.documentElement.innerHTML;
		    if (html && (html.indexOf('\"IS_PREMIUM_SUBSCRIBER\":true') >= 0 ||
		        html.indexOf('premium\\" aria-label') >= 0)) return 'true';
		  } catch (e) {}
		  return 'false';
		})()
		""".trimIndent()

	private val AUTH_COOKIE_MARKERS =
		listOf(
			"SAPISID=",
			"__Secure-1PSID=",
			"SID=",
			"LOGIN_INFO=",
		)
}
