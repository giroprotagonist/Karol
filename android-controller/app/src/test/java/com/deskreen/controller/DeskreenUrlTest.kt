package com.deskreen.controller

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class DeskreenUrlTest {
	@Test
	fun normalize_addsSchemeAndDjControllerPath() {
		assertEquals(
			"http://192.168.1.42:3131/dj-controller/",
			DeskreenUrl.normalize("192.168.1.42:3131"),
		)
	}

	@Test
	fun normalize_preservesExistingDjControllerUrl() {
		assertEquals(
			"http://192.168.1.42:3131/dj-controller/",
			DeskreenUrl.normalize("http://192.168.1.42:3131/dj-controller/"),
		)
	}

	@Test
	fun normalize_defaultsPortWhenMissing() {
		assertEquals(
			"http://tablet.local:3131/dj-controller/",
			DeskreenUrl.normalize("http://tablet.local"),
		)
	}

	@Test
	fun normalize_rejectsBlankInput() {
		assertNull(DeskreenUrl.normalize("   "))
	}
}
