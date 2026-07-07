package com.deskreen.controller

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class DjApiClientTest {
	@Test
	fun apiBaseFromControllerUrl_buildsYoutubeDjBase() {
		assertEquals(
			"http://192.168.68.57:3131/api/youtube-dj",
			DjApiClient.apiBaseFromControllerUrl("http://192.168.68.57:3131/dj-controller/"),
		)
	}

	@Test
	fun apiBaseFromControllerUrl_defaultsPort() {
		assertEquals(
			"http://192.168.68.57:3131/api/youtube-dj",
			DjApiClient.apiBaseFromControllerUrl("http://192.168.68.57/dj-controller/"),
		)
	}
}
