#!/usr/bin/env python3
"""
Karaoke video maker pipeline.

Takes a YouTube URL, downloads the video, removes lead vocals with Demucs,
fetches synced lyrics from LRCLIB, and renders a karaoke video with timed
lyric overlay into the Deskreen library.

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
from pathlib import Path
from typing import Optional
from urllib.parse import quote

import requests  # type: ignore[import-untyped]

# ── Paths ────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
EXTERNAL_DRIVE = Path('/Volumes/maxone')
LIBRARY_DIR = EXTERNAL_DRIVE / 'Deskreen'
LIBRARY_KARAOKE_DIR = LIBRARY_DIR / 'karaoke'
TAGS_PATH = LIBRARY_DIR / 'tags.json'
ARCHIVE_PATH = LIBRARY_DIR / 'youtube-download-archive.txt'
TEMP_BASE = PROJECT_ROOT / '.deskreen' / 'karaoke-temp'  # internal SSD for fast transcoding
LRCLIB_API = "https://lrclib.net/api/get"
# ffmpeg-full (keg-only on macOS) has drawtext/libfreetype compiled in
# Regular Homebrew ffmpeg does not. Try full first, fall back to Homebrew.
_FFMPEG_BIN = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg" if os.path.exists("/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg") else "/opt/homebrew/bin/ffmpeg"
_FFMPEG_BIN = shutil.which(_FFMPEG_BIN) or shutil.which("ffmpeg") or "ffmpeg"
_FFPROBE_BIN = "/opt/homebrew/bin/ffprobe"
if not shutil.which(_FFPROBE_BIN):
    _FFPROBE_BIN = shutil.which("ffprobe") or "ffprobe"
_YTDLP_BIN = "/opt/homebrew/bin/yt-dlp"

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


def run(cmd: list[str], timeout: int = 600, check: bool = True) -> subprocess.CompletedProcess:
    """Run a command and return CompletedProcess. Raises on failure if check=True."""
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        if check:
            fatal(f"Command timed out ({timeout}s): {' '.join(cmd[:4])} ...")
        raise
    if check and result.returncode != 0:
        stderr_tail = result.stderr.strip()[-300:] if result.stderr else "(no stderr)"
        fatal(f"Command failed (exit {result.returncode}): {' '.join(cmd[:4])} ...\n{stderr_tail}")
    return result


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


# ── Pipeline Steps ───────────────────────────────────────────────────


def step_download(video_id: str, out_dir: str) -> str:
    """Download the YouTube video with yt-dlp. Returns path to mp4."""
    log("download", f"Downloading video {video_id} ...")
    mp4_candidate = os.path.join(out_dir, f"{video_id}.mp4")
    if os.path.exists(mp4_candidate) and os.path.getsize(mp4_candidate) > 10000:
        log("download", "MP4 already exists, skipping download")
        return mp4_candidate

    cmd = [
        _YTDLP_BIN,
        "-f", "b[height<=1080]",
        "--merge-output-format", "mp4",
        "--write-info-json",
        "--write-thumbnail",
        "--write-subs", "--sub-langs", "all,-live_chat",
        "-o", os.path.join(out_dir, "%(id)s.%(ext)s"),
        "--no-playlist",
        f"https://www.youtube.com/watch?v={video_id}",
    ]
    run(cmd, timeout=300)

    # Find the downloaded mp4 (yt-dlp might add format suffix)
    for f in Path(out_dir).glob(f"{video_id}*.mp4"):
        if os.path.getsize(f) > 10000:
            expected = Path(out_dir) / f"{video_id}.mp4"
            if f != expected:
                f.rename(expected)
            log("download", f"Downloaded: {expected}")
            return str(expected)

    fatal(f"No MP4 found after download in {out_dir}")


def step_stem_separation(video_id: str, mp4_path: str, tmp_dir: str) -> str:
    """Run Demucs stem separation. Returns path to instrumental audio (mixed stems)."""
    log("demucs", "Running Demucs stem separation (this may take 2-5 minutes) ...")

    demucs_out = Path(tmp_dir) / "demucs"
    demucs_out.mkdir(parents=True, exist_ok=True)

    instrumental_path = os.path.join(tmp_dir, f"{video_id}-instrumental.wav")
    if os.path.exists(instrumental_path) and os.path.getsize(instrumental_path) > 100000:
        log("demucs", "Instrumental already exists, skipping separation")
        return instrumental_path

    # Demucs outputs to a subdirectory named after the model
    cmd_demucs = [
        sys.executable, "-m", "demucs",
        "--two-stems", "vocals",  # vocals + no_vocals (instrumental)
        "-o", str(demucs_out),
        "--filename", "{stem}.{ext}",
        mp4_path,
    ]
    run(cmd_demucs, timeout=600)

    # Demucs --two-stems vocals produces:
    # {out_dir}/htdemucs/{basename}/vocals.wav + no_vocals.wav
    base = Path(mp4_path).stem
    # Demucs may strip the extension itself or use the full stem
    search_dir = demucs_out / "htdemucs"
    for candidate in search_dir.glob(f"**/no_vocals.*"):
        shutil.move(str(candidate), instrumental_path)
        break
    else:
        # Fallback: look for any no_vocals file
        for candidate in demucs_out.rglob("no_vocals.*"):
            shutil.move(str(candidate), instrumental_path)
            break
        else:
            fatal("Demucs completed but no instrumental output found")

    # Clean up demucs output directory
    shutil.rmtree(demucs_out, ignore_errors=True)

    log("demucs", f"Instrumental audio saved: {instrumental_path}")
    return instrumental_path


def _try_lrclib(params: dict, log_prefix: str = "lyrics") -> tuple[str, bool]:
    """Make one LRCLIB API request and return (lrc_text, is_synced) or ("", False)."""
    qs = "&".join(f"{k}={quote(str(v))}" for k, v in params.items())
    url = f"{LRCLIB_API}?{qs}"
    try:
        resp = requests.get(url, timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("syncedLyrics"):
                log(log_prefix, "Got synced (LRC) lyrics from LRCLIB")
                return data["syncedLyrics"], True
            elif data.get("plainLyrics"):
                log(log_prefix, "Got plain (unsynced) lyrics from LRCLIB, will approximate timing")
                return data["plainLyrics"], False
    except (requests.RequestException, json.JSONDecodeError) as e:
        log(log_prefix, f"LRCLIB request failed: {e}")
    return "", False


def step_fetch_lyrics(
    video_id: str,
    duration: float,
    artist_override: Optional[str] = None,
    title_override: Optional[str] = None,
) -> tuple[str, bool]:
    """Fetch synced lyrics from LRCLIB.

    Tries multiple search strategies in order:
    1. Artist + title + duration (most precise)
    2. Artist + title (without duration — tolerant to timing differences)
    3. Title only (without duration — broadest search)
    Returns (lrc_text, is_synced).
    """
    log("lyrics", "Fetching synced lyrics from LRCLIB ...")

    artist: Optional[str] = artist_override or None
    title: Optional[str] = title_override or None

    # Resolve artist/title from info.json if not provided
    if not artist or not title:
        info_path = Path(LIBRARY_KARAOKE_DIR) / f"{video_id}.info.json"
        if not info_path.exists():
            info_path = None
            # Check in the temp/download dir
            for d in [TEMP_BASE / video_id, Path(".deskreen/youtube-downloads")]:
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
                    title = t.strip()
            except (json.JSONDecodeError, KeyError):
                pass

    # Check tags.json for saved metadata
    if TAGS_PATH.exists() and (not artist or not title):
        try:
            tags = json.loads(TAGS_PATH.read_text())
            entry = tags.get(video_id, {})
            if not artist:
                artist = entry.get("artist") or None
            if not title:
                title = entry.get("title") or None
        except (json.JSONDecodeError, KeyError):
            pass

    # Strategy 1: Artist + title + exact duration
    if artist and title:
        lrc, synced = _try_lrclib({
            "artist_name": artist,
            "track_name": title,
            "duration": str(int(duration)),
        })
        if lrc:
            return lrc, synced

    # Strategy 2: Artist + title (no duration — tolerant)
    if artist and title:
        lrc, synced = _try_lrclib({
            "artist_name": artist,
            "track_name": title,
        })
        if lrc:
            return lrc, synced

    # Strategy 3: Title only (no duration — broad search)
    if title:
        lrc, synced = _try_lrclib({
            "track_name": title,
            "duration": str(int(duration)),
        })
        if lrc:
            return lrc, synced

        lrc, synced = _try_lrclib({
            "track_name": title,
        })
        if lrc:
            return lrc, synced

    log("lyrics", "No lyrics found on LRCLIB, will attempt to use embedded subtitles ...")
    return "", False


def step_build_unsynced_lrc(plain_lyrics: str, duration: float) -> str:
    """Convert plain unsynced lyrics to approximate LRC by dividing evenly."""
    lines = [line.strip() for line in plain_lyrics.strip().split("\n") if line.strip()]
    if not lines:
        return ""

    interval = duration / len(lines)
    lrc_lines = []
    for i, line in enumerate(lines):
        ts = i * interval
        mins = int(ts // 60)
        secs = ts % 60
        lrc_lines.append(f"[{mins:02d}:{secs:05.2f}]{line}")

    log("lyrics", f"Built {len(lrc_lines)} approximate LRC lines from plain lyrics")
    return "\n".join(lrc_lines)


def step_save_lrc_json(
    video_id: str,
    lrc_text: str,
    duration: float,
    tmp_dir: str,
    artist: str = "",
    title: str = "",
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

    lrc_json = {
        "videoId": video_id,
        "title": title,
        "artist": artist,
        "duration": duration,
        "lines": timing_data,
    }

    json_path = os.path.join(tmp_dir, f"{video_id}-karaoke.lrc.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(lrc_json, f, indent=2)

    log("lrc-json", f"Generated LRC JSON with {len(timing_data)} lines → {json_path}")
    return json_path


def step_render(
    video_id: str,
    mp4_path: str,
    instrumental_path: str,
    lrc_text: str,
    duration: float,
    tmp_dir: str,
    no_cleanup: bool = False,
) -> str:
    """Render the karaoke video with FFmpeg using ASS subtitle burn-in."""
    log("render", "Rendering karaoke video with FFmpeg ...")

    output_path = os.path.join(tmp_dir, f"{video_id}-karaoke.mp4")

    if os.path.exists(output_path) and os.path.getsize(output_path) > 10000:
        log("render", "Karaoke MP4 already exists, skipping render")
        return output_path

    # Write LRC to temp file
    lrc_tmp = os.path.join(tmp_dir, "lyrics.lrc")
    with open(lrc_tmp, "w") as f:
        f.write(lrc_text)

    # Get video dimensions for subtitle positioning
    width, height = 1280, 720
    try:
        probe = run(
            [_FFPROBE_BIN, "-v", "quiet", "-print_format", "json",
             "-show_entries", "stream=width,height", mp4_path],
            timeout=15,
        )
        import json
        info = json.loads(probe.stdout)
        for s in info.get("streams", []):
            if s.get("width") and s.get("height"):
                width = s["width"]
                height = s["height"]
                break
    except Exception:
        pass

    # Generate ASS subtitle file
    ass_path = os.path.join(tmp_dir, "lyrics.ass")
    render_script = SCRIPT_DIR / "karaoke-render-lrc.py"
    run(
        [
            sys.executable, str(render_script),
            "--lrc", lrc_tmp,
            "--duration", str(duration),
            "--ass", ass_path,
            "--width", str(width),
            "--height", str(height),
        ],
        timeout=30,
    )

    if not os.path.exists(ass_path) or os.path.getsize(ass_path) < 50:
        fatal("Failed to generate ASS subtitle file")

    # subtitles filter with absolute path (FFmpeg needs absolute path in subtitles filter)
    ass_abs = os.path.abspath(ass_path)
    subtitles_filter = f"subtitles='{ass_abs}'"

    cmd = [
        _FFMPEG_BIN, "-y",
        "-i", mp4_path,
        "-i", instrumental_path,
        "-vf", subtitles_filter,
        "-map", "0:v",
        "-map", "1:a",
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "192k",
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


def step_register(
    video_id: str,
    karaoke_mp4: str,
    mp4_path: str,
    duration: float,
    artist_override: Optional[str] = None,
    title_override: Optional[str] = None,
) -> None:
    """Register the karaoke video in the Deskreen library.

    Moves files into .deskreen/library/karaoke/ and updates tags.json.
    """
    log("library", "Registering in Deskreen library ...")

    karaoke_dir = LIBRARY_KARAOKE_DIR
    karaoke_dir.mkdir(parents=True, exist_ok=True)

    # Move karaoke mp4
    dest_mp4 = karaoke_dir / f"{video_id}-karaoke.mp4"
    shutil.move(karaoke_mp4, dest_mp4)
    log("library", f"Moved karaoke MP4 → {dest_mp4}")

    # Copy .lrc.json if it exists (for real-time overlay on tablet)
    src_lrc_json = Path(karaoke_mp4).parent / f"{video_id}-karaoke.lrc.json"
    if src_lrc_json.exists():
        dest_lrc_json = karaoke_dir / f"{video_id}-karaoke.lrc.json"
        shutil.copy2(src_lrc_json, dest_lrc_json)
        log("library", f"Copied LRC JSON → {dest_lrc_json}")

    # Copy info.json from the download if it exists
    src_info = Path(mp4_path).with_suffix(".info.json")
    if src_info.exists():
        dest_info = karaoke_dir / f"{video_id}-karaoke.info.json"
        shutil.copy2(src_info, dest_info)

    # Copy thumbnail if it exists
    for ext in [".jpg", ".webp", ".png"]:
        src_thumb = Path(mp4_path).with_suffix(ext)
        if src_thumb.exists():
            dest_thumb = karaoke_dir / f"{video_id}-karaoke{ext}"
            shutil.copy2(src_thumb, dest_thumb)
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
        "source": existing.get("source", "karaoke-maker"),
        "duration": duration,
    }

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
    parser.add_argument("--dry-run", action="store_true",
                       help="Show what would be done without executing")
    args = parser.parse_args()

    video_id = extract_video_id(args.url)
    log("start", f"Processing video: {video_id}")
    if args.artist:
        log("start", f"Artist override: {args.artist}")
    if args.title:
        log("start", f"Title override: {args.title}")

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

    # Check demucs is importable
    try:
        import demucs  # noqa: F401
    except ImportError:
        fatal("demucs not installed. Run: pip install demucs")

    # ── Setup temp directory ──
    tmp_dir = os.path.join(TEMP_BASE, video_id)
    os.makedirs(tmp_dir, exist_ok=True)

    try:
        # Step 1: Download
        mp4_path = step_download(video_id, tmp_dir)
        duration = get_video_duration(mp4_path)
        log("download", f"Video duration: {duration:.0f}s")

        if duration > 600:
            log("warn", f"Song is {duration/60:.0f} minutes. Processing will take longer.")

        # Step 2: Stem separation
        instrumental_path = step_stem_separation(video_id, mp4_path, tmp_dir)

        # Step 3: Fetch lyrics
        lrc_text, is_synced = step_fetch_lyrics(
            video_id, duration,
            artist_override=args.artist,
            title_override=args.title,
        )

        if not lrc_text or lrc_text.strip() == "":
            # Last attempt: check if subtitles were downloaded
            sub_path = os.path.join(tmp_dir, f"{video_id}.en.vtt")
            if os.path.exists(sub_path):
                log("lyrics", "Using embedded English subtitles as fallback")
                with open(sub_path) as f:
                    lrc_text = f.read()
            else:
                log("lyrics", "No lyrics available. Rendering video without lyric overlay.")

        # Step 4: Render (skip if no lyrics or render with unsynced timing)
        if lrc_text and not is_synced:
            # Plain lyrics from LRCLIB — build approximate LRC
            lrc_text = step_build_unsynced_lrc(lrc_text, duration)

        # Step 4.5: Generate .lrc.json for real-time overlay (from synced lyrics)
        if lrc_text and is_synced:
            step_save_lrc_json(
                video_id, lrc_text, duration, tmp_dir,
                artist=args.artist or "",
                title=args.title or "",
            )

        if lrc_text:
            karaoke_mp4 = step_render(
                video_id, mp4_path, instrumental_path,
                lrc_text, duration, tmp_dir, args.no_cleanup,
            )
        else:
            # No lyrics at all — just mux instrumental audio with original video
            log("render", "No lyrics found. Muxing instrumental audio into original video.")
            karaoke_mp4 = os.path.join(tmp_dir, f"{video_id}-karaoke.mp4")
            cmd = [
                _FFMPEG_BIN, "-y",
                "-i", mp4_path,
                "-i", instrumental_path,
                "-map", "0:v",
                "-map", "1:a",
                "-c:v", "copy",
                "-c:a", "aac",
                "-b:a", "192k",
                "-movflags", "+faststart",
                "-shortest",
                karaoke_mp4,
            ]
            run(cmd, timeout=600)

        # Step 5: Register in library
        step_register(
            video_id, karaoke_mp4, mp4_path, duration,
            artist_override=args.artist,
            title_override=args.title,
        )

        # ── Cleanup ──
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
