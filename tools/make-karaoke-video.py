#!/usr/bin/env python3
"""
Karaoke video maker pipeline.

Takes a YouTube URL, downloads the video, removes lead vocals with Demucs,
fetches synced lyrics from LRCLIB, and renders a karaoke video with timed
lyric overlay into the Karol library.

Usage:
    python3 scripts/make-karaoke-video.py <youtube-url>
    python3 scripts/make-karaoke-video.py <youtube-url> --artist "Artist Name" --title "Song Title"
    python3 scripts/make-karaoke-video.py <youtube-url> --no-cleanup --dry-run

Requirements:
    - yt-dlp (brew install yt-dlp or pip install yt-dlp)
    - ffmpeg (brew install ffmpeg)
    - demucs (pip install demucs)
    - requests (pip install requests)
"""

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path
from typing import Optional
from urllib.parse import quote

try:
    from pipeline_decisions import diagnose_failure  # type: ignore[import-untyped]
except ImportError:
    diagnose_failure = None  # type: ignore[assignment]
    # Fallback: pipeline_decisions.py not in path — skip rule-based diagnosis

import requests  # type: ignore[import-untyped]

# ── Paths ────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
EXTERNAL_DRIVE = Path('/Volumes/maxone')
LIBRARY_DIR = EXTERNAL_DRIVE / 'Deskreen'
LIBRARY_KARAOKE_DIR = LIBRARY_DIR / 'karaoke'
TAGS_PATH = LIBRARY_DIR / 'tags.json'
ARCHIVE_PATH = LIBRARY_DIR / 'youtube-download-archive.txt'
TEMP_BASE = PROJECT_ROOT / '.karol' / 'karaoke-temp'  # internal SSD for fast transcoding
LRCLIB_API = "https://lrclib.net/api/get"
LRCLIB_SEARCH_API = "https://lrclib.net/api/search"
LRCLIB_UA = {"User-Agent": "KarolKaraoke/1.0 (https://github.com/karol)"}
# ffmpeg-full (keg-only on macOS) has drawtext/libfreetype compiled in
# Regular Homebrew ffmpeg does not. Try full first, fall back to Homebrew.
_HOMEBREW_BIN = "/opt/homebrew/bin"
_FFMPEG_BIN = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg" if os.path.exists("/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg") else f"{_HOMEBREW_BIN}/ffmpeg"
_FFMPEG_BIN = shutil.which(_FFMPEG_BIN) or shutil.which("ffmpeg") or "ffmpeg"
_FFPROBE_BIN = f"{_HOMEBREW_BIN}/ffprobe"
if not shutil.which(_FFPROBE_BIN):
    _FFPROBE_BIN = shutil.which("ffprobe") or "ffprobe"
_YTDLP_BIN = f"{_HOMEBREW_BIN}/yt-dlp"
# yt-dlp needs a dir with both ffmpeg + ffprobe (not ffmpeg-full alone).
_YTDLP_FFMPEG_LOCATION = _HOMEBREW_BIN if os.path.exists(f"{_HOMEBREW_BIN}/ffmpeg") else (
    os.path.dirname(_FFMPEG_BIN) if os.path.dirname(_FFMPEG_BIN) else _FFMPEG_BIN
)
_YT_COOKIES = os.path.expanduser("/Users/macdonk/Documents/GitHub/Karol/.karol/yt-cookies.txt")
_cookie_refreshed_at = 0.0

# Electron/GUI launches often have PATH=/usr/bin:/bin:/usr/sbin:/sbin — no Homebrew.
# Prepend so demucs, yt-dlp postprocessors, and bare "ffmpeg" lookups work.
def _ensure_homebrew_on_path() -> None:
    extras = []
    for d in (_HOMEBREW_BIN, os.path.dirname(_FFMPEG_BIN) if _FFMPEG_BIN else ""):
        if d and os.path.isdir(d) and d not in extras:
            extras.append(d)
    cur = os.environ.get("PATH", "")
    parts = [p for p in cur.split(":") if p]
    prepend = [d for d in extras if d not in parts]
    if prepend:
        os.environ["PATH"] = ":".join(prepend + parts)

_ensure_homebrew_on_path()

# Set by main() for whisper language override
_WHISPER_LANG: Optional[str] = None
# Set by main() for romanization (e.g., 'th' for Thai RTGS)
_RMANIZE_LANG: Optional[str] = None

# ── Pipeline Audit Log ───────────────────────────────────────────────

