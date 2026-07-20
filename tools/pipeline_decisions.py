"""Karaoke Pipeline Decision Tree

Maps every knowable failure mode to detection rules and remedies.
Goal: eventually eliminate AI calls by building a complete rule engine.
"""

from __future__ import annotations
import re
from typing import Optional

# ── Pipeline Failure Modes ──────────────────────────────────────────────

PIPELINE_FAILURE_MODES = [
    {
        "id": "spoken_intro",
        "detection": {
            "vocal_onset_lt": 3.0,
            "gap_gt": 50.0,
            "first_lrc_gt": 10.0,
        },
        "symptoms": "Music video has dialogue before the song. Vocal onset is from speech, not singing.",
        "remedy": "reprocess_with_artist_title",
        "automatic": False,
        "remedy_detail": "Re-run with --artist and --title overrides to match correct LRCLIB entry.",
    },
    {
        "id": "wrong_lrclib_match",
        "detection": {
            "lrc_quality_verdict": "fail",
            "lrclib_found": True,
            "offset_gt": 20.0,
        },
        "symptoms": "LRCLIB returned lyrics for a different song with the same name.",
        "remedy": "reprocess_with_artist_title_or_force_whisper",
        "automatic": True,
        "remedy_detail": "Force Whisper AI with --force-whisper flag to bypass LRCLIB.",
    },
    {
        "id": "instrumental_track",
        "detection": {
            "line_density_gt": 12.0,
            "word_count_lt": 20,
            "vocal_onset_is_none": True,
        },
        "symptoms": "Track has almost no vocals. Likely an instrumental or ambient piece.",
        "remedy": "flag_as_instrumental",
        "automatic": True,
        "remedy_detail": "Mark as instrumental in tags.json. Lyrics not applicable.",
    },
    {
        "id": "non_english_misdetected",
        "detection": {
            "whisper_language": "en",
            "word_count_lt": 10,
            "title_contains_non_latin": True,
        },
        "symptoms": "Whisper transcribed with wrong language model. Track is likely non-English.",
        "remedy": "force_multilingual_whisper",
        "automatic": False,
        "remedy_detail": "Re-run with --romanize flag for language detection and model selection.",
    },
    {
        "id": "poor_whisper_transcription",
        "detection": {
            "whisper_used": True,
            "line_density_gt": 10.0,
            "word_count_lt": 50,
        },
        "symptoms": "Whisper generated few words. Audio may be noisy, accented, or the vocal stem may have bleed.",
        "remedy": "use_full_audio_not_vocal_stem",
        "automatic": True,
        "remedy_detail": "Re-run Whisper on full audio (not vocal stem) for better accuracy.",
    },
    {
        "id": "offset_corrected_needs_verification",
        "detection": {
            "lrc_quality_verdict": "correct",
            "correction_offset_gt": 5.0,
        },
        "symptoms": "Lyrics were auto-shifted by >5s. Timing is approximate and may drift.",
        "remedy": "manual_review_recommended",
        "automatic": False,
        "remedy_detail": "Flag for manual timing adjustment using the lyric slider in the app.",
    },
    {
        "id": "karaoke_version_downloaded",
        "detection": {
            "title_contains": ["karaoke", "instrumental", "backing track", "sing along"],
            "line_density_gt": 12.0,
            "lrclib_lyrics_available": True,
        },
        "symptoms": "YouTube video is already a karaoke version. Demucs has nothing to remove.",
        "remedy": "skip_demucs_use_as_is",
        "automatic": True,
        "remedy_detail": "Skip Demucs, use video audio as-is, fetch external lyrics from LRCLIB.",
    },
    {
        "id": "no_lyrics_anywhere",
        "detection": {
            "lrclib_found": False,
            "whisper_word_count_lt": 5,
            "line_density_gt": 20.0,
        },
        "symptoms": "No lyrics found on LRCLIB and Whisper transcribed almost nothing. Track is unlyricable.",
        "remedy": "flag_as_no_lyrics",
        "automatic": True,
        "remedy_detail": "Mark as no-lyrics in tags.json. Render without lyric overlay.",
    },
]

# ── Non-Latin character detection ───────────────────────────────────────

_NON_LATIN_RE = re.compile(r'[\u0400-\u04FF\u0600-\u06FF\u0900-\u097F'
                            '\u0E00-\u0E7F\u2E80-\u2FDF\u3000-\u303F'
                            '\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF'
                            '\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]')


def contains_non_latin(text: str) -> bool:
    """Check if text contains non-Latin characters (Cyrillic, Arabic, CJK, Thai, etc.)."""
    return bool(_NON_LATIN_RE.search(text))


# ── Diagnostic function ──────────────────────────────────────────────────


def diagnose_failure(
    *,
    vocal_onset: Optional[float],
    duration: float,
    word_count: int,
    line_count: int,
    quality_verdict: str,
    correction_offset: Optional[float],
    lrclib_found: bool,
    lrclib_lyrics_available: bool,
    whisper_used: bool,
    whisper_language: str,
    youtube_title: str,
) -> Optional[dict]:
    """Match pipeline state against known failure modes.

    Returns {'confidence': float, 'mode': {...}} or None if all looks good.
    """
    line_density = duration / max(line_count, 1)
    merged_title = youtube_title.lower()

    for mode in PIPELINE_FAILURE_MODES:
        det = mode["detection"]
        match = True

        if "vocal_onset_lt" in det:
            if vocal_onset is None or vocal_onset >= det["vocal_onset_lt"]:
                match = False
        if "offset_gt" in det:
            if correction_offset is None or abs(correction_offset) <= det["offset_gt"]:
                match = False
        if "word_count_lt" in det:
            if word_count >= det["word_count_lt"]:
                match = False
        if "whisper_word_count_lt" in det:
            if word_count >= det["whisper_word_count_lt"]:
                match = False
        if "line_density_gt" in det:
            if line_density <= det["line_density_gt"]:
                match = False
        if "correction_offset_gt" in det:
            if correction_offset is None or abs(correction_offset) <= det["correction_offset_gt"]:
                match = False
        if "vocal_onset_is_none" in det:
            if vocal_onset is not None:
                match = False

        if "lrc_quality_verdict" in det and det["lrc_quality_verdict"] != quality_verdict:
            match = False
        if "lrclib_found" in det and det["lrclib_found"] != lrclib_found:
            match = False
        if "lrclib_lyrics_available" in det and det["lrclib_lyrics_available"] != lrclib_lyrics_available:
            match = False
        if "whisper_used" in det and det["whisper_used"] != whisper_used:
            match = False
        if "whisper_language" in det and det["whisper_language"] != whisper_language:
            match = False
        if "title_contains_non_latin" in det and not contains_non_latin(merged_title):
            match = False
        if "title_contains" in det:
            if not any(needle in merged_title for needle in det["title_contains"]):
                match = False

        if match:
            return {"confidence": 0.85, "mode": mode}

    return None
