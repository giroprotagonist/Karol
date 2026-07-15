package com.karol.player

import android.text.SpannableString
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

class LyricEngine {

    data class LyricLine(
        val text: String,
        val startTime: Double,
        val endTime: Double,
        val words: List<LyricWord>,
    )

    data class LyricWord(
        val text: String,
        val startTime: Double,
        val endTime: Double,
    )

    data class RenderState(
        val activeText: SpannableString?,
        val previewText: String?,
        val countdownText: String?,
        val showOverlay: Boolean,
    )

    private val colorGold = 0xFFFFD700.toInt()
    private val colorWhite = 0xFFFFFFFF.toInt()

    private var lines: List<LyricLine> = emptyList()
    private var firstLyricStartSec: Double = 0.0
    private var enabled: Boolean = false

    fun load(jsonString: String) {
        try {
            val root = JSONObject(jsonString)
            val arr: JSONArray = root.getJSONArray("lines")

            val parsed = mutableListOf<LyricLine>()
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                val wordsArr = obj.optJSONArray("words")
                val words = mutableListOf<LyricWord>()
                if (wordsArr != null) {
                    for (j in 0 until wordsArr.length()) {
                        val w = wordsArr.getJSONObject(j)
                        words.add(
                            LyricWord(
                                text = w.getString("text"),
                                startTime = w.getDouble("startTime"),
                                endTime = w.getDouble("endTime"),
                            )
                        )
                    }
                }
                parsed.add(
                    LyricLine(
                        text = obj.getString("text"),
                        startTime = obj.getDouble("startTime"),
                        endTime = obj.getDouble("endTime"),
                        words = words,
                    )
                )
            }
            lines = parsed
            firstLyricStartSec = lines.firstOrNull()?.startTime ?: 0.0
            enabled = lines.isNotEmpty()
            Log.i("LyricEngine", "Loaded ${lines.size} lines (first @ ${firstLyricStartSec}s)")
        } catch (e: Exception) {
            Log.e("LyricEngine", "Failed to parse lyrics", e)
            lines = emptyList()
            enabled = false
        }
    }

    fun clear() {
        lines = emptyList()
        enabled = false
        Log.i("LyricEngine", "Cleared")
    }

    fun update(currentTimeSec: Double, isPlaying: Boolean): RenderState {
        if (!enabled || lines.isEmpty()) {
            return RenderState(null, null, null, false)
        }

        // Countdown before first lyric
        if (isPlaying && firstLyricStartSec > 3.5 && currentTimeSec < firstLyricStartSec) {
            val remaining = firstLyricStartSec - currentTimeSec
            val countNum = remaining.toInt()
            if (countNum in 1..3) {
                return RenderState(null, null, countNum.toString(), true)
            }
        }

        // Find current line
        val currentLine = lines.firstOrNull { currentTimeSec in it.startTime..it.endTime }
        if (currentLine == null) {
            val nextLine = lines.firstOrNull { it.startTime > currentTimeSec + 0.3 }
            return if (nextLine != null && nextLine.startTime - currentTimeSec < 3.0) {
                RenderState(null, nextLine.text, null, true)
            } else {
                RenderState(null, null, null, false)
            }
        }

        val activeSpannable = buildProgressiveText(currentLine, currentTimeSec)
        val previewLine = lines.getOrNull(lines.indexOf(currentLine) + 1)?.text

        return RenderState(activeSpannable, previewLine, null, true)
    }

    private fun buildProgressiveText(line: LyricLine, currentTime: Double): SpannableString {
        if (line.words.isEmpty()) {
            val sp = SpannableString(line.text)
            sp.setSpan(ForegroundColorSpan(colorGold), 0, sp.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            return sp
        }

        val sb = StringBuilder()
        for (w in line.words) {
            if (sb.isNotEmpty()) sb.append(" ")
            sb.append(w.text)
        }
        val sp = SpannableString(sb.toString())

        var charPos = 0
        for (w in line.words) {
            val wordLen = w.text.length
            val isPassed = currentTime >= w.endTime
            val isActive = currentTime >= w.startTime && currentTime < w.endTime

            if (isPassed || isActive) {
                sp.setSpan(
                    ForegroundColorSpan(colorGold),
                    charPos, charPos + wordLen,
                    Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
                )
            } else {
                sp.setSpan(
                    ForegroundColorSpan(colorWhite),
                    charPos, charPos + wordLen,
                    Spanned.SPAN_EXCLUSIVE_EXCLUSIVE,
                )
            }
            charPos += wordLen + 1 // +1 for space
        }

        return sp
    }
}
