package com.karol.player

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

	fun isYouTubeSignedIn(): Boolean = isSignedIn()

	/** True when Google auth cookies exist but YouTube-specific LOGIN_INFO is missing. */
	fun hasGoogleAuthCookies(): Boolean {
		val cookieManager = CookieManager.getInstance()
		val googleCookies = cookieManager.getCookie("https://google.com").orEmpty()
		val accountsCookies = cookieManager.getCookie("https://accounts.google.com").orEmpty()
		val combined = "$googleCookies;$accountsCookies"
		return GOOGLE_AUTH_MARKERS.any { combined.contains(it) }
	}

	fun syncVerifiedPreference(preferences: PlayerPreferences) {
		if (isSignedIn()) {
			markSignedIn(preferences)
		} else {
			clearVerifiedFlag(preferences)
		}
	}

	/** Premium is active ONLY when the JS check on a live YouTube page
	 * confirmed it.  Auth cookies alone are not enough — the WebView's
	 * Chromium version, cookie expiration, or YouTube backend policy
	 * can still serve ads even with valid-looking cookies. */
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

	/** Evaluated in the YouTube WebView after sign-in or on a watch page.
	 * Uses multiple detection strategies because YouTube's JS API surface
	 * varies across page loads and may not reflect cookie-restored sessions
	 * immediately.  Strategy order: ytcfg config → ytInitialPlayerResponse →
	 * ytInitialData → page HTML scan. */
	val PREMIUM_CHECK_JS: String =
		"""
		(function(){
		  try {
		    // Strategy 1: ytcfg config flags (most reliable when available)
		    if (window.ytcfg && typeof ytcfg.get === 'function') {
		      if (ytcfg.get('IS_PREMIUM_SUBSCRIBER') === true) return 'true';
		      if (ytcfg.get('PREMIUM_MEMBER') === true) return 'true';
		      if (ytcfg.get('LOGGED_IN') === true) {
		        // Signed in but premium flags absent — still check other sources.
		        var c = ytcfg.get('INNERTUBE_CONTEXT');
		        if (c && c.client && c.client.hl) { /* ytcfg is well-formed; continue */ }
		      }
		    }
		    // Strategy 2: ytInitialPlayerResponse ad placement inspection
		    var ir = window.ytInitialPlayerResponse;
		    if (ir && ir.playabilityStatus && ir.playabilityStatus.status === 'OK') {
		      var ads = ir.adPlacements;
		      var playerAds = ir.playerAds;
		      var noAds = (!ads || (Array.isArray(ads) && ads.length === 0)) &&
		        (!playerAds || (typeof playerAds === 'object' && Object.keys(playerAds).length === 0));
		      if (noAds && ir.playabilityStatus.playableInEmbed !== false) return 'true';
		    }
		    // Strategy 3: ytInitialData (newer YouTube payload, contains account info)
		    var id = window.ytInitialData;
		    if (id) {
		      try {
		        var s = JSON.stringify(id);
		        if (s.indexOf('"isPremium":true') >= 0) return 'true';
		        if (s.indexOf('"premiumState":"PREMIUM"') >= 0) return 'true';
		        if (s.indexOf('"youArePremium":true') >= 0) return 'true';
		      } catch(_) {}
		    }
		    // Strategy 4: page HTML substring scan (last resort)
		    var html = document.documentElement && document.documentElement.innerHTML;
		    if (html) {
		      if (html.indexOf('"IS_PREMIUM_SUBSCRIBER":true') >= 0) return 'true';
		      if (html.indexOf('premium" aria-label') >= 0) return 'true';
		      if (html.indexOf('"isPremium":true') >= 0) return 'true';
		    }
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

	private val GOOGLE_AUTH_MARKERS =
		listOf("SAPISID=", "__Secure-1PSID=", "SID=")
}