class AuditLog:
    """Pipeline audit log that records execution details for quality tracking.

    Written alongside the LRC JSON as ``{videoId}-karaoke.audit.json``.
    """

    def __init__(self, video_id: str, code_path: str):
        self.video_id = video_id
        self.data: dict = {
            "videoId": video_id,
            "codePath": code_path,                # "fresh" or "reprocess"
            "startedAt": time.time(),
            "steps": {},
            "warnings": [],
            "qualityGates": {},
            "demucsModel": None,
            "whisperModel": None,
            "whisperLanguage": None,
            "chunkingUsed": False,
            "chunkCount": 0,
            "chunkSizeSec": 0,
            "repetitionGuardTriggered": False,
            "audioSource": None,                  # "fresh_download", "existing_karaoke_mp4", "existing_original_mp4"
            "wordCount": 0,
            "lineCount": 0,
            "audioSourceFirstGen": None,          # True/False — whether audio is first-generation
            "completedAt": None,
        }

    def record_step(self, step: str, started_at: float = None, ended_at: float = None,
                    metadata: dict = None):
        """Record timing and metadata for a pipeline step."""
        entry = self.data["steps"].get(step, {})
        if started_at is not None:
            entry["startedAt"] = started_at
        if ended_at is not None:
            entry["endedAt"] = ended_at
            entry["elapsedSec"] = round(ended_at - entry.get("startedAt", ended_at), 1)
        if metadata:
            entry.setdefault("metadata", {}).update(metadata)
        self.data["steps"][step] = entry

    def add_warning(self, warning: str, category: str = "quality"):
        """Record a quality warning."""
        self.data["warnings"].append({
            "timestamp": time.time(),
            "category": category,
            "message": warning,
        })

    def set_whisper_params(self, model: str, language: str, chunking_used: bool,
                           chunk_count: int, chunk_size_sec: int,
                           repetition_guard_triggered: bool):
        self.data["whisperModel"] = model
        self.data["whisperLanguage"] = language
        self.data["chunkingUsed"] = chunking_used
        self.data["chunkCount"] = chunk_count
        self.data["chunkSizeSec"] = chunk_size_sec
        self.data["repetitionGuardTriggered"] = repetition_guard_triggered

    def set_demucs_model(self, model: str):
        self.data["demucsModel"] = model

    def set_lyric_stats(self, word_count: int, line_count: int):
        self.data["wordCount"] = word_count
        self.data["lineCount"] = line_count

    def set_audio_source(self, source: str, first_gen: bool):
        self.data["audioSource"] = source
        self.data["audioSourceFirstGen"] = first_gen

    def set_quality_gate(self, gate_name: str, passed: bool, detail: str = ""):
        self.data["qualityGates"][gate_name] = {
            "passed": passed,
            "detail": detail,
            "checkedAt": time.time(),
        }

    def finalize(self):
        self.data["completedAt"] = time.time()
        self.data["totalElapsedSec"] = round(
            self.data["completedAt"] - self.data["startedAt"], 1)

    def write(self, directory: str):
        """Write the audit log to ``{videoId}-karaoke.audit.json`` in the given directory."""
        self.finalize()
        path = os.path.join(directory, f"{self.video_id}-karaoke.audit.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.data, f, indent=2, ensure_ascii=False)
        return path


# ── Pipeline Quality Guardrails ──────────────────────────────────────

def guardrail_check_audio_source(audit: AuditLog, instrumental_path: str,
                                 is_reprocess: bool, mp4_path: str) -> None:
    """Guardrail: ensure instrumental audio is first-generation in reprocess mode.

    If the instrumental path came from re-extracting audio from an existing
    karaoke MP4, this would cause cascading AAC quality loss.  Raise a loud
    warning and flag the quality gate as failed.
    """
    if not is_reprocess:
        audit.set_audio_source("fresh_download", True)
        return

    # Check if instrumental_path appears to be from a karaoke MP4 re-extract.
    # Heuristic: if mp4_path ends with "-karaoke.mp4" and instrumental_path
    # is the Demucs output from that same path (same video_id in the temp dir).
    karaoke_back_re = re.compile(r"-karaoke(?:-\d+)?\.mp4$")
    if karaoke_back_re.search(mp4_path):
        audit.set_audio_source("existing_karaoke_mp4", False)
        msg = (
            "AUDIO CASCADE DETECTED: Instrumental appears to be re-extracted from an "
            "already-AAC-encoded karaoke MP4. This causes multi-generational lossy "
            "audio degradation. Fresh Demucs separation from the original source is required."
        )
        log("guardrail", msg)
        audit.add_warning(msg, "audio_cascade")
        audit.set_quality_gate("audio_source_first_gen", False,
                               "Instrumental re-extracted from karaoke MP4")
    else:
        audit.set_audio_source("fresh_download", True)
        audit.set_quality_gate("audio_source_first_gen", True,
                               "Instrumental from fresh Demucs separation")


def guardrail_check_whisper_chunking(audit: AuditLog, duration: float,
                                     chunk_count: int, is_whisper_used: bool) -> None:
    """Guardrail: warn if Whisper is used in a single pass on > 90s of audio.

    Single-pass transcription on long audio causes opening-line loss.
    """
    if not is_whisper_used:
        return
    if chunk_count <= 1 and duration > 90.0:
        msg = (
            f"WHISPER CHUNKING WARNING: Single pass on {duration:.0f}s of audio "
            f"(no chunking). Opening lyrics may be lost or compressed. "
            f"Re-run with chunked transcription for better coverage."
        )
        log("guardrail", msg)
        audit.add_warning(msg, "whisper_chunking")
        audit.set_quality_gate("whisper_chunking", False,
                               f"Single pass on {duration:.0f}s audio")
    else:
        audit.set_quality_gate("whisper_chunking", True,
                               f"{chunk_count} chunks used for {duration:.0f}s audio")


def guardrail_check_whisper_word_count(audit: AuditLog, word_count: int,
                                       duration: float, is_whisper_used: bool) -> None:
    """Guardrail: If Whisper returns < 50 words for a > 120s song, flag as likely failure."""
    if not is_whisper_used:
        return
    if word_count < 50 and duration > 120.0:
        msg = (
            f"WHISPER WORD COUNT FAILURE: Only {word_count} words transcribed "
            f"for a {duration:.0f}s song (threshold: 50). Transcription likely "
            f"failed — consider re-transcribing with different parameters."
        )
        log("guardrail", msg)
        audit.add_warning(msg, "whisper_word_count")
    # Always record the gate result
    audit.set_quality_gate(
        "whisper_word_count",
        not (word_count < 50 and duration > 120.0),
        f"{word_count} words for {duration:.0f}s audio"
    )


def guardrail_check_lyric_overlaps(audit: AuditLog, lines: list) -> None:
    """Guardrail: overlapping lyric cues (chunk-seam artifacts) fail the gate."""
    if not lines or len(lines) < 2:
        audit.set_quality_gate("lyric_no_overlap", True, "Fewer than 2 lines")
        return
    sorted_lines = sorted(lines, key=lambda l: l.get("startTime", 0))
    bad = []
    for i in range(1, len(sorted_lines)):
        prev, cur = sorted_lines[i - 1], sorted_lines[i]
        overlap = min(prev.get("endTime", 0), cur.get("endTime", 0)) - max(
            prev.get("startTime", 0), cur.get("startTime", 0)
        )
        if overlap > 0.25:
            bad.append((i - 1, i, round(overlap, 2)))
    if bad:
        detail = f"{len(bad)} overlaps (worst {max(o for _,_,o in bad):.2f}s)"
        msg = f"LYRIC OVERLAP DETECTED: {detail}"
        log("guardrail", msg)
        audit.add_warning(msg, "lyric_overlaps")
        audit.set_quality_gate("lyric_no_overlap", False, detail)
    else:
        audit.set_quality_gate("lyric_no_overlap", True, "No overlapping cues")


def guardrail_check_lyric_gaps(audit: AuditLog, lines: list,
                               duration: float) -> None:
    """Guardrail: if there's a gap > 30s between lyric lines in the first third, flag it."""
    if not lines or duration <= 0:
        return

    first_third_end = duration / 3.0
    sorted_lines = sorted(lines, key=lambda l: l.get("startTime", 0))

    for i in range(1, len(sorted_lines)):
        curr_start = sorted_lines[i].get("startTime", 0)
        prev_end = sorted_lines[i - 1].get("endTime",
                                           sorted_lines[i - 1].get("startTime", 0))
        gap = curr_start - prev_end
        # Only check gaps within the first third of the song
        if prev_end >= first_third_end:
            break
        if gap > 30.0:
            msg = (
                f"LYRIC GAP DETECTED: {gap:.1f}s gap between lines "
                f"at {prev_end:.1f}s-{curr_start:.1f}s in first third of song. "
                f"Possible missed opening lyrics."
            )
            log("guardrail", msg)
            audit.add_warning(msg, "lyric_gaps")
            audit.set_quality_gate("lyric_gaps", False,
                                   f"{gap:.1f}s gap at {prev_end:.1f}s-{curr_start:.1f}s")
            return

    audit.set_quality_gate("lyric_gaps", True, "No large gaps in first third")


def pre_render_quality_gate(
    audit: AuditLog,
    instrumental_path: str,
    is_reprocess: bool,
    mp4_path: str,
    lyrics_data: dict,
    duration: float,
    is_whisper_used: bool,
    chunk_count: int,
    expected_word_count: int = 0,
) -> bool:
    """Pre-render quality gate that checks all guardrails.

    Returns True if library write is allowed. Critical lyric failures block
    overwriting existing good files — the show does NOT go on with garbage.
    """
    log("quality-gate", "Running pre-render quality gate ...")

    # Gate 1: Audio source is first-generation (warn only — don't block lyrics-only)
    guardrail_check_audio_source(audit, instrumental_path, is_reprocess, mp4_path)

    # Gate 2: Lyrics have >= 30 words
    word_count = 0
    lines = lyrics_data.get("lines", []) if isinstance(lyrics_data, dict) else []
    for line in lines:
        arr = line.get("words") or []
        if arr:
            word_count += len(arr)
        else:
            word_count += len((line.get("text") or "").split())
    audit.set_lyric_stats(word_count, len(lines))

    if word_count < 30:
        msg = (f"LYRIC WORD COUNT LOW: Only {word_count} words in lyrics "
               f"(threshold: 30). Rendering may produce poor results.")
        log("quality-gate", msg)
        audit.add_warning(msg, "lyric_word_count")
        audit.set_quality_gate("lyric_word_count_min_30", False,
                               f"Only {word_count} words")
    else:
        audit.set_quality_gate("lyric_word_count_min_30", True,
                               f"{word_count} words")

    # Gate 3: Lyrics start within the first 45s of the song
    if lines:
        first_line_start = lines[0].get("startTime", lines[0].get("start", 0)) or 0
        if first_line_start > 45.0:
            msg = (f"LYRIC START DELAYED: First lyric line at {first_line_start:.1f}s "
                   f"(threshold: 45s). Lyrics may be missing the song opening.")
            log("quality-gate", msg)
            audit.add_warning(msg, "lyric_start_delayed")
            audit.set_quality_gate("lyric_start_within_45s", False,
                                   f"First line at {first_line_start:.1f}s")
        else:
            audit.set_quality_gate("lyric_start_within_45s", True,
                                   f"First line at {first_line_start:.1f}s")
    else:
        audit.set_quality_gate("lyric_start_within_45s", False, "No lyric lines found")

    # Gate 4: Whisper chunking check
    guardrail_check_whisper_chunking(audit, duration, chunk_count, is_whisper_used)

    # Gate 5: Whisper word count check
    guardrail_check_whisper_word_count(audit, word_count, duration, is_whisper_used)

    # Gate 6: Lyric gap check
    guardrail_check_lyric_gaps(audit, lines, duration)

    # Gate 6b: Overlapping cues (chunk-seam artifacts)
    guardrail_check_lyric_overlaps(audit, lines)

    # Gate 7: If we had ground-truth lyrics, require at least 50% of expected words
    if expected_word_count > 0:
        pct = word_count / max(expected_word_count, 1) * 100
        if pct < 50.0:
            msg = (f"GROUND-TRUTH YIELD LOW: {word_count}/{expected_word_count} words "
                   f"({pct:.0f}% < 50%). Refusing to overwrite library lyrics.")
            log("quality-gate", msg)
            audit.add_warning(msg, "ground_truth_yield")
            audit.set_quality_gate("ground_truth_yield_min_50", False,
                                   f"{word_count}/{expected_word_count} ({pct:.0f}%)")
        else:
            audit.set_quality_gate("ground_truth_yield_min_50", True,
                                   f"{word_count}/{expected_word_count} ({pct:.0f}%)")

    # Summarize
    gates = audit.data["qualityGates"]
    failed = [k for k, v in gates.items() if not v.get("passed", True)]
    warnings_count = len(audit.data["warnings"])
    log("quality-gate",
        f"Gate results: {len(gates)} checks, {len(failed)} failed, {warnings_count} warnings")
    if failed:
        log("quality-gate", f"Failed gates: {', '.join(failed)}")

    # Critical gates that block library lyric overwrites.
    # lyric_no_overlap is warn-only: YouTube auto-captions routinely overlap and
    # blocking would drop Thai gold-standard LRCs while still publishing audio.
    critical = {
        "lyric_word_count_min_30",
        "whisper_word_count",
        "ground_truth_yield_min_50",
    }
    failed_critical = [k for k in failed if k in critical]
    if failed_critical:
        log("quality-gate",
            f"BLOCKING library write — critical failures: {', '.join(failed_critical)}")
        return False
    return True


def _lrc_score(data: dict) -> tuple[int, int, float]:
    """Score an LRC JSON: (word_count, line_count, first_start). Higher words/lines = better."""
    lines = _primary_lines(data) if isinstance(data, dict) else []
    words = 0
    for line in lines:
        arr = line.get("words") or []
        if arr:
            words += len(arr)
        else:
            words += len((line.get("text") or "").split())
    first = 0.0
    if lines:
        first = float(lines[0].get("startTime", lines[0].get("start", 0)) or 0)
    return words, len(lines), first


def _primary_lines(data: dict) -> list:
    """Return the display-primary lines from a multi-track or legacy LRC."""
    if not isinstance(data, dict):
        return []
    tracks = data.get("tracks") if isinstance(data.get("tracks"), dict) else None
    if tracks:
        display = data.get("display") if isinstance(data.get("display"), dict) else {}
        primary = display.get("primary")
        if primary and isinstance(tracks.get(primary), dict) and tracks[primary].get("lines"):
            return tracks[primary]["lines"]
        for key in ("romanized", "sung", "english"):
            if isinstance(tracks.get(key), dict) and tracks[key].get("lines"):
                return tracks[key]["lines"]
        for tr in tracks.values():
            if isinstance(tr, dict) and tr.get("lines"):
                return tr["lines"]
    return data.get("lines") or []


def _track_meta(key: str) -> tuple[str, str, str]:
    """Return (lang, label, role) defaults for a track key."""
    if key == "english":
        return "en", "English", "translation"
    if key == "romanized":
        return "", "Romanized", "primary"
    if key == "native":
        return "", "Native", "native"
    if key == "sung":
        return "", "As sung", "primary"
    return "", key.replace("_", " ").title(), "primary"


def normalize_lyric_tracks(data: dict) -> dict:
    """Mirror primary track into top-level lines; attach display keys.

    Display stack for players: tertiary (above, e.g. native Thai) → primary
    (sing/highlight, e.g. RTGS) → secondary (below, e.g. English).
    """
    if not isinstance(data, dict):
        return data
    tracks = data.get("tracks") if isinstance(data.get("tracks"), dict) else None
    if not tracks:
        return data
    display = data.get("display") if isinstance(data.get("display"), dict) else {}
    primary = display.get("primary")
    secondary = display.get("secondary")
    tertiary = display.get("tertiary")
    if not primary or primary not in tracks:
        if "romanized" in tracks:
            primary = "romanized"
        elif "sung" in tracks:
            primary = "sung"
        elif "english" in tracks:
            primary = "english"
        else:
            primary = next(iter(tracks), None)
    if secondary == primary or (secondary and secondary not in tracks):
        secondary = "english" if ("english" in tracks and primary != "english") else None
    if (
        not tertiary
        or tertiary not in tracks
        or tertiary == primary
        or tertiary == secondary
    ):
        # Prefer native script above RTGS when all three layers exist
        if primary == "romanized":
            if "native" in tracks and secondary != "native":
                tertiary = "native"
            elif "sung" in tracks and secondary != "sung":
                tertiary = "sung"
            else:
                tertiary = None
        else:
            tertiary = None
    if primary and isinstance(tracks.get(primary), dict):
        data["lines"] = tracks[primary].get("lines") or []
        am = tracks[primary].get("alignMode")
        if am:
            data["alignMode"] = am
            # Keep catalog provenance (lrclib_synced etc.); alignMode carries timing method
            prev_src = str(data.get("source") or "")
            if not (
                prev_src.startswith("lrclib")
                or prev_src in ("user_paste", "karaoke_captions", "genius", "azlyrics", "scrape")
            ):
                data["source"] = am
    data["display"] = {
        "primary": primary,
        "secondary": secondary,
        "tertiary": tertiary,
    }
    return data


def merge_lyric_track(
    existing: Optional[dict],
    incoming: dict,
    track_key: str = "sung",
    *,
    protect_english: bool = True,
    force: bool = False,
    legacy_as: str = "english",
    lang: Optional[str] = None,
    label: Optional[str] = None,
    role: Optional[str] = None,
    display_primary: Optional[str] = None,
    display_secondary: Optional[str] = None,
) -> dict:
    """Merge incoming single-track LRC into existing multi-track without dropping other tracks."""
    import copy
    base = copy.deepcopy(existing) if isinstance(existing, dict) else {}
    incoming = incoming if isinstance(incoming, dict) else {}
    incoming_lines = incoming.get("lines") if isinstance(incoming.get("lines"), list) else []
    key = track_key or "sung"

    if not isinstance(base.get("tracks"), dict):
        base["tracks"] = {}

    # Migrate legacy top-level lines into a named track once
    if (isinstance(base.get("lines"), list) and base["lines"]
            and not base["tracks"]):
        lg, ll, lr = _track_meta(legacy_as)
        base["tracks"][legacy_as] = {
            "lang": lg,
            "label": ll,
            "role": lr,
            "lines": base["lines"],
            "alignMode": base.get("alignMode") or base.get("source") or "",
        }

    if (protect_english and key == "english"
            and isinstance(base["tracks"].get("english"), dict)
            and base["tracks"]["english"].get("lines")
            and not force):
        log("lyrics", "Preserving existing tracks.english (protect_english)")
        return normalize_lyric_tracks(base)

    dlang, dlabel, drole = _track_meta(key)
    base["tracks"][key] = {
        "lang": lang if lang is not None else dlang,
        "label": label or dlabel,
        "role": role or drole,
        "lines": incoming_lines,
        "alignMode": incoming.get("alignMode") or incoming.get("source") or "",
    }

    if incoming.get("videoId"):
        base["videoId"] = incoming["videoId"]
    if incoming.get("duration") is not None:
        base["duration"] = incoming["duration"]
    if incoming.get("title"):
        base["title"] = base.get("title") or incoming["title"]
    if incoming.get("artist"):
        base["artist"] = base.get("artist") or incoming["artist"]
    if incoming.get("lrclibId") is not None and key != "english":
        base["lrclibId"] = incoming["lrclibId"]

    primary = display_primary or (
        "romanized" if key == "romanized"
        else ("sung" if key == "sung" else (base.get("display") or {}).get("primary") or key)
    )
    if display_secondary is not None:
        secondary = display_secondary
    else:
        secondary = "english" if ("english" in base["tracks"] and primary != "english") else None
    # EN-only: primary english, no secondary
    if primary == "english" and secondary == "english":
        secondary = None
    base["display"] = {"primary": primary, "secondary": secondary}
    return normalize_lyric_tracks(base)


def publish_merged_lrc(
    src_path: Path | str,
    dest_path: Path | str,
    track_key: str = "sung",
    *,
    force: bool = False,
    protect_english: bool = True,
    legacy_as: str = "english",
) -> bool:
    """Publish src LRC into dest as a named track, preserving other tracks on disk.

    Returns True if dest was written.
    """
    src_path = Path(src_path)
    dest_path = Path(dest_path)
    if not src_path.exists():
        return False
    try:
        incoming = json.loads(src_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        log("library", f"Failed to read incoming LRC: {e}")
        return False

    existing = None
    if dest_path.exists():
        try:
            existing = json.loads(dest_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            existing = None

    # If incoming already has tracks, merge those keys in without wiping others
    if isinstance(incoming.get("tracks"), dict) and incoming["tracks"]:
        base = existing if isinstance(existing, dict) else {}
        if not isinstance(base.get("tracks"), dict):
            base["tracks"] = {}
        if (isinstance(base.get("lines"), list) and base["lines"] and not base["tracks"]):
            lg, ll, lr = _track_meta(legacy_as)
            base["tracks"][legacy_as] = {
                "lang": lg, "label": ll, "role": lr,
                "lines": base["lines"],
                "alignMode": base.get("alignMode") or base.get("source") or "",
            }
        for k, tr in incoming["tracks"].items():
            if (protect_english and k == "english"
                    and isinstance(base["tracks"].get("english"), dict)
                    and base["tracks"]["english"].get("lines") and not force):
                continue
            base["tracks"][k] = tr
        if incoming.get("display"):
            base["display"] = incoming["display"]
        if incoming.get("videoId"):
            base["videoId"] = incoming["videoId"]
        if incoming.get("duration") is not None:
            base["duration"] = incoming["duration"]
        merged = normalize_lyric_tracks(base)
    else:
        # Decide overwrite for this track only
        if existing is not None and not force:
            # Writing a non-english track into an existing multi-track file is always OK
            has_other = (
                isinstance(existing.get("tracks"), dict)
                and any(k != track_key for k in existing["tracks"])
            ) or (
                isinstance(existing.get("lines"), list)
                and existing["lines"]
                and track_key != "english"
            )
            if not has_other:
                # Single-track replace still uses quality ranking
                tmp = dest_path.parent / f".cmp-{dest_path.name}.{os.getpid()}"
                try:
                    tmp.write_text(json.dumps(incoming), encoding="utf-8")
                    if not should_overwrite_lrc(dest_path, tmp, force=False):
                        log("library", f"Kept existing LRC (new result not better): {dest_path}")
                        return False
                finally:
                    try:
                        tmp.unlink()
                    except OSError:
                        pass

        merged = merge_lyric_track(
            existing,
            incoming,
            track_key,
            protect_english=protect_english,
            force=force,
            legacy_as=legacy_as,
        )

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    staging = dest_path.parent / f".staging-{dest_path.name}.{os.getpid()}.part"
    try:
        staging.write_text(json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8")
        with open(staging, "rb+") as f:
            os.fsync(f.fileno())
        os.replace(staging, dest_path)
    finally:
        if staging.exists():
            try:
                staging.unlink()
            except OSError:
                pass
    repair_lrc_json_words(dest_path)
    log("library", f"Published track '{track_key}' → {dest_path}")
    return True


def _lrc_source_rank(data: dict) -> int:
    """Higher = more trusted. Force-aligned catalog text beats raw LRCLIB times."""
    mode = str(data.get("alignMode") or data.get("source") or "").lower()
    # Demucs-vocal Whisper keep-text is the gold timing for catalog words
    if "keep-text" in mode:
        return 105
    if mode.startswith("lrclib_synced"):
        return 100
    if "lrclib" in mode and "synced" in mode:
        return 100
    if mode in ("karaoke_captions", "embedded_subs") or mode.startswith("karaoke"):
        return 60
    if mode.endswith("+force") or mode == "reconcile+force":
        return 30
    if mode.endswith("+align"):
        return 25
    if mode.endswith("+approx") or "approx" in mode:
        return 10
    if mode in ("whisper_invent", "whisper"):
        return 5
    return 40  # unknown / plain


def _iter_lrc_json_lines(data: dict) -> list[dict]:
    """Primary track lines from multi-track or legacy single-track LRC JSON."""
    if not isinstance(data, dict):
        return []
    tracks = data.get("tracks") if isinstance(data.get("tracks"), dict) else None
    if tracks:
        try:
            key = _primary_track_key(data)
        except Exception:  # noqa: BLE001
            key = "sung"
        lines = (tracks.get(key) or {}).get("lines") or []
        if lines:
            return list(lines)
        for tr in tracks.values():
            if isinstance(tr, dict) and tr.get("lines"):
                return list(tr["lines"])
    return list(data.get("lines") or [])


def _lrc_json_timing_broken(data: dict, duration: float) -> bool:
    """True when catalog/proportional timings are unusable for this cut."""
    if duration <= 1:
        return False
    lines = _iter_lrc_json_lines(data)
    if not lines:
        return True
    past = 0
    for ln in lines:
        st = float(ln.get("startTime") or 0)
        en = float(ln.get("endTime") or st)
        if st >= duration - 0.25:
            past += 1
        if en > duration + 2.0 and st < duration:
            # end clipped past EOF is common; start past EOF is fatal
            pass
        if st >= duration:
            past += 1
    if past >= 1:
        return True
    # Giant first-line smear (proportional fill across a huge LRCLIB gap)
    first = lines[0]
    f_st = float(first.get("startTime") or 0)
    f_en = float(first.get("endTime") or f_st)
    if (f_en - f_st) > 25.0:
        return True
    if len(lines) >= 2:
        gap = float(lines[1].get("startTime") or 0) - f_st
        if gap > 40.0:
            return True
    return False


def _clamp_lrc_json_to_duration(data: dict, duration: float) -> None:
    """In-place clamp of cue times so nothing starts past EOF (last-resort publish)."""
    if duration <= 1:
        return
    max_start = max(0.0, duration - 0.35)

    def _clamp_lines(lines: list) -> None:
        for ln in lines or []:
            st = float(ln.get("startTime") or 0)
            en = float(ln.get("endTime") or st)
            if st > max_start:
                st = max_start
            if en > duration:
                en = duration
            if en < st:
                en = min(duration, st + 0.4)
            ln["startTime"] = round(st, 2)
            ln["endTime"] = round(en, 2)
            words = ln.get("words") or []
            if words:
                for w in words:
                    ws = float(w.get("startTime") or st)
                    we = float(w.get("endTime") or ws)
                    ws = min(max(ws, st), en)
                    we = min(max(we, ws), en)
                    w["startTime"] = round(ws, 2)
                    w["endTime"] = round(we, 2)

    tracks = data.get("tracks") if isinstance(data.get("tracks"), dict) else None
    if tracks:
        for tr in tracks.values():
            if isinstance(tr, dict):
                _clamp_lines(tr.get("lines") or [])
    _clamp_lines(data.get("lines") or [])


def _catalog_text_source(source: str) -> bool:
    """Sources whose *words* we keep and force-align (never invent)."""
    s = (source or "").lower()
    if not s:
        return False
    if s.startswith("lrclib"):
        return True
    if s in ("user_paste", "karaoke_captions", "genius", "azlyrics", "scrape"):
        return True
    if s.endswith("+force") and any(
        s.startswith(p) for p in ("lrclib", "user_paste", "karaoke", "genius", "azlyrics")
    ):
        return True
    return False


def should_overwrite_lrc(existing_path: Path, new_path: Path, force: bool = False) -> bool:
    """Refuse to overwrite an existing LRC with a worse one.

    Synced LRCLIB on disk is sticky: never replaced by Whisper/approx/force
    unless ``force`` is True.
    """
    if force:
        return True
    if not existing_path.exists():
        return True
    if not new_path.exists():
        return False
    try:
        old = json.loads(existing_path.read_text(encoding="utf-8"))
        new = json.loads(new_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        log("quality-gate", f"LRC compare failed ({e}) — keeping existing")
        return False

    # Always replace WEBVTT/garbage dumps left by older caption bugs
    if _lrc_json_is_garbage(old):
        log("quality-gate", "Existing LRC is garbage — allowing overwrite")
        return True

    old_rank = _lrc_source_rank(old)
    new_rank = _lrc_source_rank(new)
    # keep-text (105) may replace raw lrclib_synced (100); never the reverse
    if old_rank >= 100 and new_rank < 100:
        log("quality-gate",
            f"Keeping existing catalog LRC — refusing downgrade "
            f"(old rank={old_rank}, new alignMode={new.get('alignMode') or new.get('source')!r})")
        return False
    if old_rank > new_rank + 15:
        log("quality-gate",
            f"Keeping existing LRC (rank {old_rank}) — new rank {new_rank} is worse")
        return False
    # Prefer force-aligned keep-text over raw catalog times even when ranks are close
    if new_rank >= 105 and old_rank <= 100 and "keep-text" in str(
        new.get("alignMode") or ""
    ).lower():
        log("quality-gate", "Allowing keep-text force-align overwrite of raw catalog timings")
        return True

    old_w, old_n, old_start = _lrc_score(old)
    new_w, new_n, new_start = _lrc_score(new)

    # Hard reject: new is tiny / empty relative to old
    if old_w >= 50 and new_w < max(30, int(old_w * 0.4)):
        log("quality-gate",
            f"Keeping existing LRC ({old_w} words) — new is worse ({new_w} words)")
        return False
    if old_n >= 20 and new_n < max(6, int(old_n * 0.3)):
        log("quality-gate",
            f"Keeping existing LRC ({old_n} lines) — new is worse ({new_n} lines)")
        return False
    # Prefer earlier first lyric if old was already early and new starts very late
    if old_start < 20 and new_start > 60 and new_w <= old_w:
        log("quality-gate",
            f"Keeping existing LRC (first@{old_start:.0f}s) — new starts too late ({new_start:.0f}s)")
        return False
    return True


def _prompt_for_chunk(lyric_lines: list[str], chunk_idx: int, n_chunks: int) -> str:
    """Return a time-window slice of known lyrics for one Whisper chunk.

    Avoids dumping the entire song into every 60s window (which causes
    hallucinations and tiny alignment yield).
    """
    if not lyric_lines:
        return ""
    n = len(lyric_lines)
    if n_chunks <= 1:
        return " ".join(lyric_lines)
    start = int(chunk_idx * n / n_chunks)
    end = int((chunk_idx + 1) * n / n_chunks)
    overlap = max(2, n // max(n_chunks * 4, 1))
    start = max(0, start - overlap)
    end = min(n, end + overlap)
    if end <= start:
        end = min(n, start + max(1, n // n_chunks))
    return " ".join(lyric_lines[start:end])


# ── Helpers ──────────────────────────────────────────────────────────


def log(step: str, msg: str) -> None:
    """Print structured progress line for API consumption."""
    ts = time.time()
    print(f"[{ts:.0f}] {step}: {msg}", flush=True)


def fatal(msg: str, exit_code: int = 1) -> None:
    """Print error and exit."""
    print(f"FATAL: {msg}", file=sys.stderr, flush=True)
    sys.exit(exit_code)


def extract_video_id(url: str) -> str:
    """Extract YouTube video ID from a URL or bare ID string."""
    # Bare 11-char ID
    if re.fullmatch(r"[a-zA-Z0-9_-]{11}", url.strip()):
        return url.strip()
    # URL patterns
    match = re.search(r"(?:v=|youtu\.be/|embed/|shorts/)([a-zA-Z0-9_-]{11})", url)
    if match:
        return match.group(1)
    fatal(f"Could not extract YouTube video ID from: {url}")


def run(cmd: list[str], timeout: int = 600, check: bool = True, env: Optional[dict] = None) -> subprocess.CompletedProcess:
    """Run a command and return CompletedProcess. Raises on failure if check=True."""
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        if check:
            fatal(f"Command timed out ({timeout}s): {' '.join(cmd[:4])} ...")
        raise
    if check and result.returncode != 0:
        stderr_tail = result.stderr.strip()[-300:] if result.stderr else "(no stderr)"
        fatal(f"Command failed (exit {result.returncode}): {' '.join(cmd[:4])} ...\n{stderr_tail}")
    return result


def _cookies_look_logged_in(path: str) -> bool:
    try:
        text = Path(path).read_text(encoding="utf-8", errors="ignore")
        return any(k in text for k in ("LOGIN_INFO", "SAPISID", "__Secure-1PSID", "__Secure-3PSID"))
    except OSError:
        return False


def refresh_yt_cookies(force: bool = False) -> bool:
    """Export Chrome's YouTube cookies into the Netscape jar used by yt-dlp.

    Using a file jar is more reliable than concurrent --cookies-from-browser
    (Chrome DB locks) and keeps us on a logged-in session to reduce 429s.
    """
    global _cookie_refreshed_at
    now = time.time()
    if (
        not force
        and os.path.exists(_YT_COOKIES)
        and os.path.getsize(_YT_COOKIES) > 100
        and (now - os.path.getmtime(_YT_COOKIES)) < 1800
        and (now - _cookie_refreshed_at) < 1800
    ):
        return True
    try:
        os.makedirs(os.path.dirname(_YT_COOKIES) or ".", exist_ok=True)
        log("auth", "Refreshing YouTube cookies from Chrome (logged-in session) ...")
        run([
            _YTDLP_BIN,
            "--cookies-from-browser", "chrome",
            "--cookies", _YT_COOKIES,
            "-s", "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        ], timeout=60, check=False)
        if os.path.exists(_YT_COOKIES) and os.path.getsize(_YT_COOKIES) > 100:
            _cookie_refreshed_at = now
            state = "logged-in" if _cookies_look_logged_in(_YT_COOKIES) else "anonymous/unknown"
            log("auth", f"Cookie jar ready ({state}): {_YT_COOKIES}")
            return True
        log("auth", "Cookie refresh produced no jar — will fall back to live Chrome cookies")
    except Exception as e:
        log("auth", f"Cookie refresh failed: {e}")
    return False


def ytdlp_ffmpeg_args() -> list[str]:
    """Point yt-dlp at Homebrew ffmpeg/ffprobe (GUI apps often lack them on PATH)."""
    return ["--ffmpeg-location", _YTDLP_FFMPEG_LOCATION]


def ytdlp_auth_args() -> list[str]:
    """Common yt-dlp flags: ffmpeg location + auth (cookie jar or live Chrome)."""
    refresh_yt_cookies()
    args = list(ytdlp_ffmpeg_args())
    if os.path.exists(_YT_COOKIES) and os.path.getsize(_YT_COOKIES) > 100:
        args.extend(["--cookies", _YT_COOKIES])
    else:
        args.extend(["--cookies-from-browser", "chrome"])
    return args


def get_video_duration(video_path: str) -> float:
    """Get video duration in seconds via ffprobe."""
    try:
        r = run(
            [
                _FFPROBE_BIN, "-v", "quiet", "-print_format", "json",
                "-show_format", video_path,
            ],
            timeout=30,
        )
        info = json.loads(r.stdout)
        return float(info["format"]["duration"])
    except (subprocess.CalledProcessError, json.JSONDecodeError, KeyError, ValueError):
        fatal(f"Could not determine duration of {video_path}")


def verify_downloaded_video(mp4_path: str, info_path: Optional[str] = None) -> tuple[bool, str]:
    """Reject truncated/corrupt muxes (frozen video = short video stream vs container)."""
    if not mp4_path or not os.path.exists(mp4_path):
        return False, "missing-file"
    try:
        size = os.path.getsize(mp4_path)
    except OSError as e:
        return False, f"stat-fail:{e}"
    if size < 50_000:
        return False, f"too-small:{size}"

    expected_duration = None
    expected_size = None
    candidates = []
    if info_path:
        candidates.append(info_path)
    candidates.append(os.path.splitext(mp4_path)[0] + ".info.json")
    if mp4_path.endswith("-karaoke.mp4"):
        candidates.append(mp4_path.replace("-karaoke.mp4", "-karaoke.info.json"))
    for p in candidates:
        if not p or not os.path.exists(p):
            continue
        try:
            with open(p, "r", encoding="utf-8") as f:
                info = json.load(f)
            if info.get("duration") is not None:
                expected_duration = float(info["duration"])
            expected_size = info.get("filesize") or info.get("filesize_approx")
            if expected_duration or expected_size:
                break
        except Exception:
            continue

    try:
        r = subprocess.run(
            [
                _FFPROBE_BIN, "-v", "error",
                "-show_entries", "format=duration,size:stream=codec_type,codec_name,duration",
                "-of", "json", mp4_path,
            ],
            capture_output=True, text=True, timeout=60,
        )
        if r.returncode != 0:
            return False, f"ffprobe-fail:{(r.stderr or '')[:120]}"
        data = json.loads(r.stdout or "{}")
    except Exception as e:
        return False, f"ffprobe-fail:{e}"

    streams = data.get("streams") or []
    fmt = data.get("format") or {}
    videos = [s for s in streams if s.get("codec_type") == "video" and s.get("codec_name") != "png"]
    audios = [s for s in streams if s.get("codec_type") == "audio"]
    if not videos or not audios:
        return False, "missing-av"
    try:
        fdur = float(fmt.get("duration") or 0)
    except (TypeError, ValueError):
        fdur = 0.0
    try:
        vdur = float(videos[0].get("duration") or 0)
    except (TypeError, ValueError):
        vdur = 0.0
    try:
        adur = float(audios[0].get("duration") or 0)
    except (TypeError, ValueError):
        adur = 0.0
    ref = max(fdur, expected_duration or 0.0)
    if ref < 5 and max(vdur, adur, fdur) < 5:
        return False, f"too-short:{max(vdur, adur, fdur):.2f}"
    if ref > 15 and vdur > 0 and vdur < ref * 0.85:
        return False, f"truncated-video vid={vdur:.2f}s ref={ref:.1f}s"
    if ref > 15 and adur > 0 and adur < ref * 0.85:
        return False, f"truncated-audio aud={adur:.2f}s ref={ref:.1f}s"
    if expected_duration and fdur > 0 and fdur < expected_duration * 0.90:
        return False, f"short-container fmt={fdur:.1f}s meta={expected_duration:.0f}s"
    if (
        expected_size
        and expected_size > 500_000
        and size < expected_size * 0.50
        and size < expected_size - 5_000_000
    ):
        return False, f"filesize size={size} meta={expected_size}"
    return True, f"{videos[0].get('codec_name')}+{audios[0].get('codec_name')} {max(vdur, fdur):.1f}s"


def quarantine_bad_download(mp4_path: str, reason: str) -> None:
    try:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        dest = f"{mp4_path}.bad-{stamp}"
        os.rename(mp4_path, dest)
        log("download", f"Quarantined incomplete/corrupt video → {dest} ({reason})")
    except OSError as e:
        log("download", f"Could not quarantine {mp4_path}: {e}")


def find_original_source_mp4(video_id: str) -> Optional[Path]:
    """Locate a verified original-mix MP4 (not karaoke instrumental).

    Preference order:
      1. karaoke/{id}.mp4  (pipeline-preserved source)
      2. songs/{id}.mp4    (Music Videos dual-presence)
      3. Deskreen/{id}.mp4 (legacy flat library)
    Corrupt/empty muxes are quarantined and skipped.
    """
    candidates = [
        LIBRARY_KARAOKE_DIR / f"{video_id}.mp4",
        LIBRARY_DIR / "songs" / f"{video_id}.mp4",
        LIBRARY_DIR / f"{video_id}.mp4",
    ]
    for cand in candidates:
        if not cand.exists() or cand.stat().st_size < 50_000:
            continue
        # Never treat the karaoke render as "original"
        if cand.name.endswith("-karaoke.mp4"):
            continue
        ok, detail = verify_downloaded_video(str(cand))
        if ok:
            return cand
        log("source", f"Skipping bad original candidate {cand.name} ({detail})")
        # Only quarantine files we own in karaoke/ (don't rename songs/)
        if cand.parent == LIBRARY_KARAOKE_DIR:
            quarantine_bad_download(str(cand), detail)
    return None


def ensure_both_stems(
    video_id: str,
    instrumental_path: Optional[str],
    vocals_path: Optional[str],
) -> tuple[str, str]:
    """Require Demucs instrumental + vocals for custom karaoke vocal-mix.

    Karaoke.mp4 carries the instrumental; the vocal WAV sidecar is what the
    player mixes for guide vocals. Both must exist and be same-generation.
    """
    if not instrumental_path or not os.path.exists(instrumental_path):
        fatal("Demucs did not produce an instrumental stem")
    if os.path.getsize(instrumental_path) < 10000:
        fatal(f"Instrumental stem too small: {instrumental_path}")
    if not vocals_path or not os.path.exists(vocals_path):
        fatal(
            "Demucs did not produce a vocal stem — custom karaoke requires both "
            "instrumental (muxed into -karaoke.mp4) and vocals (-karaoke-vocals.wav) "
            "for in-sync vocal mix"
        )
    if os.path.getsize(vocals_path) < 10000:
        fatal(f"Vocal stem too small: {vocals_path}")
    return instrumental_path, vocals_path


# ── Vocal Onset Detection ────────────────────────────────────────────


def detect_vocal_onset(wav_path: str, duration: float) -> Optional[float]:
    """Detect when vocals actually begin by analyzing the Demucs vocal stem WAV.

    Reads amplitude data in 100ms windows, finds the first sustained region
    above 3x the noise floor. Returns the onset time in seconds, or None if
    the vocal stem is not available or detection fails.
    """
    if not os.path.exists(wav_path) or os.path.getsize(wav_path) < 10000:
        log("onset", f"Vocal stem not found or too small: {wav_path}")
        return None

    try:
        with wave.open(wav_path, 'rb') as wf:
            nchannels = wf.getnchannels()
            sampwidth = wf.getsampwidth()
            framerate = wf.getframerate()
            nframes = wf.getnframes()
            raw = wf.readframes(nframes)

        log("onset", f"Analyzing vocal stem: {nchannels}ch, {sampwidth*8}bit, {framerate}Hz, {nframes} frames ({nframes/framerate:.1f}s)")

        # Convert to 16-bit samples
        if sampwidth == 2:
            import struct
            samples = struct.unpack(f'<{nframes * nchannels}h', raw)
        elif sampwidth == 1:
            samples = [b - 128 for b in raw] * nchannels
        else:
            log("onset", f"Unsupported sample width: {sampwidth}")
            return None

        # Sum channels → mono if stereo
        if nchannels == 2:
            mono = [(samples[i] + samples[i+1]) // 2 for i in range(0, len(samples), 2)]
        else:
            mono = list(samples)

        # Compute RMS energy in 100ms windows
        window_samples = int(framerate * 0.1)  # 100ms
        rms_values = []
        for i in range(0, len(mono), window_samples):
            chunk = mono[i:i + window_samples]
            if len(chunk) < window_samples // 2:
                break
            sum_sq = sum(s * s for s in chunk)
            rms = (sum_sq / len(chunk)) ** 0.5
            rms_values.append(rms)

        if not rms_values:
            return None

        # Find noise floor: take median of lowest 30% of windows
        sorted_rms = sorted(rms_values)
        cutoff = max(1, len(sorted_rms) // 3)
        noise_floor = sorted_rms[cutoff // 2] if cutoff > 1 else sorted_rms[0]
        threshold = max(noise_floor * 3.0, 200.0)  # 3x noise floor, min 200 amplitude

        log("onset", f"Noise floor: {noise_floor:.0f}, threshold: {threshold:.0f}")

        # Find first sustained region: 3+ consecutive windows above threshold
        consecutive = 0
        onset_window = None
        for i, rms in enumerate(rms_values):
            if rms >= threshold:
                consecutive += 1
                if consecutive >= 3 and onset_window is None:
                    onset_window = i - 2  # back up to first of 3
                    break
            else:
                consecutive = 0

        if onset_window is None:
            log("onset", "No sustained vocal region found")
            return None

        onset_time = onset_window * 0.1  # 100ms per window
        # Clamp to valid range
        onset_time = max(0.0, min(onset_time, duration - 1.0))

        # Handle edge case: long silence before vocals
        if onset_time > duration * 0.8:
            log("onset", f"Vocal onset at {onset_time:.1f}s (>80% of duration) — likely instrumental, using 0")
            return 0.0

        log("onset", f"Vocal onset detected at {onset_time:.1f}s (window {onset_window}, RMS threshold {threshold:.0f})")
        return round(onset_time, 2)

    except Exception as e:
        log("onset", f"Vocal onset detection failed: {e}")
        return None


# ── Whisper-based vocal onset detection ──────────────────────────────

def detect_vocal_onset_whisper(vocal_wav_path: str, duration: float, tmp_dir: str) -> Optional[float]:
    """Run whisper-timestamped on first 60s of vocal stem for reliable first-word time.

    Unlike RMS-based detection, this uses actual speech recognition, so it's
    immune to Demucs bleed-through from intro music. Uses the tiny model
    (~1-2 seconds on Apple Silicon).

    Returns the time (in seconds) of the first recognized word, or None if
    Whisper is unavailable or transcription fails.
    """
    try:
        import whisper_timestamped as wt
    except ImportError:
        log("onset", "whisper-timestamped not available — falling back to RMS")
        return None

    clip_wav = os.path.join(tmp_dir, 'onset-clip.wav')
    clip_dur = min(duration, 60.0)
    try:
        run([
            _FFMPEG_BIN, "-y", "-i", vocal_wav_path,
            "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
            "-t", str(clip_dur),
            clip_wav,
        ], timeout=30)

        lang = (_WHISPER_LANG or "en") if _WHISPER_LANG else "en"
        model_name = "tiny.en" if lang == "en" else "tiny"
        log("onset", f"Whisper onset: loading {model_name} (lang={lang})...")
        model = wt.load_model(model_name)
        result = wt.transcribe(model, clip_wav, language=lang)

        for seg in result.get("segments", []):
            words = seg.get("words", [])
            if words:
                first_word = words[0]["start"]
                log("onset", f"Whisper first word at {first_word:.1f}s")
                os.unlink(clip_wav)
                return round(first_word, 2)

        log("onset", "Whisper found no words in first 60s")
        os.unlink(clip_wav)
        return None

    except Exception as e:
        log("onset", f"Whisper onset detection failed: {e}")
        try: os.unlink(clip_wav)
        except: pass
        return None


def detect_vocal_onset_best(vocal_wav_path: str, duration: float, tmp_dir: str) -> Optional[float]:
    """Best-effort vocal onset: Whisper first, RMS fallback."""
    whisper_onset = detect_vocal_onset_whisper(vocal_wav_path, duration, tmp_dir)
    if whisper_onset is not None:
        return whisper_onset
    log("onset", "Whisper onset unavailable — falling back to RMS")
    return detect_vocal_onset(vocal_wav_path, duration)


def detect_first_real_word(audio_path: str, duration: float, tmp_dir: str) -> tuple[Optional[float], Optional[float]]:
    """Run medium.en Whisper on the first 90s to find two timing anchors.

    Returns (early_onset, anchor_onset) where:
    - early_onset: first word at all (catches "do-do-do" intro at ~12s)
    - anchor_onset: first substantial phrase (5+ words) for verse alignment (~42s)

    If only one is found, the other may be None.
    """
    try:
        import whisper_timestamped as wt
    except ImportError:
        return None, None

    clip_wav = os.path.join(tmp_dir, 'real-onset-clip.wav')
    clip_dur = min(duration, 90.0)
    try:
        run([
            _FFMPEG_BIN, "-y", "-i", audio_path,
            "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
            "-t", str(clip_dur),
            clip_wav,
        ], timeout=30)

        log("onset", "Running medium.en Whisper for two-phase timing...")
        model = wt.load_model("medium.en")
        result = wt.transcribe(model, clip_wav, language="en")

        # ── Collect all segments with timing info ──
        segments_data = []  # (start, end, text, word_count)
        for seg in result.get("segments", []):
            text = seg["text"].strip()
            words = seg.get("words", [])
            if text.lower() in ("♪", "[music]", "instrumental"):
                continue
            start_time = words[0]["start"] if words else seg["start"]
            end_time = words[-1]["end"] if words else seg["end"]
            segments_data.append((start_time, end_time, text, len(words)))

        if not segments_data:
            os.unlink(clip_wav)
            return None, None

        # ── Cluster segments by silence gaps (> 3s) ──
        CLUSTER_GAP = 3.0
        clusters = []
        current_cluster = [segments_data[0]]
        for i in range(1, len(segments_data)):
            prev_end = current_cluster[-1][1]
            curr_start = segments_data[i][0]
            if curr_start - prev_end > CLUSTER_GAP:
                clusters.append(current_cluster)
                current_cluster = [segments_data[i]]
            else:
                current_cluster.append(segments_data[i])
        clusters.append(current_cluster)

        log("onset", f"Found {len(clusters)} vocal cluster(s): " +
            ", ".join(f"[{c[0][0]:.1f}s-{c[-1][1]:.1f}s,{len(c)}seg]"
                       for c in clusters[:5]))

        # ── Skip ad-lib clusters (all segments have < 4 words each) ──
        early_onset = None
        anchor_onset = None
        for cluster in clusters:
            all_short = all(seg[3] < 4 for seg in cluster)
            if all_short:
                seg_labels = ", ".join(f"{seg[0]:.1f}s \"{seg[2][:20]}\"" for seg in cluster[:3])
                log("onset", f"Skipping ad-lib cluster [{len(cluster)}seg]: {seg_labels}")
                continue

            # This cluster has real vocal activity
            if early_onset is None:
                early_onset = round(cluster[0][0], 2)
                log("onset", f"Early onset at {early_onset:.1f}s: \"{cluster[0][2][:60]}\"")

            # Look for anchor_onset within this (and subsequent) clusters
            if anchor_onset is None:
                for seg_start, seg_end, seg_text, seg_wc in cluster:
                    meaningful = [w for w in seg_text.lower().split()
                                  if w not in ('do-do-do,', 'do-do-do-do-do', 'music',
                                               '♪', '(uh-huh)', 'and', 'goes')]
                    if seg_wc >= 5 and len(meaningful) >= 5:
                        anchor_onset = round(seg_start, 2)
                        log("onset", f"Anchor onset at {anchor_onset:.1f}s: \"{seg_text[:60]}\" ({len(meaningful)} meaningful words)")
                        break

            if early_onset is not None and anchor_onset is not None:
                break

        os.unlink(clip_wav)
        return early_onset, anchor_onset

    except Exception as e:
        log("onset", f"Real first-word detection failed: {e}")
        try: os.unlink(clip_wav)
        except: pass
        return None, None


# ── LRC Timestamp Correction ────────────────────────────────────────


def correct_lrc_timestamps(lrc_text: str, offset: float) -> str:
    """Shift all LRC timestamps by `offset` seconds.

    Positive offset = move lyrics later (intro is longer than expected).
    Negative offset = move lyrics earlier (intro is shorter).
    """
    if abs(offset) < 0.5:
        return lrc_text

    log("correct", f"Correcting LRC timestamps by {offset:+.1f}s")

    corrected_lines = []
    lrc_tag_re = re.compile(r"\[(?P<min>\d{1,3}):(?P<sec>\d{2}(?:\.\d{2,3})?)\]")

    for raw_line in lrc_text.strip().split("\n"):
        raw_line = raw_line.strip()
        if not raw_line:
            corrected_lines.append(raw_line)
            continue

        def adjust_tag(m):
            mins = int(m.group("min"))
            secs = float(m.group("sec"))
            ts = max(0.0, mins * 60 + secs + offset)
            new_mins = int(ts // 60)
            new_secs = ts % 60
            return f"[{new_mins:02d}:{new_secs:05.2f}]"

        corrected = lrc_tag_re.sub(adjust_tag, raw_line)
        corrected_lines.append(corrected)

    return "\n".join(corrected_lines)


# ── LRC Quality Check ────────────────────────────────────────────────


def lrc_quality_check(
    lines_raw: list[tuple[float, str]],
    duration: float,
    vocal_onset: Optional[float],
) -> tuple[str, Optional[float]]:
    """Validate LRC lyrics against video timing.

    Returns (verdict, correction_offset) where verdict is one of:
    - 'ok': Lyrics are good as-is
    - 'correct': Lyrics need timestamp shifting by correction_offset
    - 'fail': Lyrics are for the wrong version or unusable — escalate to Whisper
    """
    if not lines_raw:
        return ('fail', None)

    first_ts = lines_raw[0][0]
    first_text = lines_raw[0][1]
    last_ts = lines_raw[-1][0]
    line_count = len(lines_raw)

    # ── Strip decorative chars from first/last lines for validation ──
    # Songs indexed on LRCLIB sometimes have emoji/decoration marks
    def strip_decorative(text: str) -> str:
        return text.strip('♪🎵🎶"\' \t\n\r♩\u266A\u266B\u266C')

    clean_first = strip_decorative(first_text)
    is_empty_first = not clean_first

    # Remove empty-first or decorative-only lines from count
    meaningful_lines = [l for l in lines_raw if strip_decorative(l[1])]
    meaningful_count = len(meaningful_lines)
    log("quality", f"LRC: {line_count} total lines, {meaningful_count} meaningful (first: [{first_ts:.1f}s] '{first_text[:40]}')")

    # ── Density check ──
    line_density = duration / max(meaningful_count, 1)
    if line_density > 12.0:
        log("quality", f"FAIL: Only {meaningful_count} meaningful lines over {duration:.0f}s (density {line_density:.1f}s/line)")
        return ('fail', None)

    # ── Bad start: first meaningful line well past 30% of duration ──
    # Also detect "intro skip": spoken intros before a long silence (e.g.
    # music videos with dialogue before the song starts). If there's a >50s
    # gap between consecutive meaningful lines, skip the lines before the gap.
    meaningful_first = meaningful_lines[0][0] if meaningful_lines else first_ts
    for i in range(1, len(meaningful_lines)):
        gap = meaningful_lines[i][0] - meaningful_lines[i-1][0]
        if gap > 50.0:
            log("quality", f"Detected intro skip: {gap:.0f}s gap between line {i} ({meaningful_lines[i-1][0]:.1f}s) and line {i+1} ({meaningful_lines[i][0]:.1f}s)")
            meaningful_first = meaningful_lines[i][0]
            # Recompute meaningful count from post-gap lines only
            post_gap_lines = meaningful_lines[i:]
            meaningful_count = len(post_gap_lines)
            line_density = duration / max(meaningful_count, 1)
            log("quality", f"After skipping intro: {meaningful_count} meaningful lines, first at {meaningful_first:.1f}s")
            break

    if meaningful_first > duration * 0.3:
        log("quality", f"FAIL: First meaningful line at {meaningful_first:.1f}s (>30% of {duration:.0f}s)")
        return ('fail', None)

    # ── Last line / past-EOF checks (catalog often targets a different cut) ──
    time_remaining = duration - last_ts
    if time_remaining > duration * 0.5:
        log("quality", f"FAIL: Last line at {last_ts:.1f}s, {time_remaining:.0f}s remaining (>50%)")
        return ('fail', None)
    if last_ts >= duration:
        log("quality", f"FAIL: Last line at {last_ts:.1f}s is past duration {duration:.1f}s")
        return ('fail', None)
    past_cues = sum(1 for ts, _ in lines_raw if ts >= duration - 0.25)
    if past_cues >= 1:
        log("quality", f"FAIL: {past_cues} cue(s) at/past duration {duration:.1f}s")
        return ('fail', None)

    # ── Giant first-line smear (huge inter-tag gap → proportional word fill) ──
    if len(meaningful_lines) >= 2:
        first_span = meaningful_lines[1][0] - meaningful_lines[0][0]
        if first_span > 25.0:
            log("quality", f"FAIL: First-line gap {first_span:.1f}s > 25s (catalog timing mismatch)")
            return ('fail', None)

    # ── Vocal onset correction ──
    if vocal_onset is None:
        log("quality", "No vocal onset data available — accepting lyrics as-is")
        return ('ok', None)

    # Strip empty/decorative lines at the beginning for offset computation
    effective_first = meaningful_lines[0][0] if meaningful_lines else first_ts
    offset = vocal_onset - effective_first

    log("quality", f"Vocal onset: {vocal_onset:.1f}s, effective first LRC: {effective_first:.1f}s, offset: {offset:+.1f}s")

    # If LRC and vocal onset are roughly aligned, all good
    if abs(offset) < 0.3:
        return ('ok', None)

    # Spoken-intro detection: if vocal onset is very early (< 3s, suggesting
    # spoken audio/dialogue) but the LRC lyrics start significantly later
    # (offset < -5s, i.e. LRC is 5s+ past the spoken onset), the onset is
    # from spoken intro, not singing. Don't apply the correction.
    SPOKEN_INTRO_THRESHOLD = 3.0
    if vocal_onset < SPOKEN_INTRO_THRESHOLD and offset < -5.0:
        log("quality", f"Spoken intro detected: onset={vocal_onset:.1f}s, first lyric={effective_first:.1f}s, not shifting")
        # Re-check: does the first LRC line fall past 30% of duration?
        # If so, the LRC might be entirely wrong; escalate to Whisper
        if effective_first > duration * 0.3:
            log("quality", f"FAIL: First meaningful line at {effective_first:.1f}s (>30% of {duration:.0f}s) after spoken intro skip")
            return ('fail', None)
        return ('ok', None)

    # Small offset (< 20s): correct (was a dead indented return — now live)
    if abs(offset) < 20.0:
        return ('correct', round(offset, 2))

    # Large offset (>20s) but line density is reasonable: still correct
    if line_density < 8.0:
        return ('correct', round(offset, 2))

    # Everything else: fail
    log("quality", f"FAIL: offset {offset:+.1f}s too large with density {line_density:.1f}s/line")
    return ('fail', None)


def step_download(video_id: str, out_dir: str) -> str:
    """Download the YouTube video with yt-dlp. Returns path to mp4.

    Subtitles are best-effort only — a 429 on one language must not fail
    the whole download (that was aborting Re-Lyric rebuilds).
    """
    log("download", f"Downloading video {video_id} ...")
    mp4_candidate = os.path.join(out_dir, f"{video_id}.mp4")
    info_candidate = os.path.join(out_dir, f"{video_id}.info.json")
    if os.path.exists(mp4_candidate) and os.path.getsize(mp4_candidate) > 10000:
        ok, detail = verify_downloaded_video(mp4_candidate, info_candidate)
        if ok:
            log("download", f"MP4 already exists and verified ({detail}), skipping download")
            return mp4_candidate
        log("download", f"Existing MP4 failed integrity check ({detail}) — re-downloading")
        quarantine_bad_download(mp4_candidate, detail)

    url = f"https://www.youtube.com/watch?v={video_id}"
    out_tmpl = os.path.join(out_dir, "%(id)s.%(ext)s")

    # Prefer H.264 ≤1080p (AV1 "best" often truncates). mweb first avoids SABR-only web formats.
    ytdlp_format = (
        "bv*[vcodec^=avc1][height<=1080]+ba/"
        "bv*[vcodec*=avc1][height<=1080]+ba/"
        "b[ext=mp4][vcodec*=avc1][height<=1080]/"
        "b[height<=720]/b[height<=1080]/b"
    )
    base_cmd = [
        _YTDLP_BIN,
        *ytdlp_ffmpeg_args(),
        "-f", ytdlp_format,
        "--merge-output-format", "mp4",
        "--write-info-json",
        "--write-thumbnail",
        "-o", out_tmpl,
        "--no-playlist",
        "--socket-timeout", "30",
        "--retries", "5",
        "--fragment-retries", "5",
    ]
    # ios helps when SABR blocks mweb/tv adaptive HTTPS (yt-dlp#12482).
    # Cookies skip ios, so on 403 retry once without cookies + ios-only.
    cmd = [
        *base_cmd,
        "--extractor-args", "youtube:player_client=mweb,ios,tv,web",
        *ytdlp_auth_args(),
        url,
    ]
    result = run(cmd, timeout=300, check=False)
    if result.returncode != 0:
        err = (result.stderr or "") + (result.stdout or "")
        log("download", f"Primary yt-dlp failed (exit {result.returncode}); retrying without cookies via ios")
        for remnant in Path(out_dir).glob(f"{video_id}*"):
            if remnant.suffix in (".mp4", ".webm", ".m4a", ".part") or ".f" in remnant.name:
                try:
                    remnant.unlink()
                except OSError:
                    pass
        cmd_ios = [
            *base_cmd,
            "--extractor-args", "youtube:player_client=ios",
            url,
        ]
        run(cmd_ios, timeout=300)

    # Find the downloaded mp4 (yt-dlp might add format suffix)
    expected = Path(out_dir) / f"{video_id}.mp4"
    found = None
    for f in Path(out_dir).glob(f"{video_id}*.mp4"):
        if ".bad-" in f.name:
            continue
        if os.path.getsize(f) > 10000:
            if f != expected:
                f.rename(expected)
            found = expected
            break
    if not found:
        fatal(f"No MP4 found after download in {out_dir}")

    ok, detail = verify_downloaded_video(str(found), info_candidate)
    if not ok:
        quarantine_bad_download(str(found), detail)
        fatal(f"Download incomplete/corrupt for {video_id}: {detail}")
    log("download", f"Downloaded and verified: {found} ({detail})")

    # 2) Best-effort captions (never fail the pipeline).
    # Prefer the Whisper/UI language (e.g. th.*) so Thai MVs don't land English-only
    # auto-captions as the sung track; still pull en.* for secondary translation.
    try:
        lang = (_WHISPER_LANG or "").strip().lower()
        if lang and lang != "en":
            sub_langs = f"{lang}.*,{lang},en.*,en"
            log("download", f"Fetching {lang}+en subtitles (best-effort) ...")
        else:
            sub_langs = "en.*,en"
            log("download", "Fetching English subtitles (best-effort) ...")
        run([
            _YTDLP_BIN,
            "--skip-download",
            "--write-subs", "--write-auto-subs",
            "--sub-langs", sub_langs,
            "--convert-subs", "lrc",
            "-o", out_tmpl,
            "--no-playlist",
            *ytdlp_auth_args(),
            url,
        ], timeout=120, check=False)
    except Exception as e:
        log("download", f"Subtitle fetch skipped: {e}")

    return str(found)


def step_stem_separation(video_id: str, mp4_path: str, tmp_dir: str) -> tuple[str, Optional[str]]:
    """Run Demucs stem separation. Returns (instrumental_path, vocals_path).

    vocals_path is the extracted vocal stem — used for onset detection
    and as a clean source for Whisper fallback transcription.
    """
    log("demucs", "Running Demucs stem separation (this may take 2-5 minutes) ...")

    demucs_out = Path(tmp_dir) / "demucs"
    demucs_out.mkdir(parents=True, exist_ok=True)

    instrumental_path = os.path.join(tmp_dir, f"{video_id}-instrumental.wav")
    vocals_path = os.path.join(tmp_dir, f"{video_id}-vocals.wav")

    # Only skip Demucs when BOTH stems already exist — otherwise we'd drop
    # vocals and break live vocal-mix for custom tracks.
    if (
        os.path.exists(instrumental_path) and os.path.getsize(instrumental_path) > 100000
        and os.path.exists(vocals_path) and os.path.getsize(vocals_path) > 10000
    ):
        log("demucs", "Instrumental + vocals already exist, skipping separation")
        return (instrumental_path, vocals_path)
    if os.path.exists(instrumental_path) and not (
        os.path.exists(vocals_path) and os.path.getsize(vocals_path) > 10000
    ):
        log("demucs", "Instrumental exists but vocals missing — re-running Demucs")
        try:
            os.unlink(instrumental_path)
        except OSError:
            pass

    # Demucs can't handle MP4 directly — extract audio to WAV first
    audio_wav = os.path.join(tmp_dir, f"{video_id}.wav")
    if not os.path.exists(audio_wav) or os.path.getsize(audio_wav) < 100000:
        log("demucs", "Extracting audio to WAV for demucs...")
        run([
            _FFMPEG_BIN, "-y", "-i", mp4_path,
            "-vn",               # no video
            "-acodec", "pcm_s16le",  # 16-bit PCM WAV
            "-ar", "44100",      # 44.1kHz
            "-ac", "2",          # stereo
            audio_wav,
        ], timeout=120)
        log("demucs", f"Audio extracted: {audio_wav}")

    # Run demucs on the WAV file — optimized for speed, GPU-safe.
    # Do not set PYTORCH_MPS_*_WATERMARK_RATIO below the defaults:
    # recent PyTorch rejects high=0.7 (default low 1.4 > high → crash).
    # 0.0 = no upper limit (recommended for Demucs on Apple Silicon).
    env = os.environ.copy()
    env["PYTORCH_MPS_HIGH_WATERMARK_RATIO"] = "0.0"
    env.pop("PYTORCH_MPS_LOW_WATERMARK_RATIO", None)
    cmd_demucs = [
        sys.executable, "-m", "demucs",
        "--two-stems", "vocals",
        "-n", "htdemucs_ft",
        "--jobs", "2",
        "-o", str(demucs_out),
        "--filename", "{stem}.{ext}",
        audio_wav,
    ]
    log("demucs", "Using htdemucs_ft model, 2 jobs (MPS unlimited)")
    run(cmd_demucs, timeout=600, env=env)

    # Model output goes to htdemucs_ft/ not htdemucs/
    search_dir = demucs_out / "htdemucs_ft"
    for candidate in search_dir.glob(f"**/no_vocals.*"):
        shutil.move(str(candidate), instrumental_path)
        break
    else:
        for candidate in demucs_out.rglob("no_vocals.*"):
            shutil.move(str(candidate), instrumental_path)
            break
        else:
            fatal("Demucs completed but no instrumental output found")

    # Also save the vocal stem for onset detection and Whisper fallback
    for candidate in search_dir.glob(f"**/vocals.*"):
        shutil.move(str(candidate), vocals_path)
        log("demucs", f"Vocal stem saved: {vocals_path}")
        break
    else:
        for candidate in demucs_out.rglob("vocals.*"):
            shutil.move(str(candidate), vocals_path)
            log("demucs", f"Vocal stem saved: {vocals_path}")
            break
        else:
            log("demucs", "Warning: no vocal stem found — onset detection unavailable")
            vocals_path = None

    # Clean up demucs output directory
    shutil.rmtree(demucs_out, ignore_errors=True)

    log("demucs", f"Instrumental audio saved: {instrumental_path}")
    return (instrumental_path, vocals_path)


def _lrclib_get_json(url: str, log_prefix: str = "lyrics") -> Optional[dict | list]:
    """GET JSON from LRCLIB; return None on failure."""
    try:
        resp = requests.get(url, timeout=15, headers=LRCLIB_UA)
        if resp.status_code == 200:
            return resp.json()
        if resp.status_code == 404:
            return None
        log(log_prefix, f"LRCLIB HTTP {resp.status_code} for {url.split('?', 1)[0]}")
    except (requests.RequestException, json.JSONDecodeError) as e:
        log(log_prefix, f"LRCLIB request failed: {e}")
    return None


def _fetch_lrclib_by_id(lrclib_id: int | str, log_prefix: str = "lyrics") -> tuple[str, bool, Optional[int]]:
    """Fetch a specific LRCLIB record by id. Returns (lrc_text, is_synced, id)."""
    data = _lrclib_get_json(f"{LRCLIB_API}/{lrclib_id}", log_prefix)
    if not isinstance(data, dict):
        return "", False, None
    rid = data.get("id")
    try:
        rid_int = int(rid) if rid is not None else int(lrclib_id)
    except (TypeError, ValueError):
        rid_int = None
    if data.get("syncedLyrics"):
        log(log_prefix, f"Got synced LRC from LRCLIB id={rid_int}")
        return data["syncedLyrics"], True, rid_int
    if data.get("plainLyrics"):
        log(log_prefix, f"Got plain lyrics from LRCLIB id={rid_int} (no synced)")
        return data["plainLyrics"], False, rid_int
    return "", False, rid_int


def _try_lrclib(params: dict, log_prefix: str = "lyrics") -> tuple[str, bool, Optional[int]]:
    """Make one LRCLIB /api/get request. Returns (lrc_text, is_synced, id)."""
    qs = "&".join(f"{k}={quote(str(v))}" for k, v in params.items())
    url = f"{LRCLIB_API}?{qs}"
    data = _lrclib_get_json(url, log_prefix)
    if not isinstance(data, dict):
        return "", False, None
    rid = data.get("id")
    try:
        rid_int = int(rid) if rid is not None else None
    except (TypeError, ValueError):
        rid_int = None
    if data.get("syncedLyrics"):
        log(log_prefix, f"Got synced (LRC) lyrics from LRCLIB id={rid_int}")
        return data["syncedLyrics"], True, rid_int
    if data.get("plainLyrics"):
        log(log_prefix, f"Got plain (unsynced) lyrics from LRCLIB id={rid_int}")
        return data["plainLyrics"], False, rid_int
    return "", False, rid_int


def _strip_accents(s: str) -> str:
    import unicodedata
    nk = unicodedata.normalize("NFKD", s)
    return "".join(c for c in nk if not unicodedata.combining(c))


def _artist_name_variants(artist: str) -> list[str]:
    """Generate artist name variants for LRCLIB lookup (accent / Last, First)."""
    if not artist:
        return []
    variants = [artist]
    ascii_a = _strip_accents(artist)
    if ascii_a != artist:
        variants.append(ascii_a)
    # "Janelle Monáe" ↔ "Monáe, Janelle"
    parts = artist.replace(",", " ").split()
    if len(parts) == 2:
        swapped = f"{parts[1]}, {parts[0]}"
        variants.append(swapped)
        variants.append(_strip_accents(swapped))
        variants.append(f"{parts[1]} {parts[0]}")
    # Dedupe preserving order
    seen: set[str] = set()
    out: list[str] = []
    for v in variants:
        key = v.strip().lower()
        if key and key not in seen:
            seen.add(key)
            out.append(v.strip())
    return out


def _title_tokens(title: str) -> set[str]:
    stop = {"the", "a", "an", "and", "or", "of", "official", "video", "lyric", "lyrics",
            "explicit", "remastered", "hd", "4k"}
    toks = re.findall(r"[a-z0-9]+", (title or "").lower())
    return {t for t in toks if t not in stop and len(t) > 1}


def _score_lrclib_hit(row: dict, duration: float, title: str, artist: str) -> float:
    """Higher is better. Synced + duration match dominate."""
    if not isinstance(row, dict):
        return -1e9
    synced = bool(row.get("syncedLyrics"))
    # Search results may omit lyric bodies; instrumental=false + hasSyncedLyrics flag
    if not synced and row.get("syncedLyrics") is None:
        # /api/search often returns hasSyncedLyrics without the body
        synced = bool(row.get("hasSyncedLyrics") or row.get("syncedLyrics"))
    # Prefer explicit hasSyncedLyrics when present
    if "hasSyncedLyrics" in row:
        synced = bool(row.get("hasSyncedLyrics"))

    score = 1000.0 if synced else 0.0
    row_dur = float(row.get("duration") or 0)
    if duration > 0 and row_dur > 0:
        score -= abs(row_dur - duration) * 2.0  # prefer closer duration
    else:
        score -= 50.0

    want_title = _title_tokens(title)
    got_title = _title_tokens(row.get("trackName") or row.get("name") or "")
    if want_title:
        overlap = len(want_title & got_title) / max(1, len(want_title))
        if overlap < 0.4:
            return -1e9  # wrong track
        score += overlap * 40.0

    if artist:
        want_a = _strip_accents(artist).lower()
        got_a = _strip_accents(row.get("artistName") or "").lower()
        if want_a and got_a:
            # Token overlap for "Janelle Monáe" vs "Monae, Janelle"
            wa = set(re.findall(r"[a-z0-9]+", want_a))
            ga = set(re.findall(r"[a-z0-9]+", got_a))
            if wa and ga:
                score += 20.0 * (len(wa & ga) / max(len(wa), len(ga)))
    return score


def _search_lrclib(
    artist: Optional[str],
    title: Optional[str],
    duration: float,
    log_prefix: str = "lyrics",
) -> list[dict]:
    """Query /api/search with several strategies; return raw hit list (deduped by id)."""
    queries: list[dict] = []
    if artist and title:
        queries.append({"artist_name": artist, "track_name": title})
        queries.append({"q": f"{artist} {title}"})
        for av in _artist_name_variants(artist):
            if av != artist:
                queries.append({"artist_name": av, "track_name": title})
                queries.append({"q": f"{av} {title}"})
    if title:
        queries.append({"track_name": title})
        queries.append({"q": title})
        if artist:
            queries.append({"q": f"{title} {artist}"})

    hits: list[dict] = []
    seen_ids: set[int] = set()
    for params in queries:
        qs = "&".join(f"{k}={quote(str(v))}" for k, v in params.items())
        data = _lrclib_get_json(f"{LRCLIB_SEARCH_API}?{qs}", log_prefix)
        if not isinstance(data, list):
            continue
        for row in data:
            if not isinstance(row, dict):
                continue
            rid = row.get("id")
            try:
                rid_int = int(rid)
            except (TypeError, ValueError):
                continue
            if rid_int in seen_ids:
                continue
            seen_ids.add(rid_int)
            hits.append(row)
    return hits


def _pick_best_lrclib(
    hits: list[dict],
    duration: float,
    title: str,
    artist: str,
    prefer_synced: bool = True,
) -> Optional[dict]:
    """Pick best search hit; prefer synced when prefer_synced is True."""
    scored: list[tuple[float, dict]] = []
    for row in hits:
        s = _score_lrclib_hit(row, duration, title or "", artist or "")
        if s <= -1e8:
            continue
        if prefer_synced:
            has_sync = bool(row.get("hasSyncedLyrics") or row.get("syncedLyrics"))
            if not has_sync:
                # Still keep as fallback but heavily penalized already
                pass
        scored.append((s, row))
    if not scored:
        return None
    scored.sort(key=lambda x: x[0], reverse=True)
    return scored[0][1]


def step_fetch_lyrics(
    video_id: str,
    duration: float,
    artist_override: Optional[str] = None,
    title_override: Optional[str] = None,
    preferred_lrclib_id: Optional[int] = None,
) -> tuple[str, bool, Optional[int]]:
    """Fetch lyrics from LRCLIB, preferring synced entries.

    Strategy:
      0. Fetch by preferred_lrclib_id if known (sticky re-fetch)
      1. /api/get with artist+title variants + duration offsets (synced only accepted early)
      2. /api/search — rank synced + duration closeness, then /api/get/{id}
      3. Accept plain /api/get only if no synced hit exists
      4. Scrape plain text fallbacks

    Returns (lrc_text, is_synced, lrclib_id).
    """
    log("lyrics", "Fetching lyrics from LRCLIB (synced-prefer search) ...")

    artist: Optional[str] = artist_override or None
    title: Optional[str] = title_override or None

    # Resolve artist/title from info.json if not provided
    if not artist or not title:
        info_path = Path(LIBRARY_KARAOKE_DIR) / f"{video_id}.info.json"
        if not info_path.exists():
            info_path = Path(LIBRARY_KARAOKE_DIR) / f"{video_id}-karaoke.info.json"
        if not info_path.exists():
            info_path = None
            for d in [TEMP_BASE / video_id, Path(".karol/youtube-downloads")]:
                candidate = d / f"{video_id}.info.json"
                if candidate.exists():
                    info_path = candidate
                    break
        if info_path and info_path.exists():
            try:
                info = json.loads(info_path.read_text())
                if not artist and info.get("uploader"):
                    artist = info["uploader"]
                if not title and info.get("title"):
                    t = info["title"]
                    t = re.sub(
                        r"\s*\(?(?:official\s*(?:music\s*)?video|lyric\s*video|hd|4k|1080p)\)?\s*$",
                        "",
                        t,
                        flags=re.IGNORECASE,
                    )
                    t = t.strip()
                    if artist and t.lower().startswith(artist.lower() + " - "):
                        t = t[len(artist) + 3:].strip()
                    # Also strip "Artist - " when title embeds artist
                    m = re.match(r"^(.+?)\s*[-–—]\s*(.+)$", t)
                    if m and not title:
                        maybe_artist, maybe_title = m.group(1).strip(), m.group(2).strip()
                        if artist and _strip_accents(maybe_artist).lower() == _strip_accents(artist).lower():
                            t = maybe_title
                        elif not artist:
                            artist = maybe_artist
                            t = maybe_title
                    title = t
            except (json.JSONDecodeError, KeyError):
                pass

    # Check tags.json for saved metadata / lrclibId
    saved_id: Optional[int] = preferred_lrclib_id
    if TAGS_PATH.exists():
        try:
            tags = json.loads(TAGS_PATH.read_text())
            for key in (video_id, f"{video_id}-karaoke"):
                entry = tags.get(key) or {}
                if not artist:
                    artist = entry.get("artist") or None
                if not title:
                    title = entry.get("title") or None
                if saved_id is None and entry.get("lrclibId"):
                    try:
                        saved_id = int(entry["lrclibId"])
                    except (TypeError, ValueError):
                        pass
        except (json.JSONDecodeError, KeyError, OSError):
            pass

    # Also read lrclibId from existing library LRC
    if saved_id is None:
        dest_lrc = LIBRARY_KARAOKE_DIR / f"{video_id}-karaoke.lrc.json"
        if dest_lrc.exists():
            try:
                existing = json.loads(dest_lrc.read_text(encoding="utf-8"))
                if existing.get("lrclibId"):
                    saved_id = int(existing["lrclibId"])
            except (json.JSONDecodeError, OSError, TypeError, ValueError):
                pass

    # ── 0. Sticky re-fetch by known id ──
    if saved_id is not None:
        lrc, synced, rid = _fetch_lrclib_by_id(saved_id)
        if synced and lrc:
            log("lyrics", f"Re-fetched synced LRCLIB by saved id={saved_id}")
            return lrc, True, rid
        if lrc and not synced:
            log("lyrics", f"Saved id={saved_id} is plain-only — continuing search for synced")

    duration_offsets = [0, -3, 3, -5, 5, -10, 10]
    plain_fallback: tuple[str, Optional[int]] = ("", None)

    def try_get_synced(base_params: dict) -> tuple[str, bool, Optional[int]]:
        nonlocal plain_fallback
        # Try with duration offsets first, then without duration
        attempts = [{**base_params, "duration": str(int(duration + doff))} for doff in duration_offsets]
        attempts.append(dict(base_params))
        for params in attempts:
            lrc, synced, rid = _try_lrclib(params)
            if synced and lrc:
                return lrc, True, rid
            if lrc and not synced and not plain_fallback[0]:
                plain_fallback = (lrc, rid)
        return "", False, None

    # ── 1. /api/get with artist variants (accept synced only) ──
    if artist and title:
        for av in _artist_name_variants(artist):
            lrc, synced, rid = try_get_synced({"artist_name": av, "track_name": title})
            if synced and lrc:
                log("lyrics", f"Found synced via /api/get artist={av!r} id={rid}")
                return lrc, True, rid

    # ── 2. /api/search — prefer synced + closest duration ──
    hits = _search_lrclib(artist, title, duration)
    if hits:
        log("lyrics", f"LRCLIB search returned {len(hits)} unique hit(s)")
        best = _pick_best_lrclib(hits, duration, title or "", artist or "")
        if best and best.get("id") is not None:
            has_sync = bool(best.get("hasSyncedLyrics") or best.get("syncedLyrics"))
            lrc, synced, rid = _fetch_lrclib_by_id(best["id"])
            if synced and lrc:
                log("lyrics",
                    f"Search winner: id={rid} artist={best.get('artistName')!r} "
                    f"track={best.get('trackName')!r} dur={best.get('duration')} synced=True")
                return lrc, True, rid
            if lrc and not synced:
                log("lyrics", f"Search top hit id={rid} has no synced body — trying other synced hits")
                if not plain_fallback[0]:
                    plain_fallback = (lrc, rid)
                # Try other synced-ranked hits
                scored = sorted(
                    ((_score_lrclib_hit(h, duration, title or "", artist or ""), h) for h in hits),
                    key=lambda x: x[0], reverse=True,
                )
                for sc, h in scored:
                    if sc <= -1e8:
                        continue
                    if not (h.get("hasSyncedLyrics") or h.get("syncedLyrics")):
                        continue
                    if h.get("id") == best.get("id"):
                        continue
                    lrc2, synced2, rid2 = _fetch_lrclib_by_id(h["id"])
                    if synced2 and lrc2:
                        log("lyrics", f"Search alternate synced id={rid2}")
                        return lrc2, True, rid2
            elif has_sync and not lrc:
                log("lyrics", f"Search hit id={best.get('id')} claimed synced but body empty")

    # ── 3. Plain LRCLIB only if no synced exists ──
    if plain_fallback[0]:
        log("lyrics", f"No synced LRCLIB found — using plain id={plain_fallback[1]}")
        return plain_fallback[0], False, plain_fallback[1]

    # Title-only /api/get as last LRCLIB attempt (plain ok)
    if title:
        for doff in duration_offsets:
            lrc, synced, rid = _try_lrclib({"track_name": title, "duration": str(int(duration + doff))})
            if lrc:
                return lrc, synced, rid
        lrc, synced, rid = _try_lrclib({"track_name": title})
        if lrc:
            return lrc, synced, rid

    log("lyrics", "No lyrics found on LRCLIB, will attempt to scrape from free sources ...")

    # Strategy: scrape plain lyrics from free sources
    if artist and title:
        plain = _scrape_plain_lyrics(artist, title)
        if plain:
            log("lyrics", f"Got plain lyrics from scraping ({len(plain)} chars), will align with Whisper timing")
            return plain, False, None

    log("lyrics", "No lyrics found on LRCLIB or scraping, will attempt to use embedded subtitles ...")
    return "", False, None


# ── Free lyric scraping fallbacks ────────────────────────────────────
# These sources are tried in order after LRCLIB fails. They return plain
# (unsynced) text which the downstream Whisper step can timestamp.
# All HTTP calls are wrapped in try/except — failures degrade silently.


def _scrape_plain_lyrics(artist: str, title: str) -> str:
    """Try free lyric sources in order, returning plain text lyrics or empty string.

    Sources tried:
      1. lyrics.ovh — free REST API, no auth
      2. AZLyrics — HTML scrape
      3. Genius — HTML scrape (aggressively blocked by bots)
    """
    _UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

    # ── 1. lyrics.ovh ──
    try:
        url = f"https://api.lyrics.ovh/v1/{quote(artist)}/{quote(title)}"
        resp = requests.get(url, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            lyrics = data.get("lyrics", "")
            if lyrics and len(lyrics.strip()) > 20:
                log("lyrics", "Got plain lyrics from lyrics.ovh")
                return lyrics.strip()
    except (requests.RequestException, json.JSONDecodeError):
        pass

    # ── 2. AZLyrics ──
    try:
        artist_slug = _slugify_azlyrics(artist)
        title_slug = _slugify_azlyrics(title)
        url = f"https://www.azlyrics.com/lyrics/{artist_slug}/{title_slug}.html"
        resp = requests.get(url, timeout=10, headers={"User-Agent": _UA})
        if resp.status_code == 200:
            lyrics = _parse_azlyrics(resp.text)
            if lyrics and len(lyrics.strip()) > 20:
                log("lyrics", "Got plain lyrics from AZLyrics")
                return lyrics.strip()
    except requests.RequestException:
        pass

    # ── 3. Genius ──
    try:
        artist_slug = _slugify_genius(artist)
        title_slug = _slugify_genius(title)
        url = f"https://genius.com/{artist_slug}-{title_slug}-lyrics"
        resp = requests.get(url, timeout=10, headers={"User-Agent": _UA})
        if resp.status_code == 200:
            lyrics = _parse_genius(resp.text)
            if lyrics and len(lyrics.strip()) > 20:
                log("lyrics", "Got plain lyrics from Genius")
                return lyrics.strip()
    except requests.RequestException:
        pass

    return ""


def _slugify_azlyrics(s: str) -> str:
    """Slug for AZLyrics: lowercase, remove non-word chars, collapse spaces to single space, strip spaces."""
    s = s.lower()
    s = re.sub(r"[^\w\s]", "", s)
    s = re.sub(r"\s+", " ", s)
    return s.replace(" ", "")


def _slugify_genius(s: str) -> str:
    """Slug for Genius: lowercase, remove non-word chars, collapse spaces to single space, replace spaces with hyphens."""
    s = s.lower()
    s = re.sub(r"[^\w\s]", "", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip().replace(" ", "-")


def _parse_azlyrics(html: str) -> str:
    """Extract lyrics from an AZLyrics page using regex."""
    # Lyrics are typically between a usage comment and the closing </div>
    m = re.search(
        r"<!--\s*Usage of azlyrics\.com content.*?-->(.*?)</div>",
        html, re.DOTALL | re.IGNORECASE,
    )
    if not m:
        return ""
    text = m.group(1)
    # Strip HTML tags
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = text.replace("&amp;", "&").replace("&quot;", '"').replace("&#039;", "'")
    return text.strip()


def _parse_genius(html: str) -> str:
    """Extract lyrics from a Genius page using regex."""
    parts: list[str] = []
    # Target containers with data-lyrics-container="true" (the actual lyric text).
    # Some containers wrap headers/ads rather than lyrics — skip those by
    # checking for known non-lyric class names.
    for m in re.finditer(
        r'data-lyrics-container="true"[^>]*>(.*?)</div>',
        html, re.DOTALL,
    ):
        raw = m.group(1)
        # Skip containers that wrap headers or ads, not lyrics
        if "LyricsHeader__Container" in raw or "sc-8dc7581f" in raw:
            continue
        text = raw
        # Strip HTML tags and decode entities
        text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
        text = re.sub(r"<[^>]+>", "", text)
        text = text.replace("&amp;", "&").replace("&quot;", '"').replace("&#039;", "'").replace("&#x27;", "'")
        text = text.strip()
        if text:
            parts.append(text)
    return "\n\n".join(parts)


def _looks_like_lrc_content(content: str) -> bool:
    """True when a subtitle file is standard [mm:ss.xx] LRC, not WebVTT."""
    if not content:
        return False
    head = content[:800].lstrip().upper()
    if head.startswith("WEBVTT") or "-->" in content[:2000]:
        return False
    return bool(re.search(r"\[\d{1,3}:\d{2}(?:\.\d{1,3})?\]\s*\S", content))


def _looks_like_garbage_lyrics(text: str) -> bool:
    """Detect WEBVTT/header junk that used to ship as 'lyrics' after bad parses."""
    if not text or len(text.strip()) < 8:
        return True
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        return True
    bad_markers = ("WEBVTT", "Kind: captions", "Language:", "-->")
    marker_hits = sum(1 for ln in lines if any(m in ln for m in bad_markers))
    ts_only = sum(
        1 for ln in lines
        if re.match(r"^\d{2}:\d{2}:\d{2}[.,]\d+", ln) or re.match(r"^\d{2}:\d{2}:\d{2}\s*-->", ln)
    )
    if marker_hits >= 1:
        return True
    if ts_only >= 3 and ts_only >= len(lines) * 0.25:
        return True
    return False


def _lrc_json_is_garbage(data: dict) -> bool:
    """True when an on-disk LRC JSON is unusable (VTT dump, empty, etc.)."""
    if not isinstance(data, dict):
        return True
    lines = data.get("lines") or []
    if not lines:
        return True
    plain_parts = []
    for line in lines:
        text = (line.get("text") or "").strip()
        if not text and line.get("words"):
            text = " ".join(w.get("text", "") for w in line["words"]).strip()
        if text:
            plain_parts.append(text)
    if _looks_like_garbage_lyrics("\n".join(plain_parts)):
        return True
    return _embedded_caption_timing_is_garbage(lines)


def _embedded_caption_timing_is_garbage(lines: list) -> bool:
    """Reject YouTube auto-caption rolling windows that survive text-only garbage checks.

    Typical failure mode: each phrase is emitted 2–3 times (full cue + 10ms micro-cue
    + pad), with heavy overlaps. Scoring treated these as 'synced' and locked out Whisper,
    so reprocess kept republishing unreadable karaoke (e.g. Dutch ASR on English rap).
    """
    if not lines or len(lines) < 4:
        return False
    texts = []
    micro = 0
    consec_dups = 0
    overlaps = 0
    for i, line in enumerate(lines):
        text = (line.get("text") or "").strip()
        if not text and line.get("words"):
            text = " ".join(w.get("text", "") for w in line["words"]).strip()
        texts.append(text)
        try:
            dur = float(line.get("endTime") or 0) - float(line.get("startTime") or 0)
        except (TypeError, ValueError):
            dur = 0.0
        if 0 < dur < 0.05:
            micro += 1
        if i > 0 and text and text == texts[i - 1]:
            consec_dups += 1
        if i > 0:
            try:
                prev_end = float(lines[i - 1].get("endTime") or 0)
                cur_start = float(line.get("startTime") or 0)
            except (TypeError, ValueError):
                continue
            if prev_end > cur_start + 0.05:
                overlaps += 1
    n = len(lines)
    uniq = len({t for t in texts if t})
    uniq_ratio = uniq / max(1, n)
    # Rolling auto-captions: lots of identical repeats + micro gaps / overlaps
    if consec_dups >= max(4, int(n * 0.35)) and uniq_ratio < 0.55:
        return True
    if micro >= max(3, int(n * 0.2)) and consec_dups >= max(3, int(n * 0.25)):
        return True
    if overlaps >= max(4, int(n * 0.25)) and uniq_ratio < 0.6:
        return True
    return False


def _dedupe_caption_cues(cues: list[tuple[float, str]]) -> list[tuple[float, str]]:
    """Merge consecutive identical LRC/VTT caption cues (YouTube rolling windows)."""
    deduped: list[tuple[float, str]] = []
    for start, text in cues:
        text = re.sub(r"\s+", " ", (text or "")).strip()
        if not text or text in ("[เพลง]", "[Music]", "[music]", "♪", "🎵"):
            continue
        if deduped and deduped[-1][1] == text:
            continue  # keep earliest start; end is derived from next distinct cue
        deduped.append((start, text))
    return deduped


def parse_vtt_to_lrc_json(vtt_path: str, video_id: str, duration: float) -> Optional[str]:
    """Parse a WebVTT subtitle file and convert it to an LRC JSON file.

    Extracts timestamped text segments and creates a standard Karol LRC JSON
    with word-level timing. If yt-dlp's --convert-subs lrc created a .lrc file,
    prefer that directly — this parser handles the fallback case.

    Returns the path to the generated LRC JSON file, or None on failure.
    """
    import re as vtt_re

    try:
        with open(vtt_path, encoding='utf-8') as f:
            content = f.read()
    except (OSError, UnicodeDecodeError) as e:
        log("lyrics", f"VTT read error: {e}")
        return None

    # yt-dlp sometimes names files .vtt after converting to LRC, or callers
    # historically passed .en.lrc into this function by mistake.
    if _looks_like_lrc_content(content):
        log("lyrics", f"File looks like LRC, not VTT — routing to LRC parser: {os.path.basename(vtt_path)}")
        return parse_lrc_file_to_lrc_json(vtt_path, video_id, duration)

    # VTT timestamp format: 00:00:05.000 --> 00:00:08.500
    # Also handles: 00:00:05.000 --> 00:00:08.500 position:10% align:left
    cue_re = vtt_re.compile(
        r'(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*'
        r'(\d{2}):(\d{2}):(\d{2})\.(\d{3})'
    )

    lines_data = []
    current_start = None
    current_end = None
    current_text = []

    for raw_line in content.split('\n'):
        line = raw_line.strip()

        # Skip WEBVTT header, NOTE blocks, style blocks, and empty lines
        if not line or line.startswith('WEBVTT') or line.startswith('Kind:') or line.startswith('Language:'):
            continue

        # VTT tag lines like <c> or <b> — skip, content is in subsequent lines
        if line.startswith('<') and line.endswith('>'):
            continue

        # Check for timestamp line
        m = cue_re.search(line)
        if m:
            # Flush previous cue
            if current_start is not None and current_text:
                text = ' '.join(current_text).strip()
                if text:
                    lines_data.append((current_start, current_end, text))

            # Parse new timestamps
            h1, m1, s1, ms1 = int(m[1]), int(m[2]), int(m[3]), int(m[4])
            h2, m2, s2, ms2 = int(m[5]), int(m[6]), int(m[7]), int(m[8])
            current_start = h1 * 3600 + m1 * 60 + s1 + ms1 / 1000.0
            current_end = h2 * 3600 + m2 * 60 + s2 + ms2 / 1000.0
            current_text = []
            continue

        # Skip VTT style/header lines
        if line.startswith('::') or line.startswith('STYLE') or line.startswith('Region:'):
            continue

        # Accumulate text lines for the current cue
        if current_start is not None:
            # Strip YouTube karaoke word tags: <00:00:01.234><c>word</c>
            cleaned = vtt_re.sub(r"<\d{2}:\d{2}:\d{2}\.\d{3}>", "", line)
            cleaned = vtt_re.sub(r"</?c[^>]*>", "", cleaned)
            cleaned = vtt_re.sub(r"<[^>]+>", "", cleaned)
            cleaned = cleaned.strip()
            if cleaned:
                current_text.append(cleaned)

    # Flush final cue
    if current_start is not None and current_text:
        text = ' '.join(current_text).strip()
        if text:
            lines_data.append((current_start, current_end, text))

    if not lines_data:
        log("lyrics", "VTT parsed but no cues found")
        return None

    log("lyrics", f"VTT parsed: {len(lines_data)} cues from {vtt_path}")

    # Deduplicate consecutive identical cues (YouTube auto-captions repeat rolling text)
    deduped = []
    for start, end, text in lines_data:
        text = re.sub(r"\s+", " ", text).strip()
        if not text or text in ("[เพลง]", "[Music]", "[music]", "♪", "🎵"):
            continue
        if deduped and deduped[-1][2] == text:
            # Extend previous cue end
            ps, _pe, pt = deduped[-1]
            deduped[-1] = (ps, max(end, _pe), pt)
            continue
        deduped.append((start, end, text))
    lines_data = deduped
    if not lines_data:
        log("lyrics", "VTT parsed but no usable cues after cleanup")
        return None

    # Convert to LRC JSON format with word-level timing
    lrc_lines = []
    for start, end, text in lines_data:
        words = text.split()
        word_count = len(words)
        if word_count == 0:
            continue

        word_duration = (end - start) / word_count
        word_entries = []
        for i, w in enumerate(words):
            w_start = start + i * word_duration
            # Last word ends at cue end; all others start the next word
            w_end = w_start + word_duration if i < word_count - 1 else end
            word_entries.append({
                "startTime": round(w_start, 2),
                "endTime": round(w_end, 2),
                "text": w,
            })

        lrc_lines.append({
            "startTime": round(start, 2),
            "endTime": round(end, 2),
            "text": text,
            "words": word_entries,
        })

    lrc_json = {
        "videoId": video_id,
        "duration": duration,
        "lines": lrc_lines,
        "source": "vtt-captions",
    }

    # Unique path per caption file — Stage 1 collects many langs; a shared
    # `{id}-karaoke.lrc.json` would let the last parse overwrite the winner's JSON.
    src_stem = Path(vtt_path).stem  # e.g. VIDEOID.th-th
    json_path = os.path.join(os.path.dirname(vtt_path), f"{src_stem}.lrc.json")
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(lrc_json, f, indent=2, ensure_ascii=False)

    log("lyrics", f"VTT → LRC JSON saved: {json_path}")
    return json_path


def parse_lrc_file_to_lrc_json(lrc_path: str, video_id: str, duration: float) -> Optional[str]:
    """Convert a standard `[mm:ss.xx]text` LRC subtitle file into LRC JSON."""
    try:
        raw = Path(lrc_path).read_text(encoding="utf-8", errors="ignore")
    except OSError as e:
        log("lyrics", f"Could not read LRC file: {e}")
        return None

    cue_re = re.compile(r"\[(\d+):(\d+(?:\.\d+)?)\](.*)$")
    cues: list[tuple[float, str]] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("[re:") or line.startswith("[ve:") or line.startswith("[ti:") or line.startswith("[ar:"):
            continue
        m = cue_re.match(line)
        if not m:
            continue
        mins, secs, text = int(m.group(1)), float(m.group(2)), (m.group(3) or "").strip()
        text = re.sub(r"\[.*?\]", "", text).strip()  # drop nested tags like [Music]
        if not text or text.lower() in ("music", "[music]", "♪"):
            continue
        start = mins * 60 + secs
        cues.append((start, text))

    if not cues:
        log("lyrics", f"LRC file had no usable cues: {lrc_path}")
        return None

    before = len(cues)
    cues = _dedupe_caption_cues(cues)
    if before != len(cues):
        log("lyrics", f"LRC dedupe: {before} → {len(cues)} cues (dropped rolling repeats)")
    if not cues:
        log("lyrics", f"LRC file had no usable cues after dedupe: {lrc_path}")
        return None

    lrc_lines = []
    for i, (start, text) in enumerate(cues):
        end = cues[i + 1][0] if i + 1 < len(cues) else min(duration, start + 3.0)
        if end <= start:
            end = start + 1.5
        words = text.split()
        word_entries = []
        if words:
            wd = (end - start) / len(words)
            for wi, w in enumerate(words):
                w_start = start + wi * wd
                w_end = w_start + wd if wi < len(words) - 1 else end
                word_entries.append({
                    "startTime": round(w_start, 2),
                    "endTime": round(w_end, 2),
                    "text": w,
                })
        lrc_lines.append({
            "startTime": round(start, 2),
            "endTime": round(end, 2),
            "text": text,
            "words": word_entries,
        })

    # Unique path per caption file (see parse_vtt_to_lrc_json)
    src_stem = Path(lrc_path).stem
    json_path = os.path.join(os.path.dirname(lrc_path), f"{src_stem}.lrc.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({
            "videoId": video_id,
            "duration": duration,
            "lines": lrc_lines,
            "source": "lrc-captions",
            "alignMode": "embedded_subs",
        }, f, indent=2, ensure_ascii=False)
    log("lyrics", f"LRC → JSON: {len(lrc_lines)} cues from {os.path.basename(lrc_path)}")
    return json_path


def captions_file_to_lrc_json(cap_path: str, video_id: str, duration: float) -> Optional[str]:
    """Route .vtt / .lrc / .json caption files to the right converter."""
    lower = cap_path.lower()
    if lower.endswith(".json"):
        return cap_path if os.path.exists(cap_path) else None
    if lower.endswith(".lrc"):
        return parse_lrc_file_to_lrc_json(cap_path, video_id, duration)
    if lower.endswith(".vtt"):
        return parse_vtt_to_lrc_json(cap_path, video_id, duration)
    # Unknown — try LRC then VTT
    return (
        parse_lrc_file_to_lrc_json(cap_path, video_id, duration)
        or parse_vtt_to_lrc_json(cap_path, video_id, duration)
    )


def step_find_karaoke(
    artist: str,
    title: str,
    duration: float,
    original_video_id: str,
) -> list[dict]:
    """Search YouTube for karaoke versions of the same song.

    Uses yt-dlp's built-in search. Filters by duration match (±30s).
    Returns a ranked list of {video_id, title, duration, channel, score} dicts.
    """
    search_query = f'ytsearch5:"{artist} {title} karaoke"'
    log("karaoke-search", f"Searching YouTube: {search_query}")

    try:
        result = subprocess.run(
            [_YTDLP_BIN, "--flat-playlist", "--dump-json", "--no-playlist", *ytdlp_auth_args(), search_query],
            capture_output=True, text=True, timeout=30,
        )
    except subprocess.TimeoutExpired:
        log("karaoke-search", "Search timed out")
        return []
    except Exception as e:
        log("karaoke-search", f"Search error: {e}")
        return []

    candidates = []
    for line in result.stdout.strip().split('\n'):
        if not line.strip():
            continue
        try:
            info = json.loads(line)
        except json.JSONDecodeError:
            continue

        vid = info.get('id', '')
        vid_title = info.get('title', '')
        vid_duration = info.get('duration')  # None for --flat-playlist

        # Skip the original video itself
        if vid == original_video_id:
            continue

        # Duration check: if available, must be within 30s
        if vid_duration and abs(vid_duration - duration) > 30:
            continue

        # Score: prefer titles containing "karaoke" or "instrumental"
        title_lower = vid_title.lower()
        score = 0
        if 'karaoke' in title_lower:
            score += 10
        if 'instrumental' in title_lower:
            score += 5
        if artist and artist.lower() in title_lower:
            score += 3

        # Require meaningful overlap with the song title (not just artist).
        # Prevents "Lipstick Lover karaoke" winning for "Water Slide".
        stop = {
            "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "at",
            "official", "music", "video", "lyrics", "audio", "hd", "4k", "mv",
            "karaoke", "instrumental", "with", "feat", "ft", "vs",
        }
        artist_tokens = set(re.findall(r"[a-z0-9]+", (artist or "").lower()))
        song_tokens = set(re.findall(r"[a-z0-9]+", (title or "").lower())) - stop - artist_tokens
        cand_tokens = set(re.findall(r"[a-z0-9]+", title_lower)) - stop
        overlap = song_tokens & cand_tokens if song_tokens else set()
        if song_tokens:
            if not overlap:
                continue  # different song — skip
            score += 5 * len(overlap)
        elif title and title.lower() in title_lower:
            score += 3

        candidates.append({
            "video_id": vid,
            "title": vid_title,
            "duration": vid_duration,
            "channel": info.get('channel', ''),
            "score": score,
        })

    # Sort by score descending, then by closest duration
    candidates.sort(key=lambda c: (-c['score'], abs((c['duration'] or duration) - duration)))

    log("karaoke-search", f"Found {len(candidates)} candidates")
    return candidates[:3]  # Top 3


def step_extract_karaoke_data(
    karaoke_video_id: str,
    tmp_dir: str,
) -> dict:
    """Download audio and captions from a karaoke video.

    Skips video download entirely — only downloads audio and subtitles.
    Returns {audio_path, caption_json_path, has_captions}.
    """
    audio_path = os.path.join(tmp_dir, f"{karaoke_video_id}-karaoke-audio.wav")
    caption_dir = os.path.join(tmp_dir, f"{karaoke_video_id}-captions")
    os.makedirs(caption_dir, exist_ok=True)

    log("karaoke-extract", f"Extracting data from karaoke video: {karaoke_video_id}")

    # Download audio only
    if not os.path.exists(audio_path):
        run([
            _YTDLP_BIN,
            "-f", "ba",
            "-x", "--audio-format", "wav",
            "-o", audio_path,
            "--no-playlist",
            *ytdlp_auth_args(),
            f"https://www.youtube.com/watch?v={karaoke_video_id}",
        ], timeout=180)
        log("karaoke-extract", f"Downloaded karaoke audio: {audio_path}")

    # Download English subtitles only (best-effort — all-lang hits YouTube 429)
    has_captions = False
    caption_json_path = None
    try:
        run([
            _YTDLP_BIN,
            "--skip-download",
            "--write-subs", "--write-auto-subs",
            "--sub-langs", "en.*,en",
            "--convert-subs", "lrc",
            "-o", os.path.join(caption_dir, "%(id)s.%(ext)s"),
            "--no-playlist",
            *ytdlp_auth_args(),
            f"https://www.youtube.com/watch?v={karaoke_video_id}",
        ], timeout=60, check=False)

        # Check for converted LRC file
        lrc_path = os.path.join(caption_dir, f"{karaoke_video_id}.en.lrc")
        vtt_path = os.path.join(caption_dir, f"{karaoke_video_id}.en.vtt")

        if os.path.exists(lrc_path):
            log("karaoke-extract", f"Found LRC captions: {lrc_path}")
            has_captions = True
            caption_json_path = lrc_path
        elif os.path.exists(vtt_path):
            log("karaoke-extract", f"Found VTT captions: {vtt_path}")
            has_captions = True
            caption_json_path = vtt_path
        else:
            log("karaoke-extract", "No captions found on karaoke video")
    except Exception as e:
        log("karaoke-extract", f"Caption download error (non-fatal): {e}")

    return {
        "audio_path": audio_path,
        "caption_json_path": caption_json_path,
        "has_captions": has_captions,
    }


def detect_intro_offset(
    original_audio: str,
    karaoke_audio: str,
    duration: float,
    tmp_dir: str,
) -> Optional[float]:
    """Cross-correlate original and karaoke audio to find the song's start offset.

    Extracts first 60s of both tracks, computes cross-correlation, and
    returns the lag (in seconds) where the karaoke audio best aligns with
    the original. This lag is the intro duration in the music video.

    Returns the offset in seconds, or None if correlation fails.
    """
    try:
        import numpy as np
        from scipy import signal as scipy_signal
    except ImportError:
        log("karaoke-offset", "numpy/scipy not available — skipping cross-correlation")
        return None

    # Extract first 60s of both as mono WAV at 8kHz (fast, good enough for correlation)
    orig_clip = os.path.join(tmp_dir, "intro-orig.wav")
    kara_clip = os.path.join(tmp_dir, "intro-kara.wav")
    max_len = min(duration, 60.0)

    try:
        run([
            _FFMPEG_BIN, "-y", "-i", original_audio,
            "-vn", "-acodec", "pcm_s16le", "-ar", "8000", "-ac", "1",
            "-t", str(max_len),
            orig_clip,
        ], timeout=30)

        run([
            _FFMPEG_BIN, "-y", "-i", karaoke_audio,
            "-vn", "-acodec", "pcm_s16le", "-ar", "8000", "-ac", "1",
            "-t", str(max_len),
            kara_clip,
        ], timeout=30)
    except Exception as e:
        log("karaoke-offset", f"Audio extraction error: {e}")
        return None

    if not os.path.exists(orig_clip) or not os.path.exists(kara_clip):
        log("karaoke-offset", "Audio clip extraction failed")
        return None
    if os.path.getsize(orig_clip) < 1000 or os.path.getsize(kara_clip) < 1000:
        log("karaoke-offset", "Audio clips too small — likely empty")
        return None

    try:
        # Read raw PCM data
        with wave.open(orig_clip, 'rb') as wf:
            orig_frames = wf.readframes(wf.getnframes())
            orig_rate = wf.getframerate()
        with wave.open(kara_clip, 'rb') as wf:
            kara_frames = wf.readframes(wf.getnframes())
            kara_rate = wf.getframerate()

        # Convert to numpy arrays
        orig_data = np.frombuffer(orig_frames, dtype=np.int16).astype(np.float64)
        kara_data = np.frombuffer(kara_frames, dtype=np.int16).astype(np.float64)

        # Cross-correlate
        # Use the shorter of the two as the reference
        min_len = min(len(orig_data), len(kara_data))
        if min_len < 1000:
            log("karaoke-offset", f"Not enough audio data ({min_len} samples)")
            return None

        orig_data = orig_data[:min_len]
        kara_data = kara_data[:min_len]

        correlation = scipy_signal.correlate(kara_data, orig_data, mode='full')
        lag = np.argmax(correlation) - (len(orig_data) - 1)

        # lag is the number of samples the karaoke audio is shifted relative to the original
        # Positive lag: karaoke starts LATER → original has an intro of lag/rate seconds
        # Negative lag: karaoke starts EARLIER → unusual, set offset to 0
        offset_seconds = lag / orig_rate if lag > 0 else 0.0

        # Cleanup
        os.unlink(orig_clip)
        os.unlink(kara_clip)

        # Sanity check: offset should be between 0 and duration
        if offset_seconds < 0:
            offset_seconds = 0.0
        if offset_seconds > duration * 0.5:
            log("karaoke-offset", f"Offset {offset_seconds:.1f}s seems too large (>{duration*0.5:.0f}s) — ignoring")
            return None

        log("karaoke-offset", f"Cross-correlation: song starts at {offset_seconds:.1f}s in the music video")
        return round(offset_seconds, 1)

    except Exception as e:
        log("karaoke-offset", f"Correlation error: {e}")
        return None
    finally:
        for f in [orig_clip, kara_clip]:
            if os.path.exists(f):
                try:
                    os.unlink(f)
                except OSError:
                    pass



def _strip_lrc_to_plain(lrc_text: str) -> str:
    """Remove LRC timestamps, return plain lyric lines."""
    if not lrc_text:
        return ""
    tag_re = re.compile(r"\[\d{1,3}:\d{2}(?:\.\d{1,3})?\]")
    lines = []
    for raw in lrc_text.strip().split("\n"):
        text = tag_re.sub("", raw).strip()
        if text:
            lines.append(text)
    return "\n".join(lines)


def _plain_from_lrc_json(json_path: str) -> str:
    """Extract plain lyric text from an LRC JSON file."""
    try:
        data = json.loads(Path(json_path).read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return ""
    lines = []
    for line in data.get("lines", []):
        text = (line.get("text") or "").strip()
        if not text and line.get("words"):
            text = " ".join(w.get("text", "") for w in line["words"]).strip()
        if text:
            lines.append(text)
    return "\n".join(lines)


def _score_lyric_candidate(
    text: str,
    synced: bool,
    duration: float,
    source: str,
) -> float:
    """Higher is better. Prefer synced catalog sources over paste/invent."""
    if not text or len(text.strip()) < 10:
        return -1.0
    if _looks_like_garbage_lyrics(text):
        return -1.0
    words = len(text.split())
    # Rough expected lyric density: ~1 word / 2.5s of song
    expected = max(40.0, duration / 2.5)
    coverage = min(1.2, words / expected)
    score = coverage * 100.0
    if synced:
        score += 50.0
    bonuses = {
        "lrclib_synced": 25.0,
        "karaoke_captions": 20.0,
        "lrclib_plain": 10.0,
        "scrape": 8.0,
        "user_paste": 12.0,  # trusted words, but not preferred over LRCLIB synced
        "embedded_subs": 15.0,
    }
    score += bonuses.get(source, 0.0)
    return score


def _text_has_thai(text: str) -> bool:
    return bool(re.search(r"[\u0E00-\u0E7F]", text or ""))


def _collect_embedded_caption_candidates(tmp_dir: str, video_id: str, duration: float) -> list[dict]:
    """Find yt-dlp caption files in tmp and convert them to scored Stage 1 candidates."""
    found: list[dict] = []
    lang = (_WHISPER_LANG or "").strip().lower()
    patterns: list[str] = []
    # Prefer native-language captions first when a non-English language is set
    if lang and lang != "en":
        patterns.extend([
            f"{video_id}.{lang}.lrc",
            f"{video_id}.{lang}-{lang}.lrc",
            f"{video_id}.{lang}.vtt",
            f"{video_id}.{lang}-{lang}.vtt",
            f"{video_id}.{lang}-orig.lrc",
            f"{video_id}.{lang}-orig.vtt",
        ])
    patterns.extend([
        f"{video_id}.en.lrc",
        f"{video_id}.en-en.lrc",
        f"{video_id}.en.vtt",
        f"{video_id}.en-en.vtt",
        f"{video_id}.en-orig.lrc",
        f"{video_id}.en-orig.vtt",
    ])
    # Also pick up locale variants like .en-es-419.lrc / .th-en.lrc
    try:
        for name in os.listdir(tmp_dir):
            lower = name.lower()
            if not (lower.startswith(video_id.lower() + ".") and (lower.endswith(".lrc") or lower.endswith(".vtt"))):
                continue
            if name not in patterns:
                patterns.append(name)
    except OSError:
        pass

    seen = set()
    for name in patterns:
        path = os.path.join(tmp_dir, name)
        if path in seen or not os.path.exists(path) or os.path.getsize(path) < 20:
            continue
        seen.add(path)
        emb_json = captions_file_to_lrc_json(path, video_id, duration)
        if not emb_json:
            continue
        # Reject rolling / gibberish auto-captions before they lock out Whisper
        try:
            with open(emb_json, encoding="utf-8") as jf:
                emb_data = json.load(jf)
            if _lrc_json_is_garbage(emb_data):
                log("lyrics", f"Skipping garbage embedded captions: {name}")
                continue
        except (OSError, json.JSONDecodeError, TypeError):
            log("lyrics", f"Skipping unreadable embedded captions: {name}")
            continue
        emb_plain = _plain_from_lrc_json(emb_json)
        score = _score_lyric_candidate(emb_plain, True, duration, "embedded_subs")
        # Thai gold standard: strongly prefer Thai-script captions when --language th
        if lang == "th":
            name_l = name.lower()
            if _text_has_thai(emb_plain):
                score += 40.0
                # Prefer clean line-level th-th over word-level th-orig karaoke markup
                if name_l.endswith(".th-th.lrc") or name_l.endswith(".th-th.vtt"):
                    score += 25.0
                elif ".th-orig." in name_l:
                    score -= 20.0
            else:
                # English-only auto-captions on Thai MVs — demote so Whisper/Thai
                # captions can win instead of locking English into tracks.sung
                score -= 35.0
                if ".en." in name_l or name_l.endswith(".en.lrc") or name_l.endswith(".en.vtt"):
                    score -= 10.0
        if score <= 0:
            log("lyrics", f"Skipping low-quality embedded captions: {name}")
            continue
        found.append({
            "source": "embedded_subs",
            "text": emb_plain,
            "synced": True,
            "json_path": emb_json,
            "score": score,
            "caption_file": name,
        })
        log("lyrics", f"Embedded captions candidate from {name}: score={score:.0f} "
                      f"words={len(emb_plain.split())}")
    return found


def _load_whisper_model_with_fallback(wt, requested: str, whisper_lang: str):
    """Load Whisper model; fall back to smaller models on OOM / load failure.

    large-v3 is easy to kill on laptop RAM — never hard-fail the whole pipeline
    just because the requested model could not load.
    """
    requested = (requested or "").strip() or ("medium.en" if whisper_lang == "en" else "medium")
    fallbacks: list[str] = [requested]
    if whisper_lang == "en":
        for m in ("medium.en", "small.en", "base.en", "tiny.en"):
            if m not in fallbacks:
                fallbacks.append(m)
    else:
        for m in ("medium", "small", "base", "tiny"):
            if m not in fallbacks:
                fallbacks.append(m)

    last_err: Optional[BaseException] = None
    for name in fallbacks:
        try:
            log("whisper", f"    Loading model {name} (language={whisper_lang})...")
            model = wt.load_model(name)
            if name != requested:
                log("whisper", f"    Fell back from {requested} → {name}")
            return model, name
        except MemoryError as e:
            last_err = e
            log("whisper", f"    OOM loading {name} — trying smaller model")
        except Exception as e:
            last_err = e
            log("whisper", f"    Failed loading {name}: {e}")
    raise RuntimeError(f"Could not load any Whisper model (tried {fallbacks}): {last_err}")


def _load_karaoke_match_from_tags(video_id: str) -> Optional[str]:
    """Return saved karaoke_video_id from tags.json if present."""
    if not TAGS_PATH.exists():
        return None
    try:
        tags = json.loads(TAGS_PATH.read_text())
        for key in (video_id, f"{video_id}-karaoke"):
            entry = tags.get(key) or {}
            kid = entry.get("karaoke_video_id")
            if kid:
                return kid
    except (json.JSONDecodeError, OSError):
        pass
    return None


def step_whisper_lyrics(
    video_id: str,
    mp4_path: str,
    duration: float,
    tmp_dir: str,
    vocal_wav_path: Optional[str] = None,
    audit: Optional[AuditLog] = None,
    initial_prompt: Optional[str] = None,
    lyric_lines: Optional[list] = None,
    whisper_model: str = "medium.en",
) -> Optional[str]:
    """Transcribe lyrics using whisper-timestamped with word-level timing.

    Uses a two-pass strategy to handle music-video intros:
    1. Quick first pass on the opening 45 s (tiny.en model) to detect
       spoken-intro dialogue and find where the actual song starts.
    2. Full pass on the song body using medium.en with chunking and
       anti-hallucination guardrails.

    Loads audio once into a numpy array and slices in-memory for each
    chunk — no intermediate WAV files.  The single resampling step
    (ffmpeg: source → 16kHz mono) happens once.

    When ``lyric_lines`` (or ``initial_prompt``) is provided, each audio
    chunk gets only the lyrics that belong in that time window — not the
    entire song — reducing hallucinations.
    """
    log("whisper", "Running whisper-timestamped (two-pass + chunked, word-level)...")
    try:
        import whisper_timestamped as wt  # type: ignore[import-untyped]
        import numpy as np
    except ImportError:
        log("whisper", "whisper-timestamped or numpy not installed")
        return None

    # ── One-time audio prepare: resample to 16kHz mono WAV ──
    # Always refresh — stale/truncated whisper.wav from a prior run breaks alignment.
    audio_wav = os.path.join(tmp_dir, f"{video_id}-whisper.wav")
    if os.path.exists(audio_wav):
        try:
            os.remove(audio_wav)
        except OSError:
            pass
    # Prefer Demucs vocal stem for ALL languages (not just en). Karaoke mp4 is
    # instrumental-only and yields near-zero Whisper transcripts for non-en.
    use_stem = bool(
        vocal_wav_path
        and os.path.exists(vocal_wav_path)
        and os.path.getsize(vocal_wav_path) > 10000
    )
    if use_stem:
        log("whisper", f"Using Demucs vocal stem as audio source (lang={_WHISPER_LANG or 'auto'})")
        run([_FFMPEG_BIN, "-y", "-i", vocal_wav_path,
             "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
             audio_wav], timeout=60)
    elif mp4_path.endswith('.wav'):
        audio_wav = mp4_path
    else:
        log("whisper", f"Extracting mix audio from {os.path.basename(mp4_path)}")
        run([_FFMPEG_BIN, "-y", "-i", mp4_path,
             "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
             audio_wav], timeout=120)

    # ── Load full audio into memory (numpy array) ──
    try:
        audio_full = wt.load_audio(audio_wav)
        audio_samples = len(audio_full)
        log("whisper", f"Loaded audio: {audio_samples} samples @ 16kHz ({audio_samples/16000:.1f}s)")
    except Exception as e:
        log("whisper", f"Failed to load audio: {e}")
        return None

    t0 = time.time()
    model_name = whisper_model if whisper_model else ("medium.en" if (not _WHISPER_LANG or _WHISPER_LANG == "en") else "medium")
    whisper_lang = _WHISPER_LANG or "en"

    # ──────────────────────────────────────────────────────────────
    # Pass 1: Detect spoken-intro dialogue (tiny model, fast)
    # ──────────────────────────────────────────────────────────────
    song_start: float = 0.0
    try:
        intro_len = min(duration, 45.0)
        intro_samples = int(intro_len * 16000)
        intro_audio = audio_full[:intro_samples]

        tiny_model = wt.load_model("tiny.en")
        intro_result = wt.transcribe(
            tiny_model, intro_audio, language=whisper_lang,
            temperature=0.0, beam_size=1, best_of=1,
            condition_on_previous_text=False, no_speech_threshold=0.5,
        )

        intro_segs = intro_result.get("segments", [])
        if intro_segs:
            max_gap = 0.0
            boundary_end = 0.0
            for i in range(len(intro_segs) - 1):
                gap = intro_segs[i + 1]["start"] - intro_segs[i]["end"]
                if gap > max_gap:
                    max_gap = gap
                    boundary_end = intro_segs[i]["end"]
            if max_gap > 4.0 and boundary_end < 35.0:
                song_start = boundary_end + max_gap
                intro_words = sum(len(s.get("words", [])) for s in intro_segs
                                  if s["end"] <= boundary_end)
                log("whisper",
                    f"  Pass 1: Spoken intro found ({intro_words} words, "
                    f"ends at {boundary_end:.1f}s, gap={max_gap:.1f}s) "
                    f"→ song starts at {song_start:.1f}s")
            else:
                log("whisper", "  Pass 1: No spoken intro detected, transcribing from 0s")
    except Exception as e:
        log("whisper", f"  Pass 1 failed ({e}), transcribing from 0s")

    # ──────────────────────────────────────────────────────────────
    # Pass 2: Full transcription (medium model, in-memory chunking)
    # ──────────────────────────────────────────────────────────────
    model = None
    all_lines: list[dict] = []

    # Build chunks from song_start to end
    chunks: list[tuple[float, float]] = []
    pos = song_start
    while pos < duration:
        end = min(pos + 60.0, duration)
        chunks.append((pos, end))
        if end >= duration:
            break
        pos = end - 10.0

    first_chunk_threshold = 0.3
    log("whisper", f"  Pass 2: {len(chunks)} chunk(s) from {song_start:.0f}s: "
                   f"{', '.join(f'{a:.0f}s–{b:.0f}s' for a,b in chunks)}")

    # Prepare per-chunk lyric prompts (never dump the whole song into every window)
    prompt_lines: list[str] = []
    if lyric_lines:
        prompt_lines = [ln.strip() for ln in lyric_lines if ln and ln.strip()]
    elif initial_prompt:
        # Split a blob prompt into rough lines by punctuation / length
        prompt_lines = [p.strip() for p in re.split(r'[\n]+', initial_prompt) if p.strip()]
        if len(prompt_lines) == 1 and len(prompt_lines[0].split()) > 40:
            words = prompt_lines[0].split()
            prompt_lines = [" ".join(words[i:i+8]) for i in range(0, len(words), 8)]

    chunking_used = len(chunks) > 1
    repetition_triggered = False

    for ci, (chunk_start, chunk_end) in enumerate(chunks):
        chunk_len = chunk_end - chunk_start
        log("whisper", f"    Chunk {ci+1}/{len(chunks)}: {chunk_start:.1f}s–{chunk_end:.1f}s ({chunk_len:.1f}s)")

        # ── In-memory slice ──
        start_sample = int(chunk_start * 16000)
        end_sample = int(chunk_end * 16000)
        chunk_audio = audio_full[start_sample:end_sample]

        chunk_prompt = _prompt_for_chunk(prompt_lines, ci, len(chunks)) if prompt_lines else None
        if chunk_prompt:
            log("whisper", f"    Prompt slice: {len(chunk_prompt.split())} words")

        try:
            if model is None:
                model, model_name = _load_whisper_model_with_fallback(wt, model_name, whisper_lang)

            nst = first_chunk_threshold if ci == 0 else 0.6
            result = None
            for temperature in (0.0, 0.2, 0.4, 0.6, 1.0):
                transcribe_kwargs = dict(
                    language=whisper_lang,
                    temperature=temperature,
                    beam_size=(1 if temperature > 0.4 else 5),
                    best_of=(1 if temperature > 0.4 else 5),
                    condition_on_previous_text=False,
                    no_speech_threshold=nst,
                )
                if chunk_prompt:
                    transcribe_kwargs["initial_prompt"] = chunk_prompt
                result = wt.transcribe(model, chunk_audio, **transcribe_kwargs)
                seg_texts = " ".join(s["text"].strip() for s in result.get("segments", []))
                if not _has_repetition_loop(seg_texts):
                    break
                repetition_triggered = True
                log("whisper", f"    Repetition loop at temp={temperature}, escalating...")

            # Hard seam ownership: overlapping windows each own a
            # non-overlapping midpoint band so duplicate cues can't pile up.
            overlap_sec = 10.0
            is_first = ci == 0
            is_last = ci == len(chunks) - 1
            own_start = chunk_start if is_first else chunk_start + overlap_sec / 2.0
            own_end = chunk_end if is_last else chunk_end - overlap_sec / 2.0

            for seg in result.get("segments", []):
                text = seg["text"].strip()
                if not text:
                    continue
                abs_start = chunk_start + seg["start"]
                abs_end = chunk_start + seg["end"]
                mid = (abs_start + abs_end) / 2.0
                if mid < own_start or mid >= own_end:
                    continue
                chunk_pos = (seg["start"] / max(chunk_len, 1)) if chunk_len > 0 else 0
                entry = {
                    "text": text,
                    "startTime": round(abs_start, 3),
                    "endTime": round(abs_end, 3),
                    "_chunk_pos": round(chunk_pos, 3),
                }
                words = []
                for w in seg.get("words", []):
                    words.append({
                        "text": w["text"],
                        "startTime": round(chunk_start + w["start"], 3),
                        "endTime": round(chunk_start + w["end"], 3),
                    })
                entry["words"] = words
                all_lines.append(entry)
            log("whisper", f"    → {len(all_lines)} total lines so far")

        except MemoryError:
            log("whisper", f"    OOM on chunk {ci+1} — skipping and continuing")
            # Drop broken large model so next chunk can fall back
            if model is not None and str(model_name).startswith("large"):
                log("whisper", "    Dropping large model after OOM — will reload smaller next chunk")
                model = None
                model_name = "medium.en" if whisper_lang == "en" else "medium"
            continue
        except Exception as e:
            log("whisper", f"    Chunk {ci+1} failed ({e}) — skipping")
            if model is None and "Could not load any Whisper model" in str(e):
                log("whisper", "    Aborting Whisper invent — no model available")
                break
            continue

    if not all_lines:
        log("whisper", "No usable transcription lines — returning None")
        return None

    # Sort and deduplicate
    all_lines.sort(key=lambda l: l["startTime"])
    lines = _deduplicate_segments(all_lines)

    # Strip dialogue-only lines
    lines = [l for l in lines if not l.get("_dialogue")]

    # Post-hoc repetition guard
    text_joined = " ".join(l["text"] for l in lines)
    if _has_repetition_loop(text_joined):
        log("whisper", "Global repetition loop detected — aggressively deduplicating")
        lines = _aggressive_dedupe(lines)
        repetition_triggered = True

    elapsed = time.time() - t0
    total_words = sum(len(l['words']) for l in lines)
    log("whisper", f"Transcription complete: {len(lines)} lines, "
                   f"{total_words} words ({elapsed:.0f}s)")

    # ── Report alignment quality when using initial_prompt ──
    if initial_prompt:
        expected_words = set(w.lower().strip(",.!?;:()[]\"'") for w in initial_prompt.split() if len(w) > 1)
        transcribed_words = set()
        for l in lines:
            for w in l.get("words", []):
                transcribed_words.add(w["text"].lower().strip(",.!?;:()[]\"'"))
        if expected_words:
            overlap = len(expected_words & transcribed_words)
            pct = overlap / len(expected_words) * 100
            log("whisper", f"Alignment quality: {overlap}/{len(expected_words)} expected words matched ({pct:.0f}%)")

    # ── Record whisper params in audit log ──
    if audit is not None:
        audit.set_whisper_params(
            model=model_name,
            language=whisper_lang,
            chunking_used=chunking_used,
            chunk_count=len(chunks),
            chunk_size_sec=60,
            repetition_guard_triggered=repetition_triggered,
        )
        audit.record_step("whisper", ended_at=time.time(), metadata={
            "model": model_name,
            "language": whisper_lang,
            "chunks": len(chunks),
            "chunkSizeSec": 60,
            "lines": len(lines),
            "words": total_words,
            "repetitionGuardTriggered": repetition_triggered,
        })

    # Save (strip internal metadata)
    json_path = os.path.join(tmp_dir, f"{video_id}-karaoke.lrc.json")
    clean_lines = []
    for l in lines:
        clean = {k: v for k, v in l.items() if not k.startswith("_")}
        clean_lines.append(clean)
    lrc_json = {"videoId": video_id, "title": "", "artist": "", "duration": round(duration, 3), "lines": clean_lines}
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(lrc_json, f, indent=2, ensure_ascii=False)
    log("whisper", f"LRC JSON saved: {json_path}")
    if _RMANIZE_LANG:
        try:
            romanize_lrc_json(json_path, _RMANIZE_LANG)
        except RuntimeError as e:
            log("romanize", f"Romanize skipped: {e}")
    return json_path


# ── Helper: detect repetition loops in transcription text ──
def _has_repetition_loop(text: str, min_repeats: int = 10) -> bool:
    """Return True if a word/phrase repeats identically >= `min_repeats` times
    *consecutively* (no other words between).  This catches pathological Whisper
    loops while ignoring normal song choruses where the same line appears
    repeatedly but separated by other lyrics."""
    words = text.lower().split()
    if len(words) < min_repeats * 2:
        return False
    # Only check the tail portion — pathological loops tend to appear
    # at the end of long instrumental sections
    tail = words[-max(len(words), 200):]
    for wlen in (2, 3, 4):
        for i in range(len(tail) - wlen * min_repeats + 1):
            pattern = tuple(tail[i : i + wlen])
            # Check for *consecutive* repeats without gaps
            j = i + wlen
            count = 1
            while j + wlen <= len(tail) and tuple(tail[j : j + wlen]) == pattern:
                count += 1
                j += wlen
            if count >= min_repeats:
                return True
    return False


# ── Helper: deduplicate adjacent/overlapping segments with similar text ──
def _deduplicate_segments(lines: list[dict]) -> list[dict]:
    """Remove duplicate/overlapping segments after chunked Whisper.

    Prefers denser / earlier-in-chunk segments when texts are similar, then
    hard-clips any remaining time overlaps so karaoke cues never stack.
    """
    if len(lines) < 2:
        return list(lines)

    lines = sorted(lines, key=lambda l: (
        l.get("startTime", 0),
        l.get("_chunk_pos", 0),
        -len(l.get("words", [])),
    ))

    kept: list[dict] = []
    for line in lines:
        if not kept:
            kept.append(line)
            continue
        prev = kept[-1]
        overlap = min(prev["endTime"], line["endTime"]) - max(prev["startTime"], line["startTime"])
        if overlap > 0.15:
            sim = _text_similarity(line["text"], prev["text"])
            if sim > 0.45 or overlap > 2.0:
                prev_wc = len(prev.get("words", []))
                line_wc = len(line.get("words", []))
                line_pos = line.get("_chunk_pos", 1.0)
                prev_pos = prev.get("_chunk_pos", 1.0)
                if line_wc > prev_wc * 1.35:
                    kept[-1] = line
                elif prev_wc > line_wc * 1.35:
                    pass
                elif line_pos < prev_pos:
                    kept[-1] = line
                continue
        kept.append(line)

    # Hard clip residual overlaps (different text, small overlap)
    for i in range(1, len(kept)):
        prev, cur = kept[i - 1], kept[i]
        if cur["startTime"] < prev["endTime"]:
            clip_at = round(cur["startTime"], 3)
            if clip_at - prev["startTime"] < 0.05:
                # Prev is almost entirely under cur — drop prev
                kept[i - 1] = None  # type: ignore[assignment]
            else:
                prev["endTime"] = clip_at
                words = prev.get("words") or []
                for w in words:
                    if w.get("endTime", 0) > clip_at:
                        w["endTime"] = clip_at
                    if w.get("startTime", 0) > clip_at:
                        w["startTime"] = clip_at
    return [l for l in kept if l is not None]


def _text_similarity(a: str, b: str) -> float:
    """Jaccard-like word overlap ratio."""
    wa, wb = set(a.lower().split()), set(b.lower().split())
    if not wa and not wb:
        return 1.0
    return len(wa & wb) / max(len(wa | wb), 1)


def _aggressive_dedupe(lines: list[dict]) -> list[dict]:
    """Remove duplicate segments (same text at different times)."""
    seen_texts: set[str] = set()
    out: list[dict] = []
    for line in lines:
        norm = line["text"].lower().strip()
        if norm in seen_texts:
            continue
        seen_texts.add(norm)
        out.append(line)
    return out


# ── Helper: filter spoken intro (dialogue before the actual song) ──
def _filter_spoken_intro(lines: list[dict]) -> list[dict]:
    """Music videos often have dialogue at the start. If there's a gap >10s
    between consecutive segments before 30s into the video, and the pre-gap
    segment count is ≤4, strip those intro lines."""
    if len(lines) < 2:
        return list(lines)
    for i in range(min(8, len(lines) - 1)):
        gap = lines[i + 1]["startTime"] - lines[i]["endTime"]
        if gap > 10.0 and lines[i]["endTime"] < 30.0 and i <= 3:
            stripped = lines[: i + 1]
            log("whisper",
                f"Stripped {len(stripped)} spoken-intro segments "
                f"({stripped[0]['startTime']:.1f}s–"
                f"{stripped[-1]['endTime']:.1f}s, {gap:.1f}s gap → "
                f"song starts at {lines[i+1]['startTime']:.1f}s)")
            return lines[i + 1:]
    return list(lines)


def _norm_lyric_word(w: str) -> str:
    """Normalize a lyric token for matching (case/punct-insensitive)."""
    w = w.lower().replace("\u2019", "'").replace("\u2018", "'")
    w = re.sub(r"^[^a-z0-9']+|[^a-z0-9']+$", "", w)
    return w


def _flatten_whisper_words(lrc_json: dict) -> list[dict]:
    """Flatten Whisper LRC JSON into a chronological word list."""
    out: list[dict] = []
    for line in lrc_json.get("lines") or []:
        words = line.get("words") or []
        if words:
            for w in words:
                text = (w.get("text") or "").strip()
                if not text:
                    continue
                out.append({
                    "text": text,
                    "norm": _norm_lyric_word(text),
                    "startTime": float(w.get("startTime") or line.get("startTime") or 0),
                    "endTime": float(w.get("endTime") or line.get("endTime") or 0),
                })
        else:
            # No word timings — split line evenly as weak anchors
            toks = (line.get("text") or "").split()
            if not toks:
                continue
            st = float(line.get("startTime") or 0)
            et = float(line.get("endTime") or st)
            span = max(et - st, 0.05 * len(toks))
            step = span / len(toks)
            for i, tok in enumerate(toks):
                out.append({
                    "text": tok,
                    "norm": _norm_lyric_word(tok),
                    "startTime": st + i * step,
                    "endTime": st + (i + 1) * step,
                })
    # Drop empty norms and pathological zero-length runs
    cleaned = []
    for w in out:
        if not w["norm"]:
            continue
        if w["endTime"] <= w["startTime"]:
            w["endTime"] = w["startTime"] + 0.08
        cleaned.append(w)
    return cleaned


def _tokenize_known_lyrics(plain_text: str) -> tuple[list[str], list[dict]]:
    """Split known lyrics into display lines + flat word records with line index."""
    lines_raw = [ln.strip() for ln in plain_text.strip().split("\n") if ln.strip()]
    words: list[dict] = []
    for li, line in enumerate(lines_raw):
        for tok in line.split():
            words.append({
                "text": tok,
                "norm": _norm_lyric_word(tok),
                "line": li,
                "startTime": None,
                "endTime": None,
            })
    return lines_raw, words


def _reconcile_and_force_align(
    known_text: str,
    whisper_json: dict,
    duration: float,
) -> tuple[list[dict], dict]:
    """Reconcile close-but-imperfect known lyrics with Whisper hearing, then
    force-align known (display) words onto Whisper word timestamps.

    Strategy:
      - Align in time windows (handles repeated choruses).
      - Always keep known spelling (paste/catalog is close; Whisper invents).
      - Drop Whisper-only inserts (hallucinations).
      - Keep known-only deletes and interpolate timing inside each window.
    """
    from difflib import SequenceMatcher

    lines_raw, known_words = _tokenize_known_lyrics(known_text)
    heard = _flatten_whisper_words(whisper_json)
    if not known_words:
        return [], {"matched": 0, "known": 0, "heard": 0, "yield": 0.0}
    if not heard:
        return [], {"matched": 0, "known": len(known_words), "heard": 0, "yield": 0.0}

    n_win = max(1, min(6, int(duration // 35) + 1))
    matched = 0

    def _align_window(k_slice: list[dict], h_slice: list[dict]) -> int:
        """Align one window; mutate k_slice timings in place. Returns match count."""
        if not k_slice:
            return 0
        if not h_slice:
            return 0
        kn = [w["norm"] for w in k_slice]
        hn = [w["norm"] for w in h_slice]
        sm = SequenceMatcher(None, kn, hn, autojunk=False)
        local_matched = 0
        for tag, i1, i2, j1, j2 in sm.get_opcodes():
            if tag == "equal":
                for ki, hi in zip(range(i1, i2), range(j1, j2)):
                    k_slice[ki]["startTime"] = h_slice[hi]["startTime"]
                    k_slice[ki]["endTime"] = h_slice[hi]["endTime"]
                    local_matched += 1
            elif tag == "replace":
                k_span = list(range(i1, i2))
                h_span = list(range(j1, j2))
                if not h_span:
                    continue
                # Pair by relative position; keep known spelling always
                for n, ki in enumerate(k_span):
                    hi = h_span[min(int(n * len(h_span) / max(len(k_span), 1)), len(h_span) - 1)]
                    # Only accept timing if tokens are reasonably related OR
                    # the replace block is short (local substitution)
                    sim = _text_similarity(k_slice[ki]["norm"], h_slice[hi]["norm"])
                    if sim >= 0.35 or len(k_span) <= 3:
                        k_slice[ki]["startTime"] = h_slice[hi]["startTime"]
                        k_slice[ki]["endTime"] = h_slice[hi]["endTime"]
                        local_matched += 1
        return local_matched

    # Partition known words by line-index proportion; heard by time
    for wi in range(n_win):
        k0 = int(wi * len(known_words) / n_win)
        k1 = int((wi + 1) * len(known_words) / n_win)
        t0 = wi * duration / n_win
        t1 = (wi + 1) * duration / n_win
        # Pad hear window slightly so boundary words aren't orphaned
        pad = 2.0
        h_slice = [w for w in heard if (t0 - pad) <= w["startTime"] < (t1 + pad)]
        # Prefer words whose midpoint falls in window
        h_core = [w for w in h_slice if t0 <= (w["startTime"] + w["endTime"]) / 2 < t1]
        if h_core:
            h_slice = h_core
        matched += _align_window(known_words[k0:k1], h_slice)

        # Interpolate untimed words inside this window only
        window = known_words[k0:k1]
        timed = [i for i, w in enumerate(window) if w["startTime"] is not None]
        if not timed:
            # Evenly fill window times
            span = max(t1 - t0, 0.5)
            step = span / max(len(window), 1)
            for n, w in enumerate(window):
                w["startTime"] = t0 + n * step
                w["endTime"] = t0 + (n + 1) * step
            continue
        # Leading
        first = timed[0]
        if first > 0:
            anchor = float(window[first]["startTime"])
            t_start = max(t0, anchor - 0.15 * first)
            step = (anchor - t_start) / first
            for n in range(first):
                window[n]["startTime"] = t_start + n * step
                window[n]["endTime"] = t_start + (n + 1) * step
        # Middles
        for a, b in zip(timed, timed[1:]):
            if b == a + 1:
                continue
            gap = b - a - 1
            ts = float(window[a]["endTime"])
            te = float(window[b]["startTime"])
            if te < ts:
                te = ts + 0.08 * (gap + 1)
            step = (te - ts) / (gap + 1)
            for n in range(1, gap + 1):
                window[a + n]["startTime"] = ts + n * step
                window[a + n]["endTime"] = ts + (n + 1) * step
        # Trailing
        last = timed[-1]
        if last < len(window) - 1:
            remain = len(window) - 1 - last
            ts = float(window[last]["endTime"])
            te = min(t1, max(ts + 0.12 * remain, ts + 0.2))
            step = (te - ts) / remain
            for n in range(1, remain + 1):
                window[last + n]["startTime"] = ts + (n - 1) * step
                window[last + n]["endTime"] = ts + n * step

    # Global monotonic pass + min word duration
    for i in range(len(known_words)):
        w = known_words[i]
        if w["startTime"] is None:
            w["startTime"] = (known_words[i - 1]["endTime"] if i else 0.0)
        if w["endTime"] is None or w["endTime"] <= w["startTime"]:
            w["endTime"] = float(w["startTime"]) + 0.1
        if i and w["startTime"] < known_words[i - 1]["endTime"]:
            w["startTime"] = known_words[i - 1]["endTime"]
        if w["endTime"] <= w["startTime"]:
            w["endTime"] = float(w["startTime"]) + 0.1

    # Rebuild line cues from known line breaks (always known spelling)
    out_lines: list[dict] = []
    by_line: dict[int, list[dict]] = {}
    for w in known_words:
        by_line.setdefault(w["line"], []).append(w)
    for li, line_text in enumerate(lines_raw):
        ws = by_line.get(li) or []
        if not ws:
            continue
        # Keep display text identical to paste line; map timings 1:1 by index
        # (pad/trim if tokenizer drift) so repair_lrc_json_words won't even-space.
        disp_toks = line_text.split()
        word_objs = []
        for i, tok in enumerate(disp_toks):
            src = ws[min(i, len(ws) - 1)]
            word_objs.append({
                "text": tok,
                "startTime": round(float(src["startTime"]), 3),
                "endTime": round(float(src["endTime"]), 3),
            })
        # Enforce monotonic within the line
        for i in range(1, len(word_objs)):
            if word_objs[i]["startTime"] < word_objs[i - 1]["endTime"]:
                word_objs[i]["startTime"] = word_objs[i - 1]["endTime"]
            if word_objs[i]["endTime"] <= word_objs[i]["startTime"]:
                word_objs[i]["endTime"] = round(word_objs[i]["startTime"] + 0.08, 3)
        out_lines.append({
            "text": line_text,
            "startTime": word_objs[0]["startTime"],
            "endTime": word_objs[-1]["endTime"],
            "words": word_objs,
        })

    stats = {
        "matched": matched,
        "known": len(known_words),
        "heard": len(heard),
        "yield": matched / max(len(known_words), 1) * 100.0,
        "replaced_to_heard": 0,
        "lines": len(out_lines),
        "windows": n_win,
    }
    return out_lines, stats


def step_align_lyrics(
    video_id: str,
    plain_lrc_text: str,
    mp4_path: str,
    duration: float,
    tmp_dir: str,
    vocal_wav_path: Optional[str] = None,
    audit: Optional[AuditLog] = None,
    whisper_model: str = "medium.en",
    strict: bool = False,
) -> Optional[str]:
    """Perfect-path lyric timing: hear → reconcile → force-align.

    1. Free Whisper on vocals (chunked, hard seam ownership) for timing anchors
    2. Reconcile known text (paste/catalog) with what was heard
    3. Force-align known display words onto Whisper timestamps (no invented structure)

    Falls back to prompted Whisper only if force-align yield is unusable.
    """
    log("lyrics", "Source: known text + forced Whisper timing")
    log("lyrics", "Perfect align: hear vocals → reconcile text → lock timings")

    lines_raw = [line.strip() for line in plain_lrc_text.strip().split("\n") if line.strip()]
    if not lines_raw:
        log("lyrics", "Empty plain lyrics — falling back to full Whisper transcription")
        if strict:
            return None
        return step_whisper_lyrics(
            video_id, mp4_path, duration, tmp_dir,
            vocal_wav_path=vocal_wav_path, audit=audit,
            whisper_model=whisper_model,
        )

    expected_word_count = sum(len(line.split()) for line in lines_raw)
    log("lyrics", f"Known lyrics: {len(lines_raw)} lines, {expected_word_count} words")

    # Pass A: free hear (NO lyric prompt — timing reference only)
    hear_path = step_whisper_lyrics(
        video_id, mp4_path, duration, tmp_dir,
        vocal_wav_path=vocal_wav_path,
        audit=audit,
        whisper_model=whisper_model,
        # intentionally no lyric_lines / initial_prompt
    )
    if not hear_path or not os.path.exists(hear_path):
        log("lyrics", "Hearing pass failed")
        if strict:
            return None
        return step_whisper_lyrics(
            video_id, mp4_path, duration, tmp_dir,
            vocal_wav_path=vocal_wav_path, audit=audit,
            whisper_model=whisper_model,
        )

    try:
        with open(hear_path, encoding="utf-8") as f:
            heard_json = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        log("lyrics", f"Could not read hearing pass ({e})")
        return None if strict else hear_path

    aligned_lines, stats = _reconcile_and_force_align(plain_lrc_text, heard_json, duration)
    log("lyrics",
        f"Force-align yield: {stats['matched']}/{stats['known']} words "
        f"({stats['yield']:.0f}%), heard={stats['heard']}, "
        f"windows={stats.get('windows', 1)}, lines={stats.get('lines', 0)}")

    if not aligned_lines:
        log("lyrics", "Force-align produced no lines")
        if strict:
            return None
        return hear_path

    word_pct = float(stats["yield"])
    # Accept when most known words got a real Whisper anchor
    if word_pct < 40.0 and len(aligned_lines) < 8:
        log("lyrics", f"Force-align yield too low ({word_pct:.0f}%)")
        if strict:
            return None
        log("lyrics", "falling back to free Whisper transcription")
        return hear_path

    if word_pct < 70.0:
        log("lyrics",
            f"Force-align yield {word_pct:.0f}% < 70% — keeping reconciled timing "
            f"(still better than approx / prompted-transcribe seams)")

    lrc_json = {
        "videoId": video_id,
        "title": "",
        "artist": "",
        "duration": round(duration, 3),
        "lines": aligned_lines,
        "alignMode": "reconcile+force",
        "alignYield": round(word_pct, 1),
    }
    json_path = os.path.join(tmp_dir, f"{video_id}-karaoke.lrc.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(lrc_json, f, indent=2, ensure_ascii=False)
    log("lyrics", f"Force-aligned LRC saved: {json_path}")
    if _RMANIZE_LANG:
        try:
            romanize_lrc_json(json_path, _RMANIZE_LANG)
        except RuntimeError as e:
            log("romanize", f"Romanize skipped: {e}")
    return json_path


def step_build_unsynced_lrc(plain_lyrics: str, duration: float, onset: Optional[float] = None,
                           anchor_onset: Optional[float] = None) -> str:
    """Convert plain unsynced lyrics to approximate LRC with two-phase timing.

    Phase 1 (intro): lines before the first real lyric are compressed between
    `onset` (vocal start, ~12s) and `anchor_onset` (first verse, ~42s).
    Phase 2 (body): remaining lines are evenly spaced from `anchor_onset` to end.

    If no anchor is available, falls back to single-phase evenly-spaced timing.
    """
    lines = [line.strip() for line in plain_lyrics.strip().split("\n") if line.strip()]
    if not lines:
        return ""

    # Use Whisper-detected onset as the starting point if available
    start_time = onset if onset is not None and onset > 0.5 else 0.0

    # Find the first "real" lyric line — one with 4+ words and not just "do-do-do"
    anchor_idx = None
    if anchor_onset is not None and anchor_onset > 0.5:
        for i, line in enumerate(lines):
            words = [w for w in line.split() if w.lower() not in ('do-do-do,', 'do-do-do-do-do', '(uh-huh)', '(and', 'it', 'goes)', 'and', 'goes', 'uh-huh')]
            if len(words) >= 4 and i > 0:  # require 4+ substantive words, not first line
                anchor_idx = i
                log("lyrics", f"Two-phase LRC: intro lines [0-{i-1}], anchor at line {i} ({anchor_onset:.1f}s)")
                break

    if anchor_idx is not None:
        intro_lines = lines[:anchor_idx]
        body_lines = lines[anchor_idx:]
        intro_count = len(intro_lines)
        body_count = len(body_lines)

        lrc_lines = []
        # Phase 1: intro compressed between start_time and anchor_onset
        if intro_count > 0:
            intro_interval = (anchor_onset - start_time) / intro_count
            for i, line in enumerate(intro_lines):
                ts = start_time + (i * intro_interval)
                mins, secs = int(ts // 60), ts % 60
                lrc_lines.append(f"[{mins:02d}:{secs:05.2f}]{line}")

        # Phase 2: body evenly spaced from anchor_onset to end
        if body_count > 0:
            remaining = duration - anchor_onset
            body_interval = remaining / body_count
            for i, line in enumerate(body_lines):
                ts = anchor_onset + (i * body_interval)
                mins, secs = int(ts // 60), ts % 60
                lrc_lines.append(f"[{mins:02d}:{secs:05.2f}]{line}")

        log("lyrics", f"Built {len(lrc_lines)} LRC lines: {intro_count} intro + {body_count} body")
        return "\n".join(lrc_lines)

    # Fallback: single-phase evenly-spaced timing
    remaining = duration - start_time
    interval = remaining / len(lines) if len(lines) > 0 else remaining
    lrc_lines = []
    for i, line in enumerate(lines):
        ts = start_time + (i * interval)
        mins, secs = int(ts // 60), ts % 60
        lrc_lines.append(f"[{mins:02d}:{secs:05.2f}]{line}")

    if onset is not None and onset > 0.5:
        log("lyrics", f"Built {len(lrc_lines)} approximate LRC lines (shifted by {onset:.1f}s onset)")
    else:
        log("lyrics", f"Built {len(lrc_lines)} approximate LRC lines from plain lyrics")
    return "\n".join(lrc_lines)


def repair_lrc_json_words(lrc_path: str | Path) -> bool:
    """Ensure each line's words[] array matches its text field.

    If text was corrected without rebuilding words[], the word-level arrays
    are stale and the player renders wrong lyrics.  This function detects the
    mismatch and rebuilds words from text with even timing distribution.

    Repairs top-level lines and every tracks.*.lines array.

    Returns True if any words were repaired.
    """
    lrc_path = Path(lrc_path)
    if not lrc_path.exists():
        return False
    try:
        data = json.loads(lrc_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return False

    def _repair_lines(lines: list, align_mode: str = "") -> int:
        if align_mode == "reconcile+force":
            return 0
        fixed = 0
        for line in lines or []:
            text = (line.get("text") or "").strip()
            if not text:
                continue
            words_list = line.get("words", [])
            if not words_list:
                continue
            word_concat = "".join(w.get("text", "") for w in words_list).replace(" ", "")
            text_concat = text.replace(" ", "").replace(",", "").replace(".", "").replace("!", "").replace("?", "").replace("'", "").replace(";", "").replace(":", "")
            if word_concat.lower() != text_concat.lower():
                raw_words = text.split()
                start = line.get("startTime", 0)
                end = line.get("endTime", start + 1)
                dur = max(end - start, 0.1)
                new_words = []
                for i, w in enumerate(raw_words):
                    w_start = start + (dur * i / len(raw_words))
                    w_end = start + (dur * (i + 1) / len(raw_words))
                    new_words.append({
                        "text": w,
                        "startTime": round(w_start, 3),
                        "endTime": round(w_end, 3),
                    })
                line["words"] = new_words
                fixed += 1
        return fixed

    # Force-aligned LRCs already have consistent text/words — don't even-space them
    if data.get("alignMode") == "reconcile+force" and not data.get("tracks"):
        return False

    repaired = _repair_lines(data.get("lines", []), data.get("alignMode") or "")
    if isinstance(data.get("tracks"), dict):
        for tr in data["tracks"].values():
            if isinstance(tr, dict):
                repaired += _repair_lines(tr.get("lines") or [], tr.get("alignMode") or data.get("alignMode") or "")

    if repaired:
        data = normalize_lyric_tracks(data)
        lrc_path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        log("lyrics", f"Repaired words array on {repaired} line(s) in {lrc_path.name}")
    return repaired > 0


def step_save_lrc_json(
    video_id: str,
    lrc_text: str,
    duration: float,
    tmp_dir: str,
    artist: str = "",
    title: str = "",
    align_mode: str = "",
    lrclib_id: Optional[int] = None,
) -> Optional[str]:
    """Generate .lrc.json file with line- and word-level timing for the real-time overlay.

    Returns path to the generated .lrc.json, or None if LRC parsing fails.
    """
    # ── Inline LRC parsing (same as karaoke-render-lrc.py) ──
    lrc_tag_re = re.compile(r"\[(?P<min>\d{1,3}):(?P<sec>\d{2}(?:\.\d{2,3})?)\]")
    lines_raw: list[tuple[float, str]] = []

    for raw_line in lrc_text.strip().split("\n"):
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        matches = list(lrc_tag_re.finditer(raw_line))
        if not matches:
            if lines_raw:
                prev_ts, prev_text = lines_raw[-1]
                lines_raw[-1] = (prev_ts, prev_text + " " + raw_line)
            continue
        text_part = lrc_tag_re.sub("", raw_line).strip()
        if not text_part:
            continue
        for m in matches:
            mins = int(m.group("min"))
            secs = float(m.group("sec"))
            ts = mins * 60 + secs
            lines_raw.append((ts, text_part))

    lines_raw.sort(key=lambda x: x[0])
    if not lines_raw:
        return None

    # Compute end times
    end_times = []
    for i, (ts, _) in enumerate(lines_raw):
        if i + 1 < len(lines_raw):
            end_times.append(lines_raw[i + 1][0])
        else:
            end_times.append(duration)

    # ── Compute word-level timing (proportional to character count) ──
    timing_data = []
    for (start, text), end in zip(lines_raw, end_times):
        raw_words = text.split()
        line_dur = end - start
        entry: dict = {
            "text": text,
            "startTime": round(start, 3),
            "endTime": round(end, 3),
        }

        if raw_words and line_dur > 0:
            total_chars = sum(len(w) for w in raw_words) or 1
            t = start
            words = []
            for w in raw_words:
                share = len(w) / total_chars
                w_dur = share * line_dur
                words.append({
                    "text": w,
                    "startTime": round(t, 3),
                    "endTime": round(t + w_dur, 3),
                })
                t += w_dur
            entry["words"] = words
        else:
            entry["words"] = []

        timing_data.append(entry)

    lrc_json: dict = {
        "videoId": video_id,
        "title": title,
        "artist": artist,
        "duration": duration,
        "lines": timing_data,
    }
    if align_mode:
        lrc_json["alignMode"] = align_mode
        lrc_json["source"] = align_mode
    if lrclib_id is not None:
        lrc_json["lrclibId"] = int(lrclib_id)

    json_path = os.path.join(tmp_dir, f"{video_id}-karaoke.lrc.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(lrc_json, f, indent=2)

    log("lrc-json", f"Generated LRC JSON with {len(timing_data)} lines → {json_path}")
    return json_path


# Built-in Lao → Latin map (karaoke-friendly / ALA-LC-ish). No external dep.
_LAO_CONSONANTS = {
    "ກ": "k", "ຂ": "kh", "ຄ": "kh", "ງ": "ng", "ຈ": "ch", "ສ": "s", "ຊ": "x",
    "ຍ": "ny", "ດ": "d", "ຕ": "t", "ຖ": "th", "ທ": "th", "ນ": "n", "ບ": "b",
    "ປ": "p", "ຜ": "ph", "ຝ": "f", "ພ": "ph", "ຟ": "f", "ມ": "m", "ຢ": "y",
    "ຣ": "r", "ລ": "l", "ວ": "w", "ຫ": "h", "ອ": "o", "ຮ": "h", "ໜ": "n", "ໝ": "m",
}
_LAO_VOWELS = {
    "ະ": "a", "ັ": "a", "າ": "a", "ຳ": "am", "ິ": "i", "ີ": "i", "ຶ": "ue",
    "ື": "ue", "ຸ": "u", "ູ": "u", "ເ": "e", "ແ": "ae", "ໂ": "o", "ໃ": "ai",
    "ໄ": "ai", "ົ": "o", "ຽ": "ia", "ໍ": "o", "຺": "",
}
_LAO_MARKS = set("່້໊໋์໌")  # tone / cancellation — drop for Latin karaoke


def _romanize_lao(text: str) -> str:
    out = []
    for ch in text or "":
        if ch in _LAO_MARKS or ch == "\u200b":
            continue
        if ch in _LAO_CONSONANTS:
            out.append(_LAO_CONSONANTS[ch])
        elif ch in _LAO_VOWELS:
            out.append(_LAO_VOWELS[ch])
        elif "\u0E80" <= ch <= "\u0EFF":
            out.append("")  # unknown Lao letter — skip rather than leave script
        else:
            out.append(ch)
    # Collapse spaces introduced by dropped marks
    return re.sub(r"\s+", " ", "".join(out)).strip()


def _get_romanizer(lang: str):
    """Return a callable(text)->romanized for lang, or raise RuntimeError."""
    code = (lang or "").split("-")[0].lower()
    if code in ("id", "vi", "en", "fr", "es"):
        raise RuntimeError(
            f"Language '{code}' is already Latin script — romanize is not applicable"
        )
    if code == "th":
        try:
            from pythainlp.transliterate import romanize as th_romanize
        except ImportError as e:
            raise RuntimeError("pythainlp not installed — cannot romanize Thai") from e
        log("romanize", "Using pythainlp RTGS engine for Thai")
        return lambda t: th_romanize(t, engine="royin")
    if code == "ja":
        try:
            import pykakasi
            kks = pykakasi.kakasi()
        except ImportError as e:
            raise RuntimeError("pykakasi not installed — cannot romanize Japanese") from e
        log("romanize", "Using pykakasi Hepburn for Japanese")
        return lambda t: " ".join(r["hepburn"] for r in kks.convert(t or ""))
    if code == "ko":
        try:
            from korean_romanizer.romanizer import Romanizer as KoRomanizer
        except ImportError as e:
            raise RuntimeError("korean-romanizer not installed — cannot romanize Korean") from e
        log("romanize", "Using korean-romanizer (Revised Romanization)")
        def _ko(t):
            try:
                return KoRomanizer(t or "").romanize()
            except Exception:
                return t or ""
        return _ko
    if code == "zh":
        try:
            from pypinyin import lazy_pinyin
        except ImportError as e:
            raise RuntimeError("pypinyin not installed — cannot romanize Chinese") from e
        log("romanize", "Using pypinyin for Chinese")
        return lambda t: " ".join(lazy_pinyin(t or ""))
    if code == "lo":
        log("romanize", "Using built-in Lao romanizer")
        return _romanize_lao
    raise RuntimeError(
        f"No romanizer for language '{lang}'. Supported: th, ja, ko, zh, lo"
    )


def romanize_lrc_json(json_path: str, lang: str) -> bool:
    """Transliterate lyric text into tracks.romanized; keep native/sung.

    Supported: th (RTGS), ja (Hepburn), ko (RR), zh (pinyin), lo (built-in).
    Never destroys tracks.english.
    Returns True on success. Raises RuntimeError on missing engine / bad input
    when called from --romanize-only; callers that soft-skip should catch.
    """
    try:
        with open(json_path, encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        raise RuntimeError(f"Failed to open LRC JSON: {e}") from e

    code = (lang or "").split("-")[0].lower()
    romanizer = _get_romanizer(code)

    import copy
    if not isinstance(data.get("tracks"), dict):
        data["tracks"] = {}

    # Source native lines: prefer existing native/sung, else top-level lines
    native_lines = None
    if isinstance(data["tracks"].get("native"), dict) and data["tracks"]["native"].get("lines"):
        native_lines = copy.deepcopy(data["tracks"]["native"]["lines"])
    elif isinstance(data["tracks"].get("sung"), dict) and data["tracks"]["sung"].get("lines"):
        native_lines = copy.deepcopy(data["tracks"]["sung"]["lines"])
    elif data.get("lines"):
        native_lines = copy.deepcopy(data["lines"])
    if not native_lines:
        raise RuntimeError("No lines to romanize")

    if "sung" not in data["tracks"] and "native" not in data["tracks"]:
        data["tracks"]["sung"] = {
            "lang": code,
            "label": "As sung",
            "role": "primary",
            "lines": copy.deepcopy(native_lines),
            "alignMode": data.get("alignMode") or data.get("source") or "",
        }
    if "native" not in data["tracks"]:
        data["tracks"]["native"] = {
            "lang": code,
            "label": "Native",
            "role": "native",
            "lines": copy.deepcopy(native_lines),
            "alignMode": data.get("alignMode") or data.get("source") or "",
        }

    rom_lines = copy.deepcopy(native_lines)
    changed = 0
    for line in rom_lines:
        orig = line.get("text") or ""
        line["text"] = romanizer(orig)
        if line["text"] != orig:
            changed += 1
        for w in line.get("words") or []:
            orig_w = w.get("text") or ""
            w["text"] = romanizer(orig_w)
            if w["text"] != orig_w:
                changed += 1

    data["tracks"]["romanized"] = {
        "lang": f"{code}-Latn",
        "label": "Romanized",
        "role": "primary",
        "lines": rom_lines,
        "alignMode": data.get("alignMode") or data.get("source") or "",
    }
    has_english = (
        isinstance(data["tracks"].get("english"), dict)
        and data["tracks"]["english"].get("lines")
    )
    has_sung = (
        isinstance(data["tracks"].get("sung"), dict)
        and data["tracks"]["sung"].get("lines")
    )
    # Plan default: romanized primary; english secondary; native/sung tertiary (above)
    secondary = "english" if has_english else None
    tertiary = None
    if "native" in data["tracks"] and data["tracks"]["native"].get("lines"):
        tertiary = "native"
    elif has_sung:
        tertiary = "sung"
    data["display"] = {"primary": "romanized", "secondary": secondary, "tertiary": tertiary}
    data = normalize_lyric_tracks(data)

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    log("romanize", f"Romanized {changed} text field(s) → tracks.romanized ({len(rom_lines)} lines) in {json_path}")
    return True


def _primary_track_key(data: dict) -> str:
    display = data.get("display") if isinstance(data.get("display"), dict) else {}
    primary = display.get("primary")
    tracks = data.get("tracks") if isinstance(data.get("tracks"), dict) else {}
    if primary and primary in tracks:
        return primary
    if tracks.get("romanized"):
        return "romanized"
    if tracks.get("sung"):
        return "sung"
    if tracks.get("english"):
        return "english"
    return "sung"


def _lines_to_plain_text(lines: list) -> str:
    return "\n".join((l.get("text") or "").strip() for l in (lines or []) if (l.get("text") or "").strip())


def _apply_timings_keep_text(old_lines: list, timed_lines: list) -> list:
    """Copy start/end from timed_lines onto old_lines by index; keep old text; rebuild words."""
    out = []
    n = len(old_lines or [])
    for i in range(n):
        old = old_lines[i] or {}
        timed = timed_lines[i] if i < len(timed_lines or []) else {}
        start = float(timed.get("startTime", old.get("startTime", 0)) or 0)
        end = float(timed.get("endTime", old.get("endTime", start + 1)) or (start + 1))
        if end <= start:
            end = start + 0.35
        text = str(old.get("text") or "").strip()
        # Prefer force-align word anchors when present (same count); else proportional
        timed_words = timed.get("words") if isinstance(timed.get("words"), list) else None
        words_raw = text.split()
        line = {"text": text, "startTime": round(start, 3), "endTime": round(end, 3), "words": []}
        if words_raw and timed_words and len(timed_words) == len(words_raw):
            for j, w in enumerate(words_raw):
                tw = timed_words[j] or {}
                ws = float(tw.get("startTime", start) or start)
                we = float(tw.get("endTime", end) or end)
                if we <= ws:
                    we = ws + 0.12
                line["words"].append({
                    "text": w,
                    "startTime": round(ws, 3),
                    "endTime": round(we, 3),
                })
            line["startTime"] = round(float(line["words"][0]["startTime"]), 3)
            line["endTime"] = round(float(line["words"][-1]["endTime"]), 3)
        elif words_raw:
            dur = max(end - start, 0.1)
            total = sum(len(w) for w in words_raw) or 1
            t = start
            for w in words_raw:
                share = len(w) / total
                w_end = t + share * dur
                line["words"].append({
                    "text": w,
                    "startTime": round(t, 3),
                    "endTime": round(w_end, 3),
                })
                t = w_end
            line["words"][-1]["endTime"] = round(end, 3)
        out.append(line)
    return out


def _fix_leading_timing_smear(lines: list, vocal_onset: Optional[float]) -> list:
    """Clamp intro smear: force-align often parks the first line at t=0 through silence.

    If line 0 starts near 0 but ends after vocal onset (and line 1 is already in the
    sung region), snap line 0's start to onset and rebuild its word timings
    proportionally. Text is never changed.
    """
    if not lines:
        return lines
    onset = float(vocal_onset) if vocal_onset is not None else None
    line0 = dict(lines[0] or {})
    start = float(line0.get("startTime") or 0)
    end = float(line0.get("endTime") or 0)
    if end <= start:
        return lines

    snap_to = None
    next_start = None
    if len(lines) > 1:
        next_start = float((lines[1] or {}).get("startTime") or 0)

    if onset is not None and start < onset - 0.5 and end > onset + 0.3:
        # Prefer landing slightly before onset so the cue is early, not late
        snap_to = max(0.0, onset - 0.1)
        # If next line is soon after onset, keep line0 from eating into it
        if next_start is not None and next_start > snap_to + 0.4:
            snap_to = min(snap_to, next_start - 0.35)
    elif start < 0.5 and end - start >= 4.0 and next_start is not None and 4.0 <= next_start <= 20.0:
        # No onset available: pull start to ~1.2s before the compact next line
        snap_to = max(0.0, next_start - 1.2)

    if snap_to is None or snap_to <= start + 0.05:
        return lines
    snap_to = min(snap_to, end - 0.35)
    if snap_to <= start:
        return lines

    log("retime", f"Clamping leading smear: line0 {start:.2f}s → {snap_to:.2f}s"
                  + (f" (onset={onset:.2f}s)" if onset is not None else ""))

    text = str(line0.get("text") or "").strip()
    words_raw = text.split()
    line0["startTime"] = round(snap_to, 3)
    line0["endTime"] = round(end, 3)
    rebuilt = []
    if words_raw:
        dur = max(end - snap_to, 0.1)
        total = sum(len(w) for w in words_raw) or 1
        t = snap_to
        for w in words_raw:
            share = len(w) / total
            w_end = t + share * dur
            rebuilt.append({
                "text": w,
                "startTime": round(t, 3),
                "endTime": round(w_end, 3),
            })
            t = w_end
        rebuilt[-1]["endTime"] = round(end, 3)
    line0["words"] = rebuilt
    lines = list(lines)
    lines[0] = line0
    return lines


def _rebuild_line_words(text: str, start: float, end: float) -> list[dict]:
    """Proportional word timings inside [start, end] (keep-text safe)."""
    words_raw = str(text or "").split()
    if not words_raw:
        return []
    if end <= start:
        end = start + max(0.35, 0.12 * len(words_raw))
    dur = max(end - start, 0.1)
    total = sum(len(w) for w in words_raw) or 1
    out = []
    t = start
    for w in words_raw:
        share = len(w) / total
        w_end = t + share * dur
        out.append({
            "text": w,
            "startTime": round(t, 3),
            "endTime": round(w_end, 3),
        })
        t = w_end
    out[-1]["endTime"] = round(end, 3)
    return out


def _score_timing_structure(lines: list, duration: float) -> float:
    """0–100 structural quality (independent of Whisper word yield).

    Penalizes crushed clusters (many lines in a tiny window) and giant smears.
    """
    if not lines or duration <= 1:
        return 0.0
    score = 100.0
    spans = []
    for ln in lines:
        st = float(ln.get("startTime") or 0)
        en = float(ln.get("endTime") or st)
        spans.append(max(0.0, en - st))
        if st >= duration - 0.25:
            score -= 8.0
        if (en - st) > 20.0:
            score -= 12.0
        elif (en - st) > 12.0:
            score -= 5.0

    # Crushed runs: ≥4 consecutive lines averaging <1.4s
    i = 0
    n = len(lines)
    while i < n:
        j = i
        while j < n and spans[j] < 1.4:
            j += 1
        run = j - i
        if run >= 4:
            window = float(lines[j - 1].get("endTime") or 0) - float(lines[i].get("startTime") or 0)
            if window < run * 1.5:
                score -= min(40.0, 6.0 * run)
                log("retime",
                    f"Structure: crushed run lines {i}-{j - 1} "
                    f"({run} lines in {window:.1f}s)")
        i = max(j, i + 1)

    return max(0.0, min(100.0, score))


def _repair_timing_structure(lines: list, duration: float) -> list:
    """Expand crushed runs and cap giant smears — text unchanged.

    Used after keep-text force-align when Whisper packs many LRCLIB lines into a
    tiny hear-window (classic catalog-cut mismatch).
    """
    if not lines or duration <= 1:
        return lines
    out = [dict(ln or {}) for ln in lines]
    n = len(out)
    changed = False

    # Cap absurd single-line smears (>18s with following content soon after gap)
    for i in range(n):
        st = float(out[i].get("startTime") or 0)
        en = float(out[i].get("endTime") or st)
        span = en - st
        if span <= 18.0:
            continue
        # End this line earlier: leave room for following lines or clip to 12s
        next_st = float(out[i + 1].get("startTime") or duration) if i + 1 < n else duration
        # If next line starts inside the smear, we'll redistribute the run below
        if next_st <= st + 1.0:
            continue
        new_en = min(en, st + 12.0, next_st - 0.15)
        if new_en > st + 0.5 and new_en < en - 0.5:
            out[i]["endTime"] = round(new_en, 3)
            out[i]["words"] = _rebuild_line_words(out[i].get("text") or "", st, new_en)
            changed = True
            log("retime", f"Capped smear line {i}: {span:.1f}s → {new_en - st:.1f}s")

    # Expand crushed runs into the idle time until the next sparse line / gap
    i = 0
    while i < n:
        st_i = float(out[i].get("startTime") or 0)
        en_i = float(out[i].get("endTime") or st_i)
        if (en_i - st_i) >= 1.4:
            i += 1
            continue
        j = i
        while j < n and (float(out[j].get("endTime") or 0) - float(out[j].get("startTime") or 0)) < 1.4:
            j += 1
        run = j - i
        if run < 4:
            i = max(j, i + 1)
            continue
        run_start = float(out[i].get("startTime") or 0)
        run_end = float(out[j - 1].get("endTime") or run_start)
        # Find a generous target end: skip ahead past short/crushed neighbors to the
        # next real anchor (span≥3s) or a large gap, so verse lines get room to breathe.
        target_end = run_end
        k = j
        while k < n:
            st_k = float(out[k].get("startTime") or 0)
            en_k = float(out[k].get("endTime") or st_k)
            gap = st_k - target_end
            span_k = en_k - st_k
            if gap > 8.0:
                # instrumental / pause — expand up to just before it
                target_end = st_k - 0.25
                break
            if span_k >= 3.0:
                target_end = st_k - 0.2
                break
            # Absorb trailing micro-lines into this redistribution window
            target_end = en_k
            k += 1
        else:
            target_end = min(duration - 0.4, run_start + run * 4.0)
        # Minimum singable budget: ~2.4s per line (short phrases still OK)
        min_budget = run_start + run * 2.4
        target_end = max(target_end, min_budget, run_end)
        target_end = min(target_end, run_start + 55.0, duration - 0.3)
        window = target_end - run_start
        if window < run * 1.8:
            i = max(j, i + 1)
            continue
        # If we absorbed micro-lines, include them in the redistribute set
        j = max(j, k) if k > j else j
        run = j - i
        weights = []
        for kk in range(i, j):
            wc = len(str(out[kk].get("text") or "").split()) or 1
            weights.append(max(wc, 2))
        total_w = float(sum(weights)) or 1.0
        t = run_start
        for idx, kk in enumerate(range(i, j)):
            share = weights[idx] / total_w
            seg = max(1.6, share * window)
            if idx == run - 1:
                end = target_end
            else:
                end = min(target_end - 0.25 * (run - 1 - idx), t + seg)
            if end <= t:
                end = t + 1.4
            text = out[kk].get("text") or ""
            out[kk]["startTime"] = round(t, 3)
            out[kk]["endTime"] = round(end, 3)
            out[kk]["words"] = _rebuild_line_words(text, t, end)
            t = end
            changed = True
        log("retime",
            f"Expanded crushed run lines {i}-{j - 1}: "
            f"{run} lines across {window:.1f}s (was {run_end - run_start:.1f}s)")
        i = j

    # Ensure monotonic non-overlapping cues
    for i in range(1, n):
        prev_en = float(out[i - 1].get("endTime") or 0)
        st = float(out[i].get("startTime") or 0)
        en = float(out[i].get("endTime") or st)
        if st < prev_en:
            st = prev_en
            if en <= st:
                en = st + 0.4
            out[i]["startTime"] = round(st, 3)
            out[i]["endTime"] = round(en, 3)
            out[i]["words"] = _rebuild_line_words(out[i].get("text") or "", st, en)
            changed = True

    # Last resort: if crushed runs remain, redistribute within gap-defined sections
    # (instrumental gaps >6s). Keeps LRCLIB text; spreads lines so they're singable.
    if _score_timing_structure(out, duration) < 85.0:
        sections = []
        start = 0
        for i in range(1, n):
            gap = float(out[i].get("startTime") or 0) - float(out[i - 1].get("endTime") or 0)
            if gap > 6.0:
                t0 = float(out[start].get("startTime") or 0)
                t1 = float(out[i].get("startTime") or 0) - 0.3
                sections.append((start, i, t0, t1))
                start = i
        t0 = float(out[start].get("startTime") or 0)
        t1 = min(duration - 0.5, float(out[-1].get("endTime") or duration) + 2.0)
        sections.append((start, n, t0, t1))
        for a, b, t0, t1 in sections:
            if b - a < 2 or t1 <= t0 + 1.0:
                continue
            weights = [max(len(str(out[k].get("text") or "").split()), 2) for k in range(a, b)]
            weights = [w + (2 if w >= 6 else 0) for w in weights]
            tw = float(sum(weights)) or 1.0
            window = t1 - t0
            t = t0
            for idx, k in enumerate(range(a, b)):
                share = weights[idx] / tw
                seg = max(1.8, share * window)
                end = t1 if idx == (b - a - 1) else min(t1 - 0.25 * (b - a - 1 - idx), t + seg)
                if end <= t:
                    end = t + 1.8
                text = out[k].get("text") or ""
                out[k]["startTime"] = round(t, 3)
                out[k]["endTime"] = round(end, 3)
                out[k]["words"] = _rebuild_line_words(text, t, end)
                t = end
                changed = True
        log("retime", f"Section-redistributed {len(sections)} gap-bounded blocks (structure repair)")
        # Monotonic again
        for i in range(1, n):
            prev_en = float(out[i - 1].get("endTime") or 0)
            st = float(out[i].get("startTime") or 0)
            en = float(out[i].get("endTime") or st)
            if st < prev_en:
                st = prev_en
                if en <= st:
                    en = st + 0.4
                out[i]["startTime"] = round(st, 3)
                out[i]["endTime"] = round(en, 3)
                out[i]["words"] = _rebuild_line_words(out[i].get("text") or "", st, en)

    if changed:
        log("retime", "Structural timing repair applied (text preserved)")
    return out


def _composite_align_score(yield_pct: float, structure: float) -> float:
    """Blend Whisper yield with structural singability (favor structure when close)."""
    y = max(0.0, min(100.0, float(yield_pct) or 0.0))
    s = max(0.0, min(100.0, float(structure) or 0.0))
    return 0.45 * y + 0.55 * s


def _audio_rms_stats(path: str, probe_secs: float = 90.0) -> dict:
    """Cheap RMS probe: overall level + fraction of loud frames (speech/vocals)."""
    import wave
    import array
    try:
        with wave.open(path, "rb") as w:
            ch = w.getnchannels()
            sr = w.getframerate()
            sw = w.getsampwidth()
            n = w.getnframes()
            max_frames = int(min(n, probe_secs * sr))
            raw = w.readframes(max_frames)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e), "overall": 0.0, "loud_frac": 0.0, "peak": 0.0}

    if sw == 2:
        samples = array.array("h")
        samples.frombytes(raw)
    elif sw == 1:
        samples = array.array("b")
        samples.frombytes(raw)
        samples = array.array("h", ((s - 128) * 256 for s in samples))
    else:
        return {"ok": False, "error": f"unsupported sampwidth={sw}", "overall": 0.0, "loud_frac": 0.0, "peak": 0.0}

    if ch > 1:
        mono = array.array("h")
        for i in range(0, len(samples), ch):
            mono.append(int(sum(samples[i:i + ch]) / ch))
        samples = mono
    if not samples:
        return {"ok": False, "error": "empty", "overall": 0.0, "loud_frac": 0.0, "peak": 0.0}

    scale = float(1 << 15)
    # Frame at ~0.5s
    frame = max(1, sr // 2)
    loud = 0
    frames = 0
    sum_sq = 0.0
    peak = 0.0
    for i in range(0, len(samples), frame):
        block = samples[i:i + frame]
        if not block:
            continue
        bsq = 0.0
        for s in block:
            v = s / scale
            av = abs(v)
            if av > peak:
                peak = av
            bsq += v * v
            sum_sq += v * v
        rms = (bsq / len(block)) ** 0.5
        frames += 1
        if rms >= 0.015:
            loud += 1
    overall = (sum_sq / max(1, len(samples))) ** 0.5
    loud_frac = loud / max(1, frames)
    # Healthy vocal stem / mix with singing: overall > ~0.02 and loud_frac > ~0.25
    ok = overall >= 0.02 and loud_frac >= 0.25 and peak >= 0.05
    return {"ok": ok, "overall": overall, "loud_frac": loud_frac, "peak": peak, "error": None}


def _extract_mix_wav(src_mp4: str, dest_wav: str) -> str:
    """Extract mono 16kHz mix from an mp4 for Whisper alignment."""
    run([
        _FFMPEG_BIN, "-y", "-i", src_mp4,
        "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
        dest_wav,
    ], timeout=120)
    if not os.path.exists(dest_wav) or os.path.getsize(dest_wav) < 10000:
        fatal(f"Failed to extract mix audio from {src_mp4}")
    return dest_wav


def _ensure_original_mix_for_retime(video_id: str, tmp_dir: str) -> str:
    """Return a path to original-mix audio (prefer local source mp4, else redownload)."""
    mix_wav = os.path.join(tmp_dir, f"{video_id}-original-mix.wav")

    source_mp4 = find_original_source_mp4(video_id)
    if source_mp4 is not None:
        log("retime", f"Extracting original mix from {source_mp4}")
        return _extract_mix_wav(str(source_mp4), mix_wav)

    # Redownload original YouTube media into temp, then extract audio
    dl_dir = os.path.join(tmp_dir, "yt-redownload")
    os.makedirs(dl_dir, exist_ok=True)
    log("retime", "Original mp4 missing/weak — redownloading YouTube audio for align")
    mp4 = step_download(video_id, dl_dir)
    return _extract_mix_wav(mp4, mix_wav)


def force_align_keep_text_file(
    lrc_path: str,
    video_id: str,
    duration: float,
    tmp_dir: str,
    *,
    vocal_wav_path: Optional[str] = None,
    mp4_path: Optional[str] = None,
    whisper_model: str = "medium",
    language: Optional[str] = None,
    min_yield: float = 40.0,
    preserve_text_source: bool = True,
) -> tuple[bool, float, str]:
    """Force-align keep-text in place on an LRC JSON file.

    Returns ``(ok, yield_pct, detail)``. Never invents words. Prefers Demucs
    vocals, then original mix. On failure leaves the file unchanged.
    """
    path = Path(lrc_path)
    if not path.exists():
        return False, 0.0, "lrc missing"

    try:
        existing = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        return False, 0.0, f"read failed: {e}"

    text_source = str(existing.get("source") or existing.get("alignMode") or "")
    tracks = existing.get("tracks") if isinstance(existing.get("tracks"), dict) else {}
    if not tracks:
        lines = existing.get("lines") or []
        tracks = {
            "sung": {
                "lang": language or "",
                "label": "As sung",
                "role": "primary",
                "lines": lines,
                "alignMode": existing.get("alignMode") or existing.get("source") or "",
            }
        }
        existing["tracks"] = tracks
        existing["display"] = {"primary": "sung", "secondary": None}

    primary_key = _primary_track_key(existing)
    primary_lines = list((tracks.get(primary_key) or {}).get("lines") or existing.get("lines") or [])
    if not primary_lines:
        return False, 0.0, "no primary lines"

    plain = _lines_to_plain_text(primary_lines)
    dur = float(duration or existing.get("duration") or 0) or float(
        primary_lines[-1].get("endTime") or 0
    ) or 180.0

    vocals = Path(vocal_wav_path) if vocal_wav_path else (
        LIBRARY_KARAOKE_DIR / f"{video_id}-karaoke-vocals.wav"
    )
    source_mp4 = Path(mp4_path) if mp4_path else (LIBRARY_KARAOKE_DIR / f"{video_id}.mp4")
    karaoke_mp4 = LIBRARY_KARAOKE_DIR / f"{video_id}-karaoke.mp4"
    if not source_mp4.exists() and Path(mp4_path or "").exists():
        source_mp4 = Path(mp4_path)

    model = whisper_model or "medium"
    if language and language != "en" and model.endswith(".en"):
        model = model.replace(".en", "") or "medium"

    global _WHISPER_LANG
    if language:
        _WHISPER_LANG = language

    work = os.path.join(tmp_dir, f"{video_id}-force-align")
    os.makedirs(work, exist_ok=True)

    attempts: list[tuple[str, Optional[str], str]] = []
    # Prefer original mix first when present — Demucs vocals + spoken-intro skip
    # often crush the opening verse on catalog-cut mismatches. Vocals still tried.
    if source_mp4.exists() and source_mp4.stat().st_size > 10000:
        attempts.append(("original-mp4", None, str(source_mp4)))
    else:
        attempts.append(("original-redownload", None, "__REDOWNLOAD__"))
    if vocals.exists() and vocals.stat().st_size > 10000:
        stats = _audio_rms_stats(str(vocals))
        log("retime",
            f"Vocal stem RMS: overall={stats['overall']:.4f} "
            f"loud={stats['loud_frac']:.0%} peak={stats['peak']:.3f} ok={stats['ok']}")
        if stats.get("ok"):
            fallback = str(source_mp4 if source_mp4.exists() else karaoke_mp4)
            attempts.append(("demucs-vocals", str(vocals), fallback))
        else:
            log("retime", "Vocal stem weak/silent — skipping demucs attempt")

    if not attempts:
        return False, 0.0, "no audio for align"

    best: Optional[tuple[float, float, float, list]] = None  # composite, yield, structure, timed
    for attempt_i, (label, vocal_path, audio_path) in enumerate(attempts):
        attempt_dir = os.path.join(work, f"attempt-{attempt_i}-{label}")
        os.makedirs(attempt_dir, exist_ok=True)
        align_vocal = vocal_path
        align_mp4 = audio_path
        if audio_path == "__REDOWNLOAD__":
            try:
                mix_wav = _ensure_original_mix_for_retime(video_id, attempt_dir)
            except Exception as e:  # noqa: BLE001
                log("retime", f"Redownload failed: {e}")
                continue
            align_vocal = None
            align_mp4 = mix_wav
        elif label == "original-mp4" or (align_vocal is None and str(audio_path).endswith(".mp4")):
            mix_wav = os.path.join(attempt_dir, f"{video_id}-mix.wav")
            try:
                _extract_mix_wav(audio_path, mix_wav)
            except Exception as e:  # noqa: BLE001
                log("retime", f"Mix extract failed ({e}) — trying next")
                continue
            align_mp4 = mix_wav

        log("retime",
            f"Force-align attempt {attempt_i + 1}/{len(attempts)} via {label} "
            f"(model={model}, lang={_WHISPER_LANG or 'auto'}, lines={len(primary_lines)})")
        aligned_path = step_align_lyrics(
            video_id,
            plain,
            align_mp4,
            dur,
            attempt_dir,
            vocal_wav_path=align_vocal,
            whisper_model=model,
            strict=False,
        )
        if not aligned_path or not os.path.exists(aligned_path):
            log("retime", f"Attempt {label} produced no LRC — trying next source")
            continue
        try:
            aligned = json.loads(Path(aligned_path).read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            log("retime", f"Attempt {label} unreadable ({e}) — trying next")
            continue
        timed = aligned.get("lines") or []
        # Apply keep-text + structural repair before scoring singability
        candidate = _apply_timings_keep_text(primary_lines, timed)
        candidate = _repair_timing_structure(candidate, dur)
        yield_pct = float(aligned.get("alignYield") or 0.0)
        structure = _score_timing_structure(candidate, dur)
        composite = _composite_align_score(yield_pct, structure)
        log("retime",
            f"Attempt {label}: yield={yield_pct:.1f}% structure={structure:.0f} "
            f"composite={composite:.1f} timed_lines={len(timed)}")
        if best is None or composite > best[0]:
            best = (composite, yield_pct, structure, candidate)
        # Early exit only when BOTH yield and structure are strong
        if yield_pct >= max(min_yield, 55.0) and structure >= 80.0:
            log("retime", f"Early stop — strong align via {label}")
            break
        log("retime", f"Continuing — need better composite (best so far {best[0]:.1f})")

    if best is None:
        return False, 0.0, "no timed LRC from any audio"
    composite, yield_pct, structure, new_primary = best
    if yield_pct < min_yield and structure < 50.0:
        return False, yield_pct, f"yield {yield_pct:.1f}% / structure {structure:.0f} too low"

    onset = None
    if vocals.exists():
        try:
            onset = detect_vocal_onset(str(vocals), dur)
        except Exception as e:  # noqa: BLE001
            log("retime", f"Onset detect failed: {e}")
    new_primary = _fix_leading_timing_smear(new_primary, onset)
    new_primary = _repair_timing_structure(new_primary, dur)

    tracks[primary_key] = dict(tracks.get(primary_key) or {})
    tracks[primary_key]["lines"] = new_primary
    tracks[primary_key]["alignMode"] = "reconcile+force|keep-text"
    tracks[primary_key]["alignYield"] = yield_pct
    tracks[primary_key]["alignStructure"] = structure

    for key, tr in list(tracks.items()):
        if key == primary_key or not isinstance(tr, dict):
            continue
        other = tr.get("lines") or []
        if not other:
            continue
        remapped = []
        for i, ol in enumerate(other):
            src = new_primary[i] if i < len(new_primary) else new_primary[-1]
            remapped.extend(_apply_timings_keep_text([ol], [src]))
        tr["lines"] = remapped
        tr["lines"] = _repair_timing_structure(tr["lines"], dur)

    existing["tracks"] = tracks
    if not isinstance(existing.get("display"), dict):
        existing["display"] = {
            "primary": primary_key,
            "secondary": "english" if tracks.get("english") and primary_key != "english" else None,
        }
    # Preserve catalog source BEFORE normalize (normalize no longer clobbers lrclib_*)
    if preserve_text_source and (
        text_source.startswith("lrclib")
        or _catalog_text_source(text_source)
        or text_source in ("user_paste", "karaoke_captions")
    ):
        existing["source"] = text_source.split("+")[0] if "+" in text_source else text_source
        if existing["source"] in ("reconcile+force", "reconcile+force|keep-text", ""):
            existing["source"] = "lrclib_synced" if "lrclib" in text_source else text_source
    elif str(existing.get("lrclibId") or ""):
        existing["source"] = "lrclib_synced"
    existing = normalize_lyric_tracks(existing)
    existing["alignMode"] = "reconcile+force|keep-text"
    existing["alignYield"] = yield_pct
    existing["alignStructure"] = structure
    existing["duration"] = dur
    if str(existing.get("lrclibId") or "") and not str(existing.get("source") or "").startswith("lrclib"):
        existing["source"] = "lrclib_synced"

    path.write_text(json.dumps(existing, indent=2, ensure_ascii=False), encoding="utf-8")
    repair_lrc_json_words(path)
    first_t = new_primary[0].get("startTime") if new_primary else None
    detail = (
        f"yield={yield_pct:.1f}% structure={structure:.0f} composite={composite:.1f} "
        f"lines={len(new_primary)} first={first_t}"
    )
    log("retime", f"KEEP_TEXT_ALIGN_OK: {video_id} {detail}")
    return True, yield_pct, detail


def _run_retime_keep_text(
    video_id: str,
    whisper_model: str = "medium",
    language: Optional[str] = None,
    no_cleanup: bool = False,
) -> None:
    """Force-align existing lyric text to vocals; never invent or replace wording.

    Audio priority for Whisper hear/align:
      1. Demucs vocal stem (if present and RMS-healthy)
      2. Original YouTube mix (local ``{id}.mp4`` or redownload)
    Never use karaoke.mp4 (instrumental) — it yields ~0% force-align.
    On low yield, retry once with original mix. Refuse to write smear timings.
    """
    dest_lrc = LIBRARY_KARAOKE_DIR / f"{video_id}-karaoke.lrc.json"
    if not dest_lrc.exists():
        fatal(f"No LRC JSON for {video_id} at {dest_lrc}")

    # Backup once
    bak = dest_lrc.with_suffix(dest_lrc.suffix + ".pre-retime-bak")
    if not bak.exists():
        shutil.copy2(dest_lrc, bak)
        log("retime", f"Backup → {bak.name}")

    try:
        existing = json.loads(dest_lrc.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        fatal(f"Failed to read LRC: {e}")

    duration = float(existing.get("duration") or 0) or 180.0
    tmp_dir = os.path.join(TEMP_BASE, f"{video_id}-retime")
    os.makedirs(tmp_dir, exist_ok=True)

    ok, yield_pct, detail = force_align_keep_text_file(
        str(dest_lrc),
        video_id,
        duration,
        tmp_dir,
        whisper_model=whisper_model,
        language=language,
        min_yield=40.0,
        preserve_text_source=True,
    )
    if not ok:
        fatal(
            f"Force-align failed ({detail}) — refusing to overwrite timings (text preserved). "
            f"Restore from {bak.name} if current file was previously smeared."
        )

    try:
        write_bundle_manifest(video_id, LIBRARY_KARAOKE_DIR)
    except Exception as e:  # noqa: BLE001
        log("retime", f"Bundle warning: {e}")

    if not no_cleanup:
        shutil.rmtree(tmp_dir, ignore_errors=True)
    log("complete", f"RETIME_OK: {video_id} {detail}")


def step_render(
    video_id: str,
    mp4_path: str,
    instrumental_path: str,
    lrc_text: str,
    duration: float,
    tmp_dir: str,
    no_cleanup: bool = False,
) -> str:
    """Re-encode the karaoke video: original video track + instrumental audio.
    
    Lyrics are NOT burned into the video — they are rendered in real-time by the
    browser player overlay using the .lrc.json file.
    """
    log("render", "Re-encoding karaoke video (video + instrumental, no subtitle burn) ...")

    output_path = os.path.join(tmp_dir, f"{video_id}-karaoke.mp4")

    if os.path.exists(output_path) and os.path.getsize(output_path) > 10000:
        log("render", "Karaoke MP4 already exists, skipping re-encode")
        return output_path

    cmd = [
        _FFMPEG_BIN, "-y",
        "-i", mp4_path,
        "-i", instrumental_path,
        "-map", "0:v", "-c:v", "copy",
        "-map", "1:a",
        "-c:a", "aac",
        "-ar", "44100",
        "-b:a", "192k",
        "-af", "volume=-1dB",
        "-movflags", "+faststart",
        "-shortest",
        output_path,
    ]
    log("render", " ".join(cmd[:8]) + " ...")
    run(cmd, timeout=900)

    if not os.path.exists(output_path) or os.path.getsize(output_path) < 10000:
        fatal("FFmpeg did not produce a valid output file")

    output_size_mb = os.path.getsize(output_path) / (1024 * 1024)
    log("render", f"Karaoke video rendered: {output_path} ({output_size_mb:.1f} MB)")
    return output_path


# ── DeepSeek Lyric Diagnosis ─────────────────────────────────────────


def step_deepseek_diagnose(
    *,
    video_id: str,
    artist: str,
    title: str,
    duration: float,
    vocal_onset: Optional[float],
    quality_verdict: str,
    quality_details: dict,
    lines_raw: list,
    lrclib_found: bool,
) -> Optional[dict]:
    """Call DeepSeek API for lyric diagnosis.

    Sends a compact payload (~400-600 tokens) and expects a structured
    JSON response identifying the problem and remedy.

    Returns None on any error (network, timeout, API key missing, etc.),
    so the caller can fall back to existing behavior.
    """
    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        log("deepseek", "DEEPSEEK_API_KEY not set — skipping AI diagnosis")
        return None

    # Build sample lyrics (first 3, last 1)
    sample_lines = []
    for ts, txt in lines_raw[:3]:
        sample_lines.append(f"{ts:.1f}s: {txt}")
    if len(lines_raw) > 3 and len(sample_lines) >= 3:
        sample_lines.append(f"{lines_raw[-1][0]:.1f}s: {lines_raw[-1][1]}")

    payload = {
        "model": "deepseek-chat",
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a karaoke pipeline diagnostic tool. Your job is to analyse "
                    "a payload describing a track's lyric timing quality and return a "
                    "strict JSON object identifying the problem and the exact remedy. "
                    "Be concise. Only output the JSON object — no markdown, no commentary.\n"
                    "Known problems: spoken_intro, wrong_lrclib_match, instrumental_track, "
                    "non_english_misdetected, poor_whisper_transcription, "
                    "offset_corrected_needs_verification, karaoke_version_downloaded, "
                    "no_lyrics_anywhere.\n"
                    "Output format: {\"problem\": \"<id>\", \"explanation\": \"...\", "
                    "\"recommendation\": \"...\", \"remedy\": \"re-run with ...\", "
                    "\"confidence\": 0.0-1.0}"
                ),
            },
            {
                "role": "user",
                "content": json.dumps({
                    "artist": artist or "",
                    "title": title or "",
                    "duration_seconds": duration,
                    "vocal_onset_seconds": vocal_onset,
                    "lrclib_found": lrclib_found,
                    "lrc_quality_verdict": quality_verdict,
                    "quality_details": quality_details,
                    "sample_lyrics": sample_lines,
                }, ensure_ascii=False),
            },
        ],
        "temperature": 0.1,
        "max_tokens": 300,
    }

    try:
        resp = requests.post(
            "https://api.deepseek.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=15,
        )
        resp.raise_for_status()
        result = resp.json()

        content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
        if not content:
            log("deepseek", "Empty response from DeepSeek")
            return None

        # Strip markdown code fences if present
        content = content.strip()
        if content.startswith("```"):
            content = content.split("\n", 1)[-1]
            if content.endswith("```"):
                content = content[:-3].strip()

        diagnosis = json.loads(content)
        log("deepseek", f"Diagnosis: {diagnosis.get('problem', 'unknown')} "
                        f"(confidence: {diagnosis.get('confidence', 'N/A')})")
        log("deepseek", f"Remedy: {diagnosis.get('remedy', 'none')}")
        return diagnosis

    except requests.exceptions.Timeout:
        log("deepseek", "API call timed out after 15s")
        return None
    except requests.exceptions.RequestException as e:
        log("deepseek", f"API error: {e}")
        return None
    except (json.JSONDecodeError, KeyError, IndexError) as e:
        log("deepseek", f"Response parsing error: {e}")
        return None


# ── Registration ──────────────────────────────────────────────────────


def _sha256_file(path: Path | str) -> str:
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _atomic_publish(src: str | Path, dest: Path) -> None:
    """Copy src into dest's directory under a staging name, fsync, then
    atomically rename into place. Readers never observe a partial file."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    staging = dest.parent / f".staging-{dest.name}.{os.getpid()}.part"
    try:
        shutil.copy2(src, staging)
        with open(staging, "rb+") as f:
            os.fsync(f.fileno())
        os.replace(staging, dest)
    finally:
        if staging.exists():
            try:
                staging.unlink()
            except OSError:
                pass


def _run_rebuild_stems_only(video_id: str, no_cleanup: bool = False) -> None:
    """Demucs + remux karaoke.mp4; refresh both WAV stems; keep lyrics untouched.

    Always Demucs from the *original* mix (source .mp4). If missing, re-download
    from YouTube into the karaoke library — never Demucs karaoke instrumental
    (that yields empty/weak vocals).
    """
    karaoke_mp4 = LIBRARY_KARAOKE_DIR / f"{video_id}-karaoke.mp4"
    source_mp4_dest = LIBRARY_KARAOKE_DIR / f"{video_id}.mp4"

    tmp_dir = os.path.join(TEMP_BASE, f"{video_id}-stems")
    shutil.rmtree(tmp_dir, ignore_errors=True)
    os.makedirs(tmp_dir, exist_ok=True)

    # Prefer any verified original (karaoke/ preserved, songs/, or flat library)
    found = find_original_source_mp4(video_id)
    if found is not None:
        log("stems", f"Using existing source {found} ")
        if found.resolve() != source_mp4_dest.resolve():
            source_mp4_dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(found, source_mp4_dest)
            log("stems", f"Copied original into karaoke dir → {source_mp4_dest}")
        mp4_path = str(source_mp4_dest if source_mp4_dest.exists() else found)
    else:
        if not karaoke_mp4.exists():
            fatal(f"No karaoke or source mp4 for {video_id} — cannot rebuild stems")
        log("stems", f"Downloading original mix for Demucs: {video_id}")
        dl_path = step_download(video_id, tmp_dir)
        shutil.copy2(dl_path, source_mp4_dest)
        info_src = Path(dl_path).with_suffix(".info.json")
        if info_src.exists():
            shutil.copy2(info_src, LIBRARY_KARAOKE_DIR / f"{video_id}-karaoke.info.json")
        log("stems", f"Preserved source → {source_mp4_dest}")
        mp4_path = str(source_mp4_dest)

    duration = get_video_duration(mp4_path) or 0.0
    log("stems", f"Rebuild stems only for {video_id} from {Path(mp4_path).name}")

    instrumental_path, vocals_path = step_stem_separation(video_id, mp4_path, tmp_dir)
    instrumental_path, vocals_path = ensure_both_stems(
        video_id, instrumental_path, vocals_path
    )

    # Remux: keep existing karaoke video track if present, else source video
    video_src = str(karaoke_mp4 if karaoke_mp4.exists() else mp4_path)
    out_mp4 = os.path.join(tmp_dir, f"{video_id}-karaoke.mp4")
    run([
        _FFMPEG_BIN, "-y",
        "-i", video_src,
        "-i", instrumental_path,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        out_mp4,
    ], timeout=600)
    if not os.path.exists(out_mp4) or os.path.getsize(out_mp4) < 10000:
        fatal("Stem remux failed — no karaoke mp4 produced")

    _atomic_publish(out_mp4, karaoke_mp4)
    log("stems", f"Published remuxed karaoke → {karaoke_mp4}")

    # Persist both stems (always overwrite on rebuild-stems)
    dest_vocals = LIBRARY_KARAOKE_DIR / f"{video_id}-karaoke-vocals.wav"
    dest_inst = LIBRARY_KARAOKE_DIR / f"{video_id}-instrumental.wav"
    shutil.copy2(vocals_path, dest_vocals)
    log("stems", f"Saved vocal stem → {dest_vocals}")
    shutil.copy2(instrumental_path, dest_inst)
    log("stems", f"Saved instrumental stem → {dest_inst}")

    try:
        write_bundle_manifest(video_id, LIBRARY_KARAOKE_DIR)
    except Exception as e:  # noqa: BLE001
        log("stems", f"Bundle warning: {e}")

    if not no_cleanup:
        shutil.rmtree(tmp_dir, ignore_errors=True)
    print(f"STEMS_OK videoId={video_id} vocals={dest_vocals.exists()} instrumental={dest_inst.exists()} duration={duration:.1f}")
    log("complete", f"STEMS_OK: {video_id}")


def write_bundle_manifest(video_id: str, karaoke_dir: Path) -> Optional[Path]:
    """Write ``{video_id}-karaoke.bundle.json`` LAST, after all assets are in
    place. It lists the required bundle files with sha256 + size; its presence
    marks the karaoke variant as locally `ready`. Cloud durability (R2
    upload/verify) is tracked separately in MySQL media_assets.

    Optional local stem roles (vocals / instrumental) are recorded when present
    but do not affect the `complete` flag (not published to R2 in v1).
    """
    karaoke_id = f"{video_id}-karaoke"
    role_files = {
        "media": f"{karaoke_id}.mp4",
        "lyrics": f"{karaoke_id}.lrc.json",
        "metadata": f"{karaoke_id}.info.json",
    }
    for ext in (".jpg", ".webp", ".png"):
        if (karaoke_dir / f"{karaoke_id}{ext}").exists():
            role_files["thumbnail"] = f"{karaoke_id}{ext}"
            break

    # Optional sidecar stems — local mix only
    optional_roles = {
        "vocals": f"{video_id}-karaoke-vocals.wav",
        "instrumental": f"{video_id}-instrumental.wav",
    }

    files: dict = {}
    missing = []
    for role, name in role_files.items():
        path = karaoke_dir / name
        if not path.exists():
            missing.append(role)
            continue
        files[name] = {
            "role": role,
            "size": path.stat().st_size,
            "sha256": _sha256_file(path),
        }
    if "thumbnail" not in role_files:
        missing.append("thumbnail")

    for role, name in optional_roles.items():
        path = karaoke_dir / name
        if path.exists() and path.stat().st_size > 10000:
            files[name] = {
                "role": role,
                "size": path.stat().st_size,
                "sha256": _sha256_file(path),
                "optional": True,
            }

    bundle = {
        "videoId": karaoke_id,
        "baseVideoId": video_id,
        "recipe": "karaoke-v1",
        "createdAt": time.time(),
        "complete": not missing,
        "missingRoles": missing,
        "files": files,
        "hasVocals": any(f.get("role") == "vocals" for f in files.values()),
        "hasInstrumental": any(f.get("role") == "instrumental" for f in files.values()),
    }
    bundle_path = karaoke_dir / f"{karaoke_id}.bundle.json"
    temp = karaoke_dir / f".staging-{karaoke_id}.bundle.json.{os.getpid()}"
    temp.write_text(json.dumps(bundle, indent=2))
    os.replace(temp, bundle_path)
    log("library", f"Bundle manifest written ({'complete' if not missing else 'missing: ' + ','.join(missing)}) → {bundle_path}")
    return bundle_path


def step_register(
    video_id: str,
    karaoke_mp4: str,
    mp4_path: str,
    duration: float,
    artist_override: Optional[str] = None,
    title_override: Optional[str] = None,
    vocals_path: Optional[str] = None,
    instrumental_path: Optional[str] = None,
    force_overwrite_lyrics: bool = False,
    lyrics_track: str = "sung",
) -> None:
    """Register the karaoke video in the Karol library.

    Moves files into .karol/library/karaoke/ and updates tags.json.
    Always persists vocal + instrumental stems when provided.
    """
    log("library", "Registering in Karol library ...")

    karaoke_dir = LIBRARY_KARAOKE_DIR
    karaoke_dir.mkdir(parents=True, exist_ok=True)

    # Publish karaoke mp4 atomically (stage in dest dir → fsync → rename) so
    # scanners / the player never see a half-copied file on the USB drive.
    dest_mp4 = karaoke_dir / f"{video_id}-karaoke.mp4"
    _atomic_publish(karaoke_mp4, dest_mp4)
    try:
        os.unlink(karaoke_mp4)
    except OSError:
        pass
    log("library", f"Published karaoke MP4 → {dest_mp4}")

    # Copy .lrc.json if it exists (for real-time overlay on tablet).
    # Accept canonical name and older -from-lrc / whisper sidecar names.
    dest_lrc_json = karaoke_dir / f"{video_id}-karaoke.lrc.json"
    parent = Path(karaoke_mp4).parent
    src_candidates = [
        parent / f"{video_id}-karaoke.lrc.json",
        parent / f"{video_id}-karaoke-from-lrc.lrc.json",
    ]
    src_lrc_json = next((p for p in src_candidates if p.exists()), None)
    if src_lrc_json is not None:
        # Track-aware publish: merge into named track; never drop other tracks
        # (especially tracks.english). force_overwrite only affects the target track.
        published = publish_merged_lrc(
            src_lrc_json,
            dest_lrc_json,
            track_key=lyrics_track or "sung",
            force=bool(force_overwrite_lyrics),
            protect_english=True,
            legacy_as="english",
        )
        if published:
            log("library", f"Copied LRC JSON → {dest_lrc_json}")
        else:
            log("library", f"Kept existing LRC JSON (new result not better): {dest_lrc_json}")
    else:
        log("library", f"No LRC JSON found next to karaoke MP4 in {parent}")

    # Always persist both Demucs stems when available
    if vocals_path and os.path.exists(vocals_path) and os.path.getsize(vocals_path) > 10000:
        dest_vocals = karaoke_dir / f"{video_id}-karaoke-vocals.wav"
        if vocals_path != str(dest_vocals):
            shutil.copy2(vocals_path, dest_vocals)
            log("library", f"Saved vocal stem → {dest_vocals}")
    else:
        log("library", "WARNING: registering without vocal stem — vocal mix will be unavailable")
    if instrumental_path and os.path.exists(instrumental_path) and os.path.getsize(instrumental_path) > 10000:
        dest_inst = karaoke_dir / f"{video_id}-instrumental.wav"
        if instrumental_path != str(dest_inst):
            shutil.copy2(instrumental_path, dest_inst)
            log("library", f"Saved instrumental stem → {dest_inst}")

    # Copy info.json from the download if it exists
    src_info = Path(mp4_path).with_suffix(".info.json")
    if src_info.exists():
        dest_info = karaoke_dir / f"{video_id}-karaoke.info.json"
        if src_info.resolve() != dest_info.resolve():
            _atomic_publish(src_info, dest_info)

    # Copy thumbnail if it exists
    for ext in [".jpg", ".webp", ".png"]:
        src_thumb = Path(mp4_path).with_suffix(ext)
        if src_thumb.exists():
            dest_thumb = karaoke_dir / f"{video_id}-karaoke{ext}"
            if src_thumb.resolve() != dest_thumb.resolve():
                _atomic_publish(src_thumb, dest_thumb)
            break

    # Update tags.json
    tags: dict = {}
    if TAGS_PATH.exists():
        try:
            tags = json.loads(TAGS_PATH.read_text())
        except json.JSONDecodeError:
            pass

    # Determine artist/title from info.json if not provided
    artist = artist_override or ""
    title = title_override or ""
    if (not artist or not title) and src_info.exists():
        try:
            info = json.loads(src_info.read_text())
            if not artist:
                artist = info.get("uploader", "")
            if not title:
                title = info.get("title", "")
        except (json.JSONDecodeError, KeyError):
            pass

    existing = tags.get(f"{video_id}-karaoke", {})
    tags[f"{video_id}-karaoke"] = {
        "tag": "karaoke",
        "year": existing.get("year", ""),
        "artist": existing.get("artist") or artist,
        "title": existing.get("title") or title,
        # Always stamp pipeline provenance — the Custom library filter keys off
        # this value, and scan rebuilds must not be able to clobber it.
        "source": "karaoke-maker",
        "duration": duration,
        # Preserve DJ star ratings across Re-Lyric / republish
        **({"rating": existing["rating"]} if existing.get("rating") else {}),
    }

    # Dual-presence: keep the original MV under songs/ as Music Videos (tag
    # music) while karaoke lives as {id}-karaoke. Archive alone used to mark
    # the id "downloaded" without a songs/ file → playlist sync skipped it.
    songs_dir = LIBRARY_DIR / "songs"
    songs_mp4 = songs_dir / f"{video_id}.mp4"
    try:
        src_mp4 = Path(mp4_path)
        if src_mp4.exists() and src_mp4.stat().st_size > 100_000:
            # Prefer a non-karaoke original; skip if source is already the karaoke render
            if "-karaoke" not in src_mp4.stem:
                if not songs_mp4.exists() or songs_mp4.stat().st_size < 100_000:
                    songs_dir.mkdir(parents=True, exist_ok=True)
                    _atomic_publish(src_mp4, songs_mp4)
                    log("library", f"Preserved Music Video → {songs_mp4}")
                base = tags.get(video_id) if isinstance(tags.get(video_id), dict) else {}
                if not isinstance(base, dict):
                    base = {}
                if base.get("tag") not in ("music", "song"):
                    tags[video_id] = {
                        **base,
                        "tag": "music",
                        "artist": base.get("artist") or artist,
                        "title": base.get("title") or title,
                        "year": base.get("year", ""),
                        "source": "" if base.get("source") == "karaoke-maker" else base.get("source", ""),
                    }
    except OSError as e:
        log("library", f"Music Video preserve warning: {e}")

    TAGS_PATH.write_text(json.dumps(tags, indent=2))
    log("library", "Updated tags.json")

    # Update youtube-download-archive.txt
    try:
        ARCHIVE_PATH.parent.mkdir(parents=True, exist_ok=True)
        archive = ARCHIVE_PATH.read_text() if ARCHIVE_PATH.exists() else ""
        entry = f"youtube {video_id}"
        if entry not in archive:
            needs_nl = archive and not archive.endswith("\n")
            ARCHIVE_PATH.write_text(f"{archive}{chr(10) if needs_nl else ''}{entry}\n")
    except OSError as e:
        log("library", f"Archive update warning: {e}")

    # Bundle manifest LAST — its presence marks the local bundle as ready
    try:
        write_bundle_manifest(video_id, karaoke_dir)
    except Exception as e:  # noqa: BLE001 — manifest failure must not undo the publish
        log("library", f"Bundle manifest warning: {e}")

    log("library", f"Done! Karaoke video registered: {dest_mp4}")


# ── Main Pipeline ────────────────────────────────────────────────────


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(
        description="Make a karaoke video from a YouTube URL"
    )
    parser.add_argument("url", help="YouTube URL or video ID")
    parser.add_argument("--artist", help="Override artist name for lyric lookup")
    parser.add_argument("--title", help="Override song title for lyric lookup")
    parser.add_argument("--no-cleanup", action="store_true",
                       help="Keep intermediate files for debugging")
    parser.add_argument("--reprocess", action="store_true",
                       help="Re-process existing karaoke: lyrics by default; with --rebuild-audio do a full fresh rebuild")
    parser.add_argument("--rebuild-audio", action="store_true",
                       help="With --reprocess: download fresh original video, re-run Demucs, mux new "
                            "instrumental onto the video stream (-c:v copy — no video re-encode)")
    parser.add_argument("--force-whisper", action="store_true",
                       help="Prefer Whisper invent over YouTube embedded auto-captions. "
                            "Still allows LRCLIB / karaoke captions / pasted lyrics to win first; "
                            "skips only low-trust embedded_subs so re-lyric can escape bad ASR.")
    parser.add_argument("--force-overwrite-lyrics", action="store_true",
                       help="Allow replacing an existing lrclib_synced LRC with a non-synced result. "
                            "Without this flag, synced LRCLIB on disk is sticky.")
    parser.add_argument("--language", type=str, default=None,
                       help="Whisper language override (e.g., 'es' for Spanish, 'en' for English)")
    parser.add_argument("--dry-run", action="store_true",
                       help="Show what would be done without executing")
    parser.add_argument("--validate", action="store_true",
                       help="Validate existing karaoke video: check vocal onset vs LRC timing")
    parser.add_argument("--diagnose-only", action="store_true",
                       help="Run diagnostic analysis (rule tree + DeepSeek) without re-processing")
    parser.add_argument("--find-karaoke", action="store_true",
                       help="Search YouTube for matching karaoke version and extract timing data")
    parser.add_argument("--karaoke-match", type=str, default=None,
                       help="YouTube video ID of the matching karaoke version (skip search)")
    parser.add_argument("--romanize", type=str, default=None,
                       help="Transliterate lyrics to Latin: th (RTGS), ja (Hepburn), "
                            "ko (Revised Romanization), zh (pinyin), lo (Lao). "
                            "Not applicable for already-Latin languages (id/vi/en).")
    parser.add_argument("--romanize-only", action="store_true",
                       help="Only romanize an existing karaoke LRC (no download, Demucs, Whisper, or rebuild). "
                            "Requires --romanize LANG. Writes tracks.romanized; keeps native/sung and english.")
    parser.add_argument("--rebuild-stems-only", action="store_true",
                       help="Re-run Demucs on existing/source audio; refresh vocal + instrumental WAVs "
                            "and remux karaoke.mp4 instrumental. Keeps lyrics untouched.")
    parser.add_argument("--lyrics-track", type=str, default="sung",
                       choices=("sung", "english", "romanized"),
                       help="Named track to write newly generated lyrics into (default: sung). "
                            "Never deletes other tracks; existing tracks.english is protected "
                            "unless --lyrics-track english is combined with --force-overwrite-lyrics.")
    parser.add_argument("--lyrics-file", type=str, default=None,
                       help="Path to a plain-text file with ground-truth lyrics for Whisper alignment (skips LRCLIB)")
    parser.add_argument("--whisper-model", type=str, default="medium.en",
                       help="Whisper model: tiny.en, tiny, medium.en, medium, large-v3, large (default: medium.en)")
    parser.add_argument("--retime-keep-text", action="store_true",
                       help="Re-align existing LRC timings via Whisper force-align, keeping all "
                            "display text (and tracks.english) unchanged. Uses Demucs vocals when "
                            "healthy; falls back to original YouTube mix (local mp4 or redownload) "
                            "on weak vocals / low yield. Never aligns against karaoke instrumental.")
    parser.add_argument("--skip-auto-retime", action="store_true",
                       help="Do not auto force-align catalog (LRCLIB/paste) text to Demucs vocals "
                            "after Stage 1. Escape hatch only — gold path runs keep-text align by default.")
    args = parser.parse_args()

    global _WHISPER_LANG
    _WHISPER_LANG = args.language
    global _RMANIZE_LANG
    _RMANIZE_LANG = args.romanize

    video_id = extract_video_id(args.url)

    # ── Romanize only: transliterate existing LRC → tracks.romanized ──
    if args.romanize_only:
        if not args.romanize:
            fatal("--romanize-only requires --romanize LANG (e.g. th, ja, ko, zh, lo)")
        json_path = LIBRARY_KARAOKE_DIR / f"{video_id}-karaoke.lrc.json"
        if not json_path.exists():
            alt = LIBRARY_KARAOKE_DIR / f"{video_id}.lrc.json"
            json_path = alt if alt.exists() else json_path
        if not json_path.exists():
            fatal(f"No karaoke LRC JSON found for {video_id} at {json_path}")
        log("romanize", f"Romanize-only: {json_path} (lang={args.romanize})")
        try:
            romanize_lrc_json(str(json_path), args.romanize)
        except RuntimeError as e:
            fatal(str(e))
        after = json.loads(json_path.read_text(encoding="utf-8"))
        has_rom = isinstance(after.get("tracks"), dict) and bool(
            (after.get("tracks") or {}).get("romanized")
        )
        if not has_rom:
            fatal(f"Romanization produced no tracks.romanized for {video_id}")
        n_lines = len(((after.get("tracks") or {}).get("romanized") or {}).get("lines") or [])
        print(f"ROMANIZE_OK videoId={video_id} lang={args.romanize} lines={n_lines}")
        return

    # ── Rebuild stems only: Demucs + remux; keep lyrics ──
    if args.rebuild_stems_only:
        _run_rebuild_stems_only(video_id, no_cleanup=bool(args.no_cleanup))
        return

    # ── Re-time only: keep perfect lyric text, re-lock timings to vocals ──
    if args.retime_keep_text:
        _run_retime_keep_text(
            video_id,
            whisper_model=args.whisper_model or "medium",
            language=args.language,
            no_cleanup=bool(args.no_cleanup),
        )
        return

    # ── Validate mode ──
    if args.validate:
        karaoke_mp4 = LIBRARY_KARAOKE_DIR / f"{video_id}-karaoke.mp4"
        lrc_json = LIBRARY_KARAOKE_DIR / f"{video_id}-karaoke.lrc.json"

        if not karaoke_mp4.exists():
            fatal(f"No karaoke video found for {video_id} at {karaoke_mp4}")
        if not lrc_json.exists():
            fatal(f"No LRC JSON found for {video_id} at {lrc_json}")

        print(f"\\n{'='*60}")
        print(f"  VALIDATE: {video_id}")
        print(f"  Karaoke MP4: {karaoke_mp4} ({os.path.getsize(karaoke_mp4)/1048576:.1f} MB)")
        print(f"  LRC JSON:    {lrc_json}")
        print(f"{'='*60}")

        try:
            lrc_data = json.loads(lrc_json.read_text())
            lines = lrc_data.get("lines", [])
            duration = lrc_data.get("duration", 0)
            print(f"  Lines: {len(lines)}")
            print(f"  Duration: {duration:.1f}s")
            if lines:
                print(f"  First line [{lines[0]['startTime']:.1f}s]: \"{lines[0]['text'][:60]}\"")
                print(f"  Last line  [{lines[-1]['startTime']:.1f}s]: \"{lines[-1]['text'][:60]}\"")
                meaningful = [l for l in lines if l.get('text', '').strip('♪🎵🎶"\' \\t\\n\\r')]
                print(f"  Meaningful lines: {len(meaningful)}")
                density = duration / max(len(meaningful), 1)
                print(f"  Line density: {density:.1f}s/line {'(OK)' if density < 10 else '(LOW)'}")
        except Exception as e:
            print(f"  LRC parse error: {e}")

        # Vocal onset detection — use vocal stem or original video, NOT instrumental karaoke
        print(f"\n  Detecting vocal onset...")
        onset_source = None
        # Prefer existing vocal stem
        vocal_stem = LIBRARY_KARAOKE_DIR / f"{video_id}-karaoke-vocals.wav"
        original_video = LIBRARY_DIR / f"{video_id}.mp4"
        if vocal_stem.exists():
            onset_source = str(vocal_stem)
            print(f"  Using vocal stem for onset detection")
        elif original_video.exists():
            onset_source = str(original_video)
            print(f"  Using original video for onset detection")
        else:
            # Fallback: extract audio from karaoke (won't work well, but better than nothing)
            onset_source = str(karaoke_mp4)
            print(f"  Using karaoke video for onset detection (may be inaccurate)")
        tmp_wav = os.path.join(TEMP_BASE, f"{video_id}-validate.wav")
        try:
            os.makedirs(os.path.dirname(tmp_wav), exist_ok=True)
            os.makedirs(os.path.join(TEMP_BASE, video_id), exist_ok=True)
            run([
                _FFMPEG_BIN, "-y", "-i", onset_source,
                "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2",
                "-t", "120",
                tmp_wav,
            ], timeout=30)
            onset = detect_vocal_onset_best(tmp_wav, min(duration, 120), os.path.join(TEMP_BASE, video_id))
            if onset is not None:
                first_lrc = lines[0]['startTime'] if lines else 0
                offset = onset - first_lrc
                print(f"  Vocal onset: {onset:.1f}s")
                print(f"  First LRC:   {first_lrc:.1f}s")
                print(f"  Offset:      {offset:+.1f}s")
                if abs(offset) < 1.5:
                    print(f"  Verdict: OK — lyrics are synced")
                elif abs(offset) < 10:
                    print(f"  Verdict: NEEDS CORRECTION — shift lyrics by {offset:+.1f}s")
                else:
                    print(f"  Verdict: FAIL — offset too large, consider re-processing with --reprocess")
            else:
                print(f"  Onset detection failed — cannot validate")
            os.unlink(tmp_wav)
        except Exception as e:
            print(f"  Onset detection error: {e}")

        print(f"\n  Remediation: python3 {__file__} --reprocess https://www.youtube.com/watch?v={video_id}")
        return

    # ── Diagnose-only mode ──
    if args.diagnose_only:
        print(f"\n{'='*60}")
        print(f"  DIAGNOSE: {video_id}")
        print(f"{'='*60}")

        lrc_json = LIBRARY_KARAOKE_DIR / f"{video_id}-karaoke.lrc.json"
        karaoke_mp4 = LIBRARY_KARAOKE_DIR / f"{video_id}-karaoke.mp4"

        if not lrc_json.exists() and not karaoke_mp4.exists():
            fatal(f"Nothing to diagnose for {video_id} — no karaoke video or LRC JSON found")

        # Load cached diagnosis from tags.json
        if TAGS_PATH.exists():
            try:
                tags = json.loads(TAGS_PATH.read_text())
                entry = tags.get(video_id, {})
                cached = entry.get("deepseek_diagnosis")
                if cached:
                    print(f"\n  Cached diagnosis:")
                    print(f"  Problem:     {cached.get('problem', 'N/A')}")
                    print(f"  Explanation: {cached.get('explanation', 'N/A')}")
                    print(f"  Remedy:      {cached.get('remedy', 'N/A')}")
                    print(f"  Confidence:  {cached.get('confidence', 'N/A')}")
                    print(f"\n  Use --reprocess to re-process with corrections.")
                    return
            except (json.JSONDecodeError, KeyError):
                pass

        # Run rule-based diagnosis
        if lrc_json.exists():
            try:
                lrc_data = json.loads(lrc_json.read_text())
                lines = lrc_data.get("lines", [])
                duration = lrc_data.get("duration", 0)
                print(f"  Lines: {len(lines)}, Duration: {duration:.1f}s")
                if lines:
                    lines_raw = [(l["startTime"], l.get("text", "")) for l in lines]
                    word_count = sum(len(t.split()) for _, t in lines_raw)

                    # Quick onset detection for diagnosis
                    onset = None
                    vocal_stem = LIBRARY_KARAOKE_DIR / f"{video_id}-karaoke-vocals.wav"
                    original_video = LIBRARY_KARAOKE_DIR / f"{video_id}.mp4"
                    if not vocal_stem.exists() and not original_video.exists():
                        original_video = LIBRARY_DIR / f"{video_id}.mp4"

                    onset_source = str(vocal_stem) if vocal_stem.exists() else str(original_video) if original_video.exists() else str(karaoke_mp4)
                    tmp_wav = os.path.join(TEMP_BASE, f"{video_id}-diag.wav")
                    tmp_subdir = os.path.join(TEMP_BASE, video_id)
                    os.makedirs(tmp_subdir, exist_ok=True)
                    run([
                        _FFMPEG_BIN, "-y", "-i", onset_source,
                        "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2",
                        "-t", "120", tmp_wav,
                    ], timeout=30)
                    onset = detect_vocal_onset_best(tmp_wav, min(duration, 120), os.path.join(TEMP_BASE, video_id))
                    if os.path.exists(tmp_wav):
                        os.unlink(tmp_wav)
                    # Clean up temp subdir if empty
                    try: os.rmdir(tmp_subdir)
                    except OSError: pass
                    print(f"  Vocal onset: {onset:.1f}s" if onset else "  Vocal onset: failed")

                    if diagnose_failure:
                        diag = diagnose_failure(
                            vocal_onset=onset,
                            duration=duration,
                            word_count=word_count,
                            line_count=len(lines_raw),
                            quality_verdict="unknown",
                            correction_offset=None,
                            lrclib_found=bool(lrc_data.get("source", "").startswith("lrclib")),
                            lrclib_lyrics_available=True,
                            whisper_used=bool(lrc_data.get("source", "").startswith("whisper")),
                            whisper_language="en",
                            youtube_title=f"{args.artist or ''} {args.title or ''} {video_id}",
                        )
                        if diag and diag.get("mode"):
                            mode = diag["mode"]
                            print(f"\n  Rule-based diagnosis:")
                            print(f"  Problem:  {mode['id']}")
                            print(f"  Symptoms: {mode['symptoms']}")
                            print(f"  Remedy:   {mode['remedy_detail']}")
                            print(f"  Auto:     {'yes' if mode.get('automatic') else 'no — manual'}")
                        else:
                            print(f"\n  Rule-based diagnosis: no known failure mode matched")
            except Exception as e:
                print(f"  Diagnosis error: {e}")

        print(f"\n  For DeepSeek AI diagnosis, set DEEPSEEK_API_KEY and re-run.")
        print(f"  Remediation: python3 {__file__} --reprocess https://www.youtube.com/watch?v={video_id}")
        return

    # ── Normal pipeline ──
    log("start", f"Processing video: {video_id}")
    if args.artist:
        log("start", f"Artist override: {args.artist}")
    if args.title:
        log("start", f"Title override: {args.title}")

    # ── Initialize audit log ──
    code_path = "reprocess" if args.reprocess else "fresh"
    audit = AuditLog(video_id, code_path)

    # Prefer logged-in Chrome session for all yt-dlp calls (reduces 429s)
    refresh_yt_cookies(force=True)

    if args.dry_run:
        log("dry-run", "Dry run complete — nothing executed")
        log("dry-run", f"Target video: {video_id}")
        log("dry-run", f"Output dir: {LIBRARY_KARAOKE_DIR}")
        if args.artist:
            log("dry-run", f"Artist override: {args.artist}")
        if args.title:
            log("dry-run", f"Title override: {args.title}")
        return

    # ── Check prerequisites ──
    if not os.access(_YTDLP_BIN, os.X_OK):
        fatal(f"yt-dlp not found at {_YTDLP_BIN}. Install it first (brew install yt-dlp).")
    if not shutil.which(_FFMPEG_BIN) and not os.access(_FFMPEG_BIN, os.X_OK) and not shutil.which("ffmpeg"):
        fatal("ffmpeg not found. Install it first (brew install ffmpeg or ffmpeg-full).")
    if not shutil.which(_FFPROBE_BIN):
        fatal(f"ffprobe not found at {_FFPROBE_BIN}.")

    try:
        import demucs  # noqa: F401
    except ImportError:
        fatal("demucs not installed. Run: pip install demucs")

    # ── Setup temp directory ──
    tmp_dir = os.path.join(TEMP_BASE, video_id)
    os.makedirs(tmp_dir, exist_ok=True)

    try:
        vocal_stem_path: Optional[str] = None
        vocal_onset: Optional[float] = None
        instrumental_path: Optional[str] = None

        if args.reprocess:
            karaoke_existing = LIBRARY_KARAOKE_DIR / f"{video_id}-karaoke.mp4"
            found_original = find_original_source_mp4(video_id)
            original = found_original  # Path | None
            if found_original is not None:
                log("reprocess", f"Using verified original source: {found_original}")

            if not karaoke_existing.exists() and not args.rebuild_audio:
                fatal(f"No existing karaoke MP4 found for {video_id}")

            # ── Full rebuild: fresh YouTube source + Demucs + audio mux ──
            # Never cascade from the existing karaoke MP4 (AAC generation loss).
            # Video stream is copied (-c:v copy); only audio is replaced.
            if args.rebuild_audio:
                log("reprocess",
                    "Full rebuild from scratch: fresh YouTube download → Demucs → "
                    "mux instrumental (video copy, no re-encode)")
                # Drop stale stems so we cannot reuse degraded audio
                for stale_name in (
                    f"{video_id}-instrumental.wav",
                    f"{video_id}-karaoke-vocals.wav",
                ):
                    stale = LIBRARY_KARAOKE_DIR / stale_name
                    if stale.exists():
                        try:
                            stale.unlink()
                            log("reprocess", f"Removed stale asset: {stale.name}")
                        except OSError as e:
                            log("reprocess", f"Could not remove {stale.name}: {e}")

                mp4_path = step_download(video_id, tmp_dir)
                duration = get_video_duration(mp4_path)
                karaoke_mp4_src = mp4_path
                log("download", f"Fresh source duration: {duration:.0f}s")
                audit.record_step("download", ended_at=time.time(),
                                  metadata={"duration": duration, "source": "fresh_rebuild"})

                instrumental_path, vocal_stem_path = step_stem_separation(
                    video_id, mp4_path, tmp_dir)
                instrumental_path, vocal_stem_path = ensure_both_stems(
                    video_id, instrumental_path, vocal_stem_path)
                audit.set_demucs_model("htdemucs_ft")
                audit.set_audio_source("fresh_download", True)
                audit.record_step("demucs", ended_at=time.time(),
                                  metadata={"model": "htdemucs_ft", "source": "fresh_rebuild"})

                onset_audio = os.path.join(tmp_dir, f"{video_id}-onset-audio.wav")
                if not os.path.exists(onset_audio):
                    run([
                        _FFMPEG_BIN, "-y", "-i", mp4_path,
                        "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "1",
                        "-t", "120", onset_audio,
                    ], timeout=30)
                if os.path.exists(onset_audio):
                    vocal_onset = detect_vocal_onset_best(onset_audio, min(duration, 120), tmp_dir)
                    if vocal_onset is not None:
                        log("reprocess", f"Vocal onset detected at {vocal_onset:.1f}s — quality checks enabled")
                    else:
                        log("reprocess", "Vocal onset detection failed — quality checks disabled")
                else:
                    vocal_onset = None

            else:
                # ── Lyrics-only reprocess (keep existing karaoke audio/video) ──
                if not karaoke_existing.exists():
                    fatal(f"No existing karaoke MP4 found for {video_id}")
                log("reprocess", f"Reprocessing lyrics only (audio untouched): {karaoke_existing}")

                # Check for existing vocal stem from previous processing
                vocal_stem_path = str(LIBRARY_KARAOKE_DIR / f"{video_id}-karaoke-vocals.wav")
                if not os.path.exists(vocal_stem_path):
                    vocal_stem_path = None
                else:
                    log("reprocess", f"Found existing vocal stem: {vocal_stem_path}")

                if args.force_whisper or args.title:
                    if original is not None and original.exists():
                        whisper_source = str(original)
                        log("reprocess", f"Using original video for transcription: {original}")
                    else:
                        log("reprocess", "Original not found — downloading audio for Whisper")
                        audio_wav = os.path.join(tmp_dir, f"{video_id}.wav")
                        if not os.path.exists(audio_wav):
                            run([
                                _YTDLP_BIN,
                                "-f", "ba",
                                "-x", "--audio-format", "wav",
                                "-o", audio_wav,
                                "--no-playlist",
                                *ytdlp_auth_args(),
                                f"https://www.youtube.com/watch?v={video_id}",
                            ], timeout=180)
                            log("reprocess", f"Downloaded audio for transcription: {audio_wav}")
                        whisper_source = audio_wav
                        mp4_path = whisper_source
                        # Use the freshly downloaded audio for Whisper, not the (possibly silent) vocal stem
                        vocal_stem_path = None
                        # Extract onset audio from the same download (avoid second yt-dlp call)
                        onset_audio = os.path.join(tmp_dir, f"{video_id}-onset-audio.wav")
                        if not os.path.exists(onset_audio):
                            run([
                                _FFMPEG_BIN, "-y", "-i", audio_wav,
                                "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "1",
                                "-t", "120", onset_audio,
                            ], timeout=30)
                            log("reprocess", "Extracted onset audio from Whisper source")
                else:
                    whisper_source = str(karaoke_existing)

                mp4_path = whisper_source
                karaoke_mp4_src = str(karaoke_existing)
                duration = get_video_duration(mp4_path)

                # In reprocess mode, detect vocal onset from freshly sourced audio
                # so the quality check at line 1437 functions correctly.
                # Don't use the existing vocal stem — it may be from an already-karaokified
                # instrumental track and produce garbage onsets.
                onset_audio = os.path.join(tmp_dir, f"{video_id}-onset-audio.wav")
                if not os.path.exists(onset_audio):
                    # If we have the original video, extract audio from it (fast, no download needed)
                    if original is not None and original.exists():
                        run([
                            _FFMPEG_BIN, "-y", "-i", str(original),
                            "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "1",
                            "-t", "120",
                            onset_audio,
                        ], timeout=30)
                        log("reprocess", f"Extracted onset audio from original video")
                    else:
                        # Download fresh audio for onset detection
                        log("reprocess", "Downloading fresh audio for onset detection")
                        run([
                            _YTDLP_BIN, "-f", "ba", "-x", "--audio-format", "wav",
                            "-o", onset_audio, "--no-playlist",
                            *ytdlp_auth_args(),
                            f"https://www.youtube.com/watch?v={video_id}",
                        ], timeout=180)
                        log("reprocess", f"Downloaded onset audio")

                if os.path.exists(onset_audio):
                    vocal_onset = detect_vocal_onset_best(onset_audio, min(duration, 120), tmp_dir)
                    if vocal_onset is not None:
                        log("reprocess", f"Vocal onset detected at {vocal_onset:.1f}s — quality checks enabled")
                    else:
                        log("reprocess", "Vocal onset detection failed — quality checks disabled")
                else:
                    vocal_onset = None
                    log("reprocess", "No onset audio available — quality checks disabled")

        else:
            # ── Fresh pipeline ──
            mp4_path = step_download(video_id, tmp_dir)
            duration = get_video_duration(mp4_path)
            log("download", f"Video duration: {duration:.0f}s")
            audit.record_step("download", ended_at=time.time(),
                              metadata={"duration": duration})
            if duration > 600:
                log("warn", f"Song is {duration/60:.0f} minutes. Processing will take longer.")

            instrumental_path, vocal_stem_path = step_stem_separation(video_id, mp4_path, tmp_dir)
            instrumental_path, vocal_stem_path = ensure_both_stems(
                video_id, instrumental_path, vocal_stem_path)
            audit.set_demucs_model("htdemucs_ft")
            audit.record_step("demucs", metadata={"model": "htdemucs_ft"})

            # ── Detect vocal onset from vocal stem ──
            vocal_onset = None
            if vocal_stem_path and os.path.exists(vocal_stem_path):
                vocal_onset = detect_vocal_onset_best(vocal_stem_path, duration, tmp_dir)
            else:
                log("lyrics", "No vocal stem for onset detection")

            karaoke_mp4_src = mp4_path

        # ── Karaoke version scraping (cross-correlation + captions) ──
        # Stage 1 collects candidates; Stage 2 attaches timing. Whisper invents
        # words ONLY when Stage 1 finds nothing.
        lrc_text = ""
        is_synced = False
        json_path = None
        expected_gt_words = 0
        lyric_source = ""
        karaoke_match_id = args.karaoke_match or _load_karaoke_match_from_tags(video_id)
        karaoke_offset: Optional[float] = None
        karaoke_caption_json: Optional[str] = None
        candidates: list[dict] = []  # {source, text, synced, score, json_path?}

        # Load user paste early as a candidate (not as a short-circuit)
        pasted_lyrics = ""
        if args.lyrics_file and os.path.isfile(args.lyrics_file):
            try:
                pasted_lyrics = Path(args.lyrics_file).read_text(encoding="utf-8").strip()
            except OSError:
                pasted_lyrics = ""
            if pasted_lyrics:
                expected_gt_words = len(pasted_lyrics.split())
                log("lyrics", f"User paste loaded: {expected_gt_words} words (candidate, not exclusive)")

        if karaoke_match_id:
            log("karaoke", f"Using karaoke match id: {karaoke_match_id}")
        elif args.find_karaoke or args.reprocess:
            # Explore karaoke YouTube versions before Whisper invent
            search_artist = args.artist
            search_title = args.title
            if not search_artist or not search_title:
                info_path = os.path.join(LIBRARY_KARAOKE_DIR, f"{video_id}.info.json")
                if not os.path.exists(info_path):
                    info_path = os.path.join(LIBRARY_KARAOKE_DIR, f"{video_id}-karaoke.info.json")
                if os.path.exists(info_path):
                    try:
                        info = json.loads(open(info_path).read())
                        if not search_artist:
                            search_artist = info.get("uploader") or info.get("artist")
                        if not search_title:
                            search_title = info.get("title") or info.get("track")
                    except (json.JSONDecodeError, KeyError, OSError):
                        pass
            if search_artist or search_title:
                candidates_yt = step_find_karaoke(
                    search_artist or "", search_title or video_id, duration, video_id
                )
                if candidates_yt:
                    karaoke_match_id = candidates_yt[0]["video_id"]
                    log("karaoke", f"Auto-selected karaoke match: {candidates_yt[0]['title']} ({karaoke_match_id})")

        if karaoke_match_id:
            cross_ref_audio = mp4_path
            if args.reprocess:
                original_check = LIBRARY_KARAOKE_DIR / f"{video_id}.mp4"
                if original_check.exists():
                    cross_ref_audio = str(original_check)
                elif LIBRARY_DIR.joinpath(f"{video_id}.mp4").exists():
                    cross_ref_audio = str(LIBRARY_DIR / f"{video_id}.mp4")
                elif not os.path.exists(mp4_path) or mp4_path.endswith('-karaoke.mp4'):
                    cross_ref_audio = os.path.join(tmp_dir, f"{video_id}-ref-audio.wav")
                    if not os.path.exists(cross_ref_audio):
                        run([
                            _YTDLP_BIN, "-f", "ba", "-x", "--audio-format", "wav",
                            "-o", cross_ref_audio, "--no-playlist",
                            *ytdlp_auth_args(),
                            f"https://www.youtube.com/watch?v={video_id}",
                        ], timeout=180)

            log("karaoke", f"Extracting data from karaoke video: {karaoke_match_id}")
            try:
                karaoke_data = step_extract_karaoke_data(karaoke_match_id, tmp_dir)
            except Exception as e:
                log("karaoke", f"Karaoke extract failed: {e}")
                karaoke_data = {"audio_path": "", "has_captions": False, "caption_json_path": None}

            if karaoke_data.get("audio_path") and os.path.exists(karaoke_data["audio_path"]) and os.path.exists(cross_ref_audio):
                karaoke_offset = detect_intro_offset(cross_ref_audio, karaoke_data["audio_path"], duration, tmp_dir)
                if karaoke_offset is not None:
                    log("karaoke", f"Computed intro offset: {karaoke_offset:.1f}s")

            if karaoke_data.get("has_captions") and karaoke_data.get("caption_json_path"):
                cap_path = karaoke_data["caption_json_path"]
                karaoke_caption_json = captions_file_to_lrc_json(cap_path, video_id, duration)
                if karaoke_caption_json:
                    log("karaoke", f"Captured timed captions from karaoke video: {karaoke_caption_json}")
                else:
                    log("karaoke", f"Karaoke captions unusable (parse failed): {cap_path}")

            if karaoke_match_id and TAGS_PATH.exists():
                try:
                    tags_data = json.loads(TAGS_PATH.read_text())
                    entry_key = f"{video_id}-karaoke" if not tags_data.get(video_id) else video_id
                    entry = tags_data.get(entry_key, {})
                    entry["karaoke_video_id"] = karaoke_match_id
                    if karaoke_offset is not None:
                        entry["karaoke_intro_offset"] = karaoke_offset
                    tags_data[entry_key] = entry
                    TAGS_PATH.write_text(json.dumps(tags_data, indent=2))
                    log("karaoke", "Saved karaoke match data to tags.json")
                except (json.JSONDecodeError, KeyError, OSError) as e:
                    log("karaoke", f"Tags save error: {e}")

            if karaoke_caption_json and os.path.exists(karaoke_caption_json):
                if karaoke_offset and karaoke_offset > 0:
                    try:
                        with open(karaoke_caption_json) as f:
                            cap_lrc = json.load(f)
                        for line in cap_lrc.get("lines", []):
                            line["startTime"] = round(line["startTime"] + karaoke_offset, 2)
                            line["endTime"] = round(line["endTime"] + karaoke_offset, 2)
                            if line.get("words"):
                                for w in line["words"]:
                                    w["startTime"] = round(w["startTime"] + karaoke_offset, 2)
                                    w["endTime"] = round(w["endTime"] + karaoke_offset, 2)
                        with open(karaoke_caption_json, 'w') as f:
                            json.dump(cap_lrc, f, indent=2, ensure_ascii=False)
                        log("karaoke", f"Shifted caption timestamps by {karaoke_offset:.1f}s")
                    except (json.JSONDecodeError, KeyError, OSError) as e:
                        log("karaoke", f"Caption offset error: {e}")
                kara_plain = _plain_from_lrc_json(karaoke_caption_json)
                if kara_plain:
                    candidates.append({
                        "source": "karaoke_captions",
                        "text": kara_plain,
                        "synced": True,
                        "json_path": karaoke_caption_json,
                        "score": _score_lyric_candidate(kara_plain, True, duration, "karaoke_captions"),
                    })

        # ── Stage 1: collect text from every catalog source ──
        log("lyrics", "Stage 1: collecting lyric text (LRCLIB → scrapers → paste → embedded)")

        # Sticky: existing library catalog text is sacred unless --force-overwrite-lyrics,
        # but raw lrclib_synced *timings* still get Demucs+Whisper keep-text align below.
        dest_lrc_lib = LIBRARY_KARAOKE_DIR / f"{video_id}-karaoke.lrc.json"
        existing_synced_kept = False
        skip_auto_retime = False
        if dest_lrc_lib.exists() and not args.force_overwrite_lyrics:
            try:
                existing_lrc = json.loads(dest_lrc_lib.read_text(encoding="utf-8"))
                if _lrc_json_is_garbage(existing_lrc):
                    log("lyrics", "Existing library LRC looks like WEBVTT/garbage — ignoring sticky keep")
                    catalog_text, catalog_synced, catalog_lrclib_id = step_fetch_lyrics(
                        video_id, duration,
                        artist_override=args.artist,
                        title_override=args.title,
                    )
                elif _lrc_source_rank(existing_lrc) >= 100:
                    am = str(existing_lrc.get("alignMode") or "").lower()
                    timing_ok = (
                        "keep-text" in am
                        and not _lrc_json_timing_broken(existing_lrc, duration)
                    )
                    pref_id = existing_lrc.get("lrclibId")
                    if timing_ok:
                        # Already gold-path aligned — keep without re-Whisper
                        log("lyrics",
                            "Existing keep-text LRC on disk with healthy timing — sticky keep")
                        keep_path = os.path.join(tmp_dir, f"{video_id}-karaoke.lrc.json")
                        shutil.copy2(dest_lrc_lib, keep_path)
                        candidates.append({
                            "source": str(existing_lrc.get("source") or "lrclib_synced"),
                            "text": _plain_from_lrc_json(str(dest_lrc_lib)),
                            "synced": True,
                            "lrc_text": "",
                            "json_path": keep_path,
                            "lrclib_id": pref_id,
                            "score": _score_lyric_candidate(
                                _plain_from_lrc_json(str(dest_lrc_lib)), True, duration, "lrclib_synced",
                            ),
                        })
                        existing_synced_kept = True
                        skip_auto_retime = True
                        catalog_text, catalog_synced, catalog_lrclib_id = "", False, None
                    else:
                        # Refresh text from LRCLIB; Stage 2 + auto-retime will fix timing
                        catalog_text, catalog_synced, catalog_lrclib_id = step_fetch_lyrics(
                            video_id, duration,
                            artist_override=args.artist,
                            title_override=args.title,
                            preferred_lrclib_id=int(pref_id) if pref_id else None,
                        )
                        if catalog_synced and catalog_text:
                            log("lyrics",
                                "Existing catalog LRC needs timing refresh — "
                                "re-fetching synced text for Demucs+Whisper keep-text align")
                        else:
                            log("lyrics",
                                "Existing catalog LRC needs timing refresh — "
                                "keeping disk text for keep-text align")
                            keep_path = os.path.join(tmp_dir, f"{video_id}-karaoke.lrc.json")
                            shutil.copy2(dest_lrc_lib, keep_path)
                            candidates.append({
                                "source": str(existing_lrc.get("source") or "lrclib_synced"),
                                "text": _plain_from_lrc_json(str(dest_lrc_lib)),
                                "synced": True,
                                "lrc_text": "",
                                "json_path": keep_path,
                                "lrclib_id": pref_id,
                                "score": _score_lyric_candidate(
                                    _plain_from_lrc_json(str(dest_lrc_lib)), True, duration, "lrclib_synced",
                                ),
                            })
                            existing_synced_kept = True
                            catalog_text, catalog_synced, catalog_lrclib_id = "", False, None
                else:
                    catalog_text, catalog_synced, catalog_lrclib_id = step_fetch_lyrics(
                        video_id, duration,
                        artist_override=args.artist,
                        title_override=args.title,
                    )
            except (json.JSONDecodeError, OSError, TypeError, ValueError) as e:
                log("lyrics", f"Existing LRC check failed ({e}) — fetching fresh")
                catalog_text, catalog_synced, catalog_lrclib_id = step_fetch_lyrics(
                    video_id, duration,
                    artist_override=args.artist,
                    title_override=args.title,
                )
        else:
            catalog_text, catalog_synced, catalog_lrclib_id = step_fetch_lyrics(
                video_id, duration,
                artist_override=args.artist,
                title_override=args.title,
            )

        if catalog_text and not existing_synced_kept:
            if catalog_synced:
                src = "lrclib_synced"
            else:
                # Distinguishing scrape vs lrclib plain is best-effort; both are plain text
                src = "lrclib_plain"
            candidates.append({
                "source": src,
                "text": catalog_text if not catalog_synced else _strip_lrc_to_plain(catalog_text),
                "synced": catalog_synced,
                "lrc_text": catalog_text if catalog_synced else "",
                "json_path": None,
                "lrclib_id": catalog_lrclib_id,
                "score": _score_lyric_candidate(
                    catalog_text if not catalog_synced else _strip_lrc_to_plain(catalog_text),
                    catalog_synced, duration, src,
                ),
            })
            log("lyrics", f"Catalog candidate: {src} score={candidates[-1]['score']:.0f} "
                          f"words={len(candidates[-1]['text'].split())}"
                          + (f" id={catalog_lrclib_id}" if catalog_lrclib_id else ""))

        if pasted_lyrics:
            candidates.append({
                "source": "user_paste",
                "text": pasted_lyrics,
                "synced": False,
                "lrc_text": "",
                "json_path": None,
                "score": _score_lyric_candidate(pasted_lyrics, False, duration, "user_paste"),
            })
            log("lyrics", f"Paste candidate: score={candidates[-1]['score']:.0f} "
                          f"words={len(pasted_lyrics.split())}")

        # Embedded yt-dlp subs already on disk (from download).
        # --force-whisper: skip embedded auto-captions so Whisper invent can run
        # when LRCLIB/karaoke/paste are empty (otherwise bad YT ASR locks forever).
        if args.force_whisper:
            log("lyrics", "force-whisper: skipping embedded auto-caption Stage 1 candidates")
        else:
            for emb in _collect_embedded_caption_candidates(tmp_dir, video_id, duration):
                candidates.append(emb)

        # Pick best Stage 1 candidate
        candidates = [c for c in candidates if c.get("score", -1) > 0]
        candidates.sort(key=lambda c: c["score"], reverse=True)
        if candidates:
            log("lyrics", "Stage 1 candidates (ranked):")
            for c in candidates:
                log("lyrics", f"  {c['source']:18s} score={c['score']:5.1f} "
                              f"synced={c['synced']} words={len(c['text'].split())}")
            best = candidates[0]
            lyric_source = best["source"]
            log("lyrics", f"Stage 1 winner: {lyric_source} (score={best['score']:.0f})")
        else:
            best = None
            log("lyrics", "Stage 1 empty — no catalog/paste/karaoke text found")

        # ── Stage 2: attach timing (Whisper invent only if Stage 1 empty) ──
        log("lyrics", "Stage 2: attach timing")

        if best and best.get("synced") and best.get("json_path"):
            # Already have timed JSON (karaoke captions / embedded)
            json_path = best["json_path"]
            lrc_text = "WHISPER_DONE"
            is_synced = True
            log("lyrics", f"Source: {lyric_source} (pre-timed)")

        elif best and best.get("synced") and best.get("lrc_text"):
            # Synced LRC from LRCLIB — quality-check, then save
            lrc_text = best["lrc_text"]
            is_synced = True
            if vocal_onset is not None:
                lrc_tag_re = re.compile(r"\[(?P<min>\d{1,3}):(?P<sec>\d{2}(?:\.\d{2,3})?)\]")
                lines_raw = []
                for raw_line in lrc_text.strip().split("\n"):
                    raw_line = raw_line.strip()
                    if not raw_line:
                        continue
                    matches = list(lrc_tag_re.finditer(raw_line))
                    if not matches:
                        continue
                    text_part = lrc_tag_re.sub("", raw_line).strip()
                    if not text_part:
                        continue
                    for m in matches:
                        mins = int(m.group("min"))
                        secs = float(m.group("sec"))
                        lines_raw.append((mins * 60 + secs, text_part))
                lines_raw.sort(key=lambda x: x[0])
                verdict, correction_offset = lrc_quality_check(lines_raw, duration, vocal_onset)
                if verdict == 'correct' and correction_offset is not None:
                    log("lyrics", f"Auto-correcting LRC timestamps by {correction_offset:+.1f}s")
                    lrc_text = correct_lrc_timestamps(lrc_text, correction_offset)
                elif verdict == 'fail':
                    # Keep catalog *text* but mark for Demucs+Whisper keep-text align
                    # (never demote to Whisper invent / approx).
                    log("lyrics",
                        "LRCLIB synced failed quality check — keeping text; "
                        "will force-align to Demucs vocals (keep-text)")
                else:
                    log("lyrics", "LRC quality check OK — using as-is (then keep-text align)")
            log("lyrics", f"Source: {lyric_source or 'lrclib_synced'}")

        elif best and best.get("text"):
            # Plain text (paste / LRCLIB plain / scrape) — hear → reconcile → force-align
            plain = best["text"]
            expected_gt_words = max(expected_gt_words, len(plain.split()))
            align_json = step_align_lyrics(
                video_id, plain, mp4_path, duration, tmp_dir,
                vocal_wav_path=(vocal_stem_path if (vocal_stem_path and os.path.exists(str(vocal_stem_path))) else None),
                audit=audit,
                whisper_model=args.whisper_model,
                strict=True,
            )
            if align_json:
                json_path = align_json
                lrc_text = "WHISPER_DONE"
                is_synced = True
                lyric_source = f"{best['source']}+force"
                log("lyrics", f"Source: {lyric_source}")
            else:
                approx = step_build_unsynced_lrc(plain, duration, onset=vocal_onset)
                if approx:
                    approx_path = step_save_lrc_json(
                        video_id, approx, duration, tmp_dir,
                        artist=args.artist or "", title=args.title or "",
                    )
                    if approx_path:
                        json_path = approx_path
                        lrc_text = "WHISPER_DONE"
                        is_synced = True
                        lyric_source = f"{best['source']}+approx"
                        log("lyrics", f"Source: {lyric_source}")

        # Last resort: invent words with Whisper when Stage 1 empty (or force-whisper
        # skipped embedded_subs and no catalog/paste/karaoke text won).
        if not json_path and lrc_text != "WHISPER_DONE" and (not lrc_text or not lrc_text.strip()):
            log("lyrics", "Stage 1 empty — Whisper invent (last resort)"
                          + (" [force-whisper]" if args.force_whisper else ""))
            log("lyrics", "Source: Whisper full transcription")
            whisper_audio = mp4_path
            whisper_stem = vocal_stem_path if (vocal_stem_path and os.path.exists(str(vocal_stem_path))) else None
            if isinstance(mp4_path, str) and mp4_path.endswith('-karaoke.mp4'):
                whisper_audio = os.path.join(tmp_dir, f"{video_id}-full-audio.wav")
                if not os.path.exists(whisper_audio):
                    run([
                        _YTDLP_BIN, "-f", "ba", "-x", "--audio-format", "wav",
                        "-o", whisper_audio, "--no-playlist",
                        *ytdlp_auth_args(),
                        f"https://www.youtube.com/watch?v={video_id}",
                    ], timeout=180)
                whisper_stem = None
            whisper_json = step_whisper_lyrics(
                video_id, whisper_audio, duration, tmp_dir,
                vocal_wav_path=whisper_stem,
                audit=audit,
                whisper_model=args.whisper_model,
            )
            if whisper_json:
                json_path = whisper_json
                lrc_text = "WHISPER_DONE"
                is_synced = True
                lyric_source = "whisper_invent"
            else:
                # Emergency: if Whisper dies (large-v3 OOM etc.), still try embedded captions
                log("lyrics", "Whisper invent failed — retrying embedded captions as last resort")
                emergency = _collect_embedded_caption_candidates(tmp_dir, video_id, duration)
                if emergency:
                    emergency.sort(key=lambda c: c.get("score", -1), reverse=True)
                    pick = emergency[0]
                    json_path = pick["json_path"]
                    lrc_text = "WHISPER_DONE"
                    is_synced = True
                    lyric_source = "embedded_subs"
                    log("lyrics", f"Recovered lyrics from {pick.get('caption_file')}")
                else:
                    log("lyrics", "No lyrics available. Rendering video without lyric overlay.")

        # Step 4: Build LRC from synced LRC text (not yet JSON)
        if lrc_text and not is_synced and json_path is None:
            align_json = step_align_lyrics(
                video_id, lrc_text, mp4_path, duration, tmp_dir,
                vocal_wav_path=(vocal_stem_path if (vocal_stem_path and os.path.exists(str(vocal_stem_path))) else None),
                audit=audit,
                whisper_model=args.whisper_model,
                strict=True,
            )
            if align_json:
                json_path = align_json
                lrc_text = "WHISPER_DONE"
                is_synced = True

        if lrc_text and lrc_text != "WHISPER_DONE" and json_path is None:
            save_mode = lyric_source or ("lrclib_synced" if is_synced else "")
            save_id = None
            if best:
                save_id = best.get("lrclib_id")
                if not save_mode:
                    save_mode = best.get("source") or ""
            json_path = step_save_lrc_json(
                video_id, lrc_text, duration, tmp_dir,
                artist=args.artist or "",
                title=args.title or "",
                align_mode=save_mode if save_mode.startswith("lrclib") else (save_mode or ""),
                lrclib_id=save_id if isinstance(save_id, int) else (
                    int(save_id) if save_id is not None else None
                ),
            )
            if _RMANIZE_LANG:
                try:
                    romanize_lrc_json(json_path, _RMANIZE_LANG)
                except RuntimeError as e:
                    log("romanize", f"Romanize skipped: {e}")

        # Stamp lrclibId / catalog source onto any produced JSON that is missing them.
        # Do NOT clobber reconcile+force|keep-text alignMode with raw lrclib_synced.
        if json_path and os.path.exists(json_path) and (lyric_source or (best and best.get("lrclib_id"))):
            try:
                with open(json_path, encoding="utf-8") as f:
                    stamped = json.load(f)
                changed = False
                mode = lyric_source or (best.get("source") if best else "") or ""
                cur_am = str(stamped.get("alignMode") or "")
                if mode.startswith("lrclib") and "keep-text" not in cur_am.lower():
                    if stamped.get("source") != mode.split("+")[0]:
                        stamped["source"] = mode.split("+")[0]
                        changed = True
                    # Only set alignMode to lrclib_* when not already force-aligned
                    if not cur_am or cur_am.startswith("lrclib"):
                        if stamped.get("alignMode") != mode:
                            stamped["alignMode"] = mode
                            changed = True
                elif mode.startswith("lrclib") and "keep-text" in cur_am.lower():
                    if not str(stamped.get("source") or "").startswith("lrclib"):
                        stamped["source"] = mode.split("+")[0]
                        changed = True
                rid = best.get("lrclib_id") if best else None
                if rid is not None and stamped.get("lrclibId") != int(rid):
                    stamped["lrclibId"] = int(rid)
                    changed = True
                if changed:
                    with open(json_path, "w", encoding="utf-8") as f:
                        json.dump(stamped, f, indent=2)
            except (json.JSONDecodeError, OSError, TypeError, ValueError):
                pass

        # Persist lrclibId into tags.json for sticky re-fetch
        if best and best.get("lrclib_id") and TAGS_PATH.exists():
            try:
                tags_data = json.loads(TAGS_PATH.read_text())
                for key in (f"{video_id}-karaoke", video_id):
                    entry = tags_data.get(key) or {}
                    entry["lrclibId"] = int(best["lrclib_id"])
                    if args.artist:
                        entry["artist"] = args.artist
                    if args.title:
                        entry["title"] = args.title
                    tags_data[key] = entry
                TAGS_PATH.write_text(json.dumps(tags_data, indent=2))
            except (json.JSONDecodeError, OSError, TypeError, ValueError):
                pass

        if lyric_source:
            log("lyrics", f"Final lyric source: {lyric_source}")

        # Canonicalize winner JSON next to the karaoke MP4 so step_register finds it.
        # Caption Stage 1 writes unique `{id}.{lang}.lrc.json` paths to avoid clobber;
        # register still expects `{id}-karaoke.lrc.json`.
        if json_path and os.path.exists(json_path):
            canonical = os.path.join(tmp_dir, f"{video_id}-karaoke.lrc.json")
            if os.path.abspath(json_path) != os.path.abspath(canonical):
                shutil.copy2(json_path, canonical)
                json_path = canonical
                log("lyrics", f"Canonicalized LRC JSON → {os.path.basename(canonical)}")
            if _RMANIZE_LANG:
                try:
                    romanize_lrc_json(json_path, _RMANIZE_LANG)
                except RuntimeError as e:
                    log("romanize", f"Romanize skipped: {e}")

        # ── Gold path: Demucs vocals + Whisper force-align keep-text ──
        # After any catalog text win, replace LRCLIB/proportional timings with
        # hear→reconcile→force unless already keep-text with healthy cues.
        if (
            json_path
            and os.path.exists(json_path)
            and not skip_auto_retime
            and not getattr(args, "skip_auto_retime", False)
        ):
            try:
                with open(json_path, encoding="utf-8") as f:
                    pre_align = json.load(f)
            except (json.JSONDecodeError, OSError):
                pre_align = {}
            am = str(pre_align.get("alignMode") or "").lower()
            src = (
                lyric_source
                or str(pre_align.get("source") or "")
                or (best.get("source") if best else "")
                or ""
            )
            already_gold = "keep-text" in am and not _lrc_json_timing_broken(pre_align, duration)
            catalog_win = _catalog_text_source(src) or (
                best and best.get("synced") and _catalog_text_source(best.get("source") or "lrclib_synced")
            )
            # Also force-align karaoke_captions / embedded pre-timed if timing broken
            timing_broken = _lrc_json_timing_broken(pre_align, duration)
            if already_gold:
                log("lyrics", "Skip auto keep-text align — already gold timing")
            elif catalog_win or timing_broken:
                log("lyrics",
                    f"Auto keep-text force-align "
                    f"(source={src or 'catalog'}, timing_broken={timing_broken})")
                # Ensure source stamp before align so provenance survives
                if catalog_win and not str(pre_align.get("source") or "").startswith("lrclib"):
                    if src.startswith("lrclib") or (best and best.get("lrclib_id")):
                        pre_align["source"] = "lrclib_synced" if (best and best.get("synced")) else (
                            src.split("+")[0] if src else "lrclib_synced"
                        )
                        try:
                            with open(json_path, "w", encoding="utf-8") as f:
                                json.dump(pre_align, f, indent=2, ensure_ascii=False)
                        except OSError:
                            pass
                stem = vocal_stem_path if (vocal_stem_path and os.path.exists(str(vocal_stem_path))) else None
                if not stem:
                    lib_stem = LIBRARY_KARAOKE_DIR / f"{video_id}-karaoke-vocals.wav"
                    if lib_stem.exists():
                        stem = str(lib_stem)
                ok_align, yld, detail = force_align_keep_text_file(
                    json_path,
                    video_id,
                    duration,
                    tmp_dir,
                    vocal_wav_path=stem,
                    mp4_path=mp4_path if isinstance(mp4_path, str) else None,
                    whisper_model=getattr(args, "whisper_model", None) or "large-v3",
                    language=getattr(args, "language", None) or _WHISPER_LANG,
                    min_yield=40.0,
                    preserve_text_source=True,
                )
                if ok_align:
                    lyric_source = f"{(src or 'catalog').split('+')[0]}+keep-text"
                    log("lyrics", f"Auto keep-text align OK: {detail}")
                    if audit:
                        audit.data["timing"] = "keep_text_force"
                        audit.data["alignYield"] = yld
                else:
                    log("lyrics",
                        f"Auto keep-text align failed ({detail}) — "
                        f"keeping catalog/onset timings; audit=catalog_fallback")
                    if audit:
                        audit.data["timing"] = "catalog_fallback"
                        audit.data["alignYield"] = yld
                    # Refuse to publish past-EOF catalog cues when align failed
                    try:
                        with open(json_path, encoding="utf-8") as f:
                            fallback = json.load(f)
                        if _lrc_json_timing_broken(fallback, duration):
                            log("lyrics",
                                "WARNING: catalog timings still broken after failed align — "
                                "clamping cues to duration")
                            _clamp_lrc_json_to_duration(fallback, duration)
                            with open(json_path, "w", encoding="utf-8") as f:
                                json.dump(fallback, f, indent=2, ensure_ascii=False)
                    except (json.JSONDecodeError, OSError):
                        pass
            else:
                log("lyrics", f"Skip auto keep-text align — source={src or '(none)'} not catalog text")

        # ── Pre-render quality gate ──
        # Load lyrics data for quality inspection
        lyrics_for_gate = {}
        if json_path and os.path.exists(json_path):
            try:
                with open(json_path, encoding="utf-8") as f:
                    lyrics_for_gate = json.load(f)
            except (json.JSONDecodeError, OSError):
                pass
        elif lrc_text and lrc_text == "WHISPER_DONE":
            # Whisper was used but json_path may be set internally
            whisper_json_path = os.path.join(tmp_dir, f"{video_id}-karaoke.lrc.json")
            if os.path.exists(whisper_json_path):
                try:
                    with open(whisper_json_path, encoding="utf-8") as f:
                        lyrics_for_gate = json.load(f)
                    if not json_path:
                        json_path = whisper_json_path
                except (json.JSONDecodeError, OSError):
                    pass

        # Determine if Whisper was used
        is_whisper_used = bool(
            lyric_source.endswith("+align")
            or lyric_source.endswith("+force")
            or lyric_source.endswith("+keep-text")
            or lyric_source == "whisper_invent"
            or args.force_whisper
            or (isinstance(lyrics_for_gate, dict) and (
                lyrics_for_gate.get("alignMode") == "reconcile+force"
                or "keep-text" in str(lyrics_for_gate.get("alignMode") or "")
            ))
        )
        # Determine chunk count from audit
        chunk_count = audit.data.get("chunkCount", 0)
        if chunk_count == 0 and is_whisper_used:
            chunk_count = 1

        gate_ok = pre_render_quality_gate(
            audit=audit,
            instrumental_path=instrumental_path or "",
            is_reprocess=bool(args.reprocess),
            mp4_path=mp4_path or "",
            lyrics_data=lyrics_for_gate,
            duration=duration,
            is_whisper_used=is_whisper_used,
            chunk_count=chunk_count,
            expected_word_count=expected_gt_words,
        )

        # ── Fast path: lyrics-only reprocess (skip Demucs + render) ──
        # If we're reprocessing and only the lyrics changed, we can skip the
        # expensive Demucs stem separation and video re-encode.  Just copy the
        # new LRC JSON into the library and exit — ~30 seconds instead of 8 min.
        # Skipped when --rebuild-audio (full fresh rebuild requested).
        if args.reprocess and not args.rebuild_audio and json_path and os.path.exists(json_path):
            karaoke_lib = LIBRARY_KARAOKE_DIR / f"{video_id}-karaoke.mp4"
            vocals_lib = LIBRARY_KARAOKE_DIR / f"{video_id}-karaoke-vocals.wav"
            source_lib = LIBRARY_KARAOKE_DIR / f"{video_id}.mp4"
            if karaoke_lib.exists() and vocals_lib.exists():
                dest_lrc = LIBRARY_KARAOKE_DIR / f"{video_id}-karaoke.lrc.json"
                if not gate_ok:
                    log("quality-gate", "Refusing lyrics-only overwrite — critical quality gates failed")
                    audit.record_step("render", ended_at=time.time(),
                                      metadata={"fast_path": "lyrics_only_blocked"})
                    audit_path = audit.write(str(LIBRARY_KARAOKE_DIR))
                    log("audit", f"Audit log written: {audit_path}")
                    if not args.no_cleanup:
                        shutil.rmtree(tmp_dir, ignore_errors=True)
                    log("complete", f"LYRICS_BLOCKED: quality gate refused overwrite for {video_id}")
                    sys.exit(2)
                # Explicit Re-Lyric: merge into named track (default sung) without
                # destroying tracks.english. Full-file rank guard only applies when
                # replacing a single-track / same-track English sheet.
                track_key = getattr(args, "lyrics_track", None) or "sung"
                dest_has_tracks = False
                try:
                    if dest_lrc.exists():
                        _ex = json.loads(dest_lrc.read_text(encoding="utf-8"))
                        dest_has_tracks = bool(_ex.get("tracks"))
                except (json.JSONDecodeError, OSError):
                    pass
                same_track_replace = track_key == "english" or (
                    not dest_has_tracks and track_key == "english"
                )
                if same_track_replace and not should_overwrite_lrc(
                    dest_lrc, Path(json_path), force=bool(args.force_overwrite_lyrics)
                ):
                    audit.record_step("render", ended_at=time.time(),
                                      metadata={"fast_path": "lyrics_only_kept_existing"})
                    audit_path = audit.write(str(LIBRARY_KARAOKE_DIR))
                    log("audit", f"Audit log written: {audit_path}")
                    if not args.no_cleanup:
                        shutil.rmtree(tmp_dir, ignore_errors=True)
                    log("complete", f"LYRICS_KEPT: existing LRC is better for {video_id}")
                    return
                if args.reprocess:
                    log("quality-gate", f"Re-Lyric — writing track '{track_key}' (preserving other tracks)")
                log("render", "All assets exist — lyrics-only update (skipping Demucs + re-encode)")
                publish_merged_lrc(
                    json_path,
                    dest_lrc,
                    track_key=track_key,
                    force=bool(args.force_overwrite_lyrics),
                    protect_english=True,
                    legacy_as="english",
                )
                log("library", f"Lyrics-only update → {dest_lrc}")
                try:
                    write_bundle_manifest(video_id, LIBRARY_KARAOKE_DIR)
                except Exception as e:  # noqa: BLE001
                    log("library", f"Bundle manifest warning: {e}")
                # Update tags.json (minimal — just refresh existing entry)
                if TAGS_PATH.exists():
                    try:
                        tags_data = json.loads(TAGS_PATH.read_text())
                    except (json.JSONDecodeError, KeyError):
                        tags_data = {}
                else:
                    tags_data = {}
                existing = tags_data.get(f"{video_id}-karaoke", {})
                existing["tag"] = existing.get("tag", "karaoke")
                if args.artist:
                    existing["artist"] = args.artist
                if args.title:
                    existing["title"] = args.title
                tags_data[f"{video_id}-karaoke"] = existing
                TAGS_PATH.write_text(json.dumps(tags_data, indent=2))
                # Write audit log
                audit.record_step("render", ended_at=time.time(), metadata={"fast_path": "lyrics_only"})
                audit_path = audit.write(str(LIBRARY_KARAOKE_DIR))
                log("audit", f"Audit log written: {audit_path}")
                if not args.no_cleanup:
                    shutil.rmtree(tmp_dir, ignore_errors=True)
                log("complete", f"Lyrics updated: {video_id}-karaoke.lrc.json (lyrics-only, no re-encode)")
                return

        # Step 4b: Re-encode (video from source + instrumental audio, no subtitle burn)
        # Lyrics-only reprocess (no --rebuild-audio) never touches the karaoke MP4 audio.
        if args.reprocess and not args.rebuild_audio:
            karaoke_lib = LIBRARY_KARAOKE_DIR / f"{video_id}-karaoke.mp4"
            if karaoke_lib.exists():
                log("render", "Reprocess without --rebuild-audio — skipping Demucs/re-encode")
                if json_path and os.path.exists(json_path) and gate_ok:
                    dest_lrc = LIBRARY_KARAOKE_DIR / f"{video_id}-karaoke.lrc.json"
                    track_key = getattr(args, "lyrics_track", None) or "sung"
                    published = publish_merged_lrc(
                        json_path,
                        dest_lrc,
                        track_key=track_key,
                        force=bool(args.force_overwrite_lyrics),
                        protect_english=True,
                        legacy_as="english",
                    )
                    if published:
                        log("library", f"Lyrics-only update → {dest_lrc}")
                        try:
                            write_bundle_manifest(video_id, LIBRARY_KARAOKE_DIR)
                        except Exception as e:  # noqa: BLE001
                            log("library", f"Bundle manifest warning: {e}")
                    else:
                        log("library", "Kept existing LRC (new result not better / synced sticky)")
                elif not gate_ok:
                    log("quality-gate", "Skipped LRC write — quality gates failed")
                    log("complete", f"LYRICS_BLOCKED: quality gate refused overwrite for {video_id}")
                    sys.exit(2)
                audit.record_step("render", ended_at=time.time(),
                                  metadata={"fast_path": "lyrics_only_no_rebuild_audio"})
                audit_path = audit.write(str(LIBRARY_KARAOKE_DIR))
                log("audit", f"Audit log written: {audit_path}")
                if not args.no_cleanup:
                    shutil.rmtree(tmp_dir, ignore_errors=True)
                log("complete", f"Reprocess complete (lyrics-only, audio untouched): {video_id}")
                return

        log("render", "Muxing instrumental onto video stream (-c:v copy, audio AAC only)")
        karaoke_mp4 = os.path.join(tmp_dir, f"{video_id}-karaoke.mp4")

        if args.reprocess and instrumental_path is None:
            # Fallback if rebuild path didn't already Demucs (should be rare)
            log("render", "Downloading original video for fresh instrumental extraction")
            fresh_dl = os.path.join(tmp_dir, f"{video_id}-fresh.mp4")
            run([
                _YTDLP_BIN, "-f", "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
                "--merge-output-format", "mp4",
                "-o", fresh_dl, "--no-playlist",
                *ytdlp_auth_args(),
                f"https://www.youtube.com/watch?v={video_id}",
            ], timeout=300)
            # yt-dlp sometimes appends the actual container extension even with -o
            if not os.path.exists(fresh_dl):
                import glob as _glob
                candidates = _glob.glob(os.path.join(tmp_dir, f"{video_id}-fresh.*"))
                if candidates:
                    fresh_dl = candidates[0]
                    log("render", f"Found fresh download: {os.path.basename(fresh_dl)}")
            instrumental_tmp, vocal_tmp = step_stem_separation(video_id, fresh_dl, tmp_dir)
            instrumental_path = instrumental_tmp
            if vocal_tmp:
                vocal_stem_path = vocal_tmp
            karaoke_mp4_src = fresh_dl
            audit.set_demucs_model("htdemucs_ft")
            audit.record_step("demucs", ended_at=time.time(),
                              metadata={"model": "htdemucs_ft", "source": "fresh_download"})

        # Never mux onto a degraded karaoke MP4 — require a non-karaoke source
        if not karaoke_mp4_src or karaoke_mp4_src.endswith("-karaoke.mp4"):
            fatal("Refusing to rebuild from existing karaoke MP4 — need fresh original video")

        cmd = [
            _FFMPEG_BIN, "-y",
            "-i", karaoke_mp4_src,
            "-i", instrumental_path,
            "-map", "0:v", "-c:v", "copy",
            "-map", "1:a",
            "-c:a", "aac",
            "-ar", "44100",
            "-b:a", "192k",
            "-af", "volume=-1dB",
            "-movflags", "+faststart",
            "-shortest",
            karaoke_mp4,
        ]
        run(cmd, timeout=600)

        if not os.path.exists(karaoke_mp4) or os.path.getsize(karaoke_mp4) < 10000:
            fatal("FFmpeg did not produce a valid output file")

        output_size_mb = os.path.getsize(karaoke_mp4) / (1024 * 1024)
        log("render", f"Karaoke video ready: {karaoke_mp4} ({output_size_mb:.1f} MB)")

        step_register(
            video_id, karaoke_mp4, mp4_path, duration,
            artist_override=args.artist,
            title_override=args.title,
            vocals_path=vocal_stem_path,
            instrumental_path=instrumental_path,
            force_overwrite_lyrics=bool(args.force_overwrite_lyrics),
            lyrics_track=getattr(args, "lyrics_track", None) or "sung",
        )

        # ── Write audit log ──
        audit.record_step("render", ended_at=time.time())
        audit_path = audit.write(str(LIBRARY_KARAOKE_DIR))
        log("audit", f"Audit log written: {audit_path}")

        # Preserve fresh source for future reprocessing.
        # Overwrite when rebuilding, missing, or existing file fails integrity
        # (e.g. empty mux with 0 streams left behind by an older download).
        source_mp4_dest = LIBRARY_KARAOKE_DIR / f"{video_id}.mp4"
        if mp4_path and os.path.exists(mp4_path) and not mp4_path.endswith('-karaoke.mp4'):
            need_preserve = args.rebuild_audio or not source_mp4_dest.exists()
            if source_mp4_dest.exists() and not need_preserve:
                ok_src, detail_src = verify_downloaded_video(str(source_mp4_dest))
                if not ok_src:
                    log("library", f"Existing preserved source bad ({detail_src}) — replacing")
                    quarantine_bad_download(str(source_mp4_dest), detail_src)
                    need_preserve = True
            if need_preserve:
                shutil.copy2(mp4_path, source_mp4_dest)
                log("library", f"Preserved source video → {source_mp4_dest}")

        # Always keep instrumental WAV in sync with the muxed karaoke audio
        inst_dest = LIBRARY_KARAOKE_DIR / f"{video_id}-instrumental.wav"
        if instrumental_path and os.path.exists(instrumental_path) and os.path.getsize(instrumental_path) > 10000:
            if args.rebuild_audio or not inst_dest.exists():
                shutil.copy2(instrumental_path, inst_dest)
                log("library", f"Preserved instrumental WAV → {inst_dest}")
            else:
                # Keep sidecar aligned with latest Demucs when we just ran it
                shutil.copy2(instrumental_path, inst_dest)

        if not args.no_cleanup:
            log("cleanup", "Removing temp directory ...")
            shutil.rmtree(tmp_dir, ignore_errors=True)
        else:
            log("cleanup", f"Intermediate files kept in {tmp_dir}")

        log("complete", f"Karaoke video ready: {video_id}-karaoke.mp4")
    except Exception as e:
        log("error", str(e))
        if not args.no_cleanup:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
