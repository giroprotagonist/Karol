package com.karol.player

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.text.TextPaint
import android.util.AttributeSet
import android.view.View
import android.view.animation.LinearInterpolator

/**
 * Custom marquee that continuously scrolls text from right to left.
 * Draws 3 copies of the text so the RESTART animation jump is invisible.
 */
class MarqueeView @JvmOverloads constructor(
	context: Context,
	attrs: AttributeSet? = null,
	defStyleAttr: Int = 0,
) : View(context, attrs, defStyleAttr) {

	private val paint = TextPaint(Paint.ANTI_ALIAS_FLAG)
	private val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG)
	private var text = ""
	private var scrollX = 0f
	private var textWidth = 0f
	private var totalScroll = 0f
	private var animator: ValueAnimator? = null
	private val SPEED_DP_PER_SEC = 100f
	private var speedPxPerSec = 0f
	private var gapPx = 0f

	init {
		bgPaint.color = Color.argb(221, 0, 0, 0)
		paint.color = Color.WHITE
		paint.isFakeBoldText = true
		paint.textSize = 32f * resources.displayMetrics.scaledDensity
		paint.textAlign = Paint.Align.LEFT
		speedPxPerSec = SPEED_DP_PER_SEC * resources.displayMetrics.density
		gapPx = 80f * resources.displayMetrics.density
	}

	override fun onDraw(canvas: Canvas) {
		super.onDraw(canvas)
		val h = height.toFloat()
		canvas.drawRect(0f, 0f, width.toFloat(), h, bgPaint)

		if (text.isEmpty() || textWidth <= 0) return

		canvas.save()
		canvas.clipRect(0f, 0f, width.toFloat(), h)

		val baseY = h / 2f - (paint.descent() + paint.ascent()) / 2f
		// Draw 3 copies spaced by totalScroll so the RESTART snap is invisible
		canvas.drawText(text, scrollX, baseY, paint)
		canvas.drawText(text, scrollX + totalScroll, baseY, paint)
		canvas.drawText(text, scrollX + 2 * totalScroll, baseY, paint)

		canvas.restore()
	}

	fun setMarqueeText(newText: String) {
		if (text == newText) return
		text = newText
		textWidth = paint.measureText(newText)
		totalScroll = textWidth + gapPx
		startAnimation()
	}

	private fun startAnimation() {
		animator?.cancel()
		if (totalScroll <= 0f) {
			scrollX = 0f
			invalidate()
			return
		}
		val durationMs = (totalScroll / speedPxPerSec * 1000f).toLong().coerceAtLeast(2000)

		animator = ValueAnimator.ofFloat(0f, -totalScroll).apply {
			this.duration = durationMs
			interpolator = LinearInterpolator()
			repeatCount = ValueAnimator.INFINITE
			repeatMode = ValueAnimator.RESTART
			addUpdateListener { anim ->
				scrollX = anim.animatedValue as Float
				invalidate()
			}
			start()
		}
	}

	override fun onDetachedFromWindow() {
		super.onDetachedFromWindow()
		animator?.cancel()
	}
}
