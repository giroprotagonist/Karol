package com.deskreen.player

import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = android.app.Application::class, sdk = [33])
class QueueEngineTest {
	private lateinit var engine: QueueEngine

	@Before
	fun setUp() {
		val context: Context = RuntimeEnvironment.getApplication()
		context.getSharedPreferences("deskreen_player_queue", Context.MODE_PRIVATE).edit().clear().apply()
		engine = QueueEngine(context)
		engine.clearQueue()
	}

	@Test
	fun skipPrev_seeksToStartWhenPastThreeSeconds() {
		engine.addFromUrl("https://www.youtube.com/watch?v=abc12345678", "queue")
		engine.addFromUrl("https://www.youtube.com/watch?v=def45678901", "play-now")
		engine.setPlaybackProgress(12.0, 180.0)
		var seekTarget: Double? = null
		engine.onSeekVideo = { seekTarget = it }

		val videoId = engine.skipPrev("test-seek-start")

		assertEquals("def45678901", videoId)
		assertEquals(0.0, seekTarget)
	}

	@Test
	fun skipPrev_advancesToPreviousTrackNearStart() {
		engine.addFromUrl("https://www.youtube.com/watch?v=abc12345678", "queue")
		engine.addFromUrl("https://www.youtube.com/watch?v=def45678901", "play-now")
		engine.setPlaybackProgress(1.0, 180.0)
		var loaded: String? = null
		engine.onLoadVideo = { loaded = it }

		val videoId = engine.skipPrev("test-prev-track")

		assertEquals("abc12345678", videoId)
		assertEquals("abc12345678", loaded)
	}

	@Test
	fun skipPrev_shuffleMode_returnsPreviousRandomTrack() {
		engine.setShuffleEnabled(true)
		engine.addFromUrl("https://www.youtube.com/watch?v=aaaaaaaaaaa", "queue")
		engine.addFromUrl("https://www.youtube.com/watch?v=bbbbbbbbbbb", "queue")
		engine.addFromUrl("https://www.youtube.com/watch?v=ccccccccccc", "play-now")
		val loaded = mutableListOf<String>()
		engine.onLoadVideo = { loaded.add(it) }

		val firstSkip = engine.skipNext("shuffle-next")!!
		engine.skipNext("shuffle-next-2")
		val back = engine.skipPrev("shuffle-back")

		assertEquals(firstSkip, back)
		assertEquals(firstSkip, loaded.last())
	}

	@Test
	fun sortQueue_ordersByTitleAscending() {
		engine.addNewVideos(
			listOf(
				SearchVideo("vid1", "Zebra", "Ch", "", "https://youtu.be/vid1"),
				SearchVideo("vid2", "Alpha", "Ch", "", "https://youtu.be/vid2"),
			),
			"test",
		)
		val ok = engine.sortQueue("title-asc")
		assertEquals(true, ok)
		assertEquals(listOf("Alpha", "Zebra"), engine.queue.map { it.title })
	}
}
