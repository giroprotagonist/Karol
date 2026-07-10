#!/usr/bin/env python3
"""
Download all videos from a YouTube playlist with embedded thumbnails + metadata.
Uses your Chrome browser session for auth (no separate login needed).

Usage: python3 scripts/download-youtube-playlist.py

Env vars:
  DESKREEN_YT_MAX_HEIGHT   Max video height (default 720, use 1080 for HD)
  DESKREEN_YT_AUDIO_ONLY   Set to "1" for audio-only MP3
  DESKREEN_YT_PLAYLIST     Override playlist URL
"""

import json
import os
import subprocess
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.join(SCRIPT_DIR, "..")

ARCHIVE_FILE = os.path.join(PROJECT_ROOT, ".deskreen", "youtube-download-archive.txt")
OUTPUT_DIR = os.path.join(PROJECT_ROOT, ".deskreen", "youtube-downloads")

PLAYLIST_URL = os.environ.get(
    "DESKREEN_YT_PLAYLIST",
    "https://www.youtube.com/playlist?list=PLGKtSCMf0XtO3YKUexSYy4sG1K1Aul942",
)

os.makedirs(OUTPUT_DIR, exist_ok=True)

# ── Auth source ────────────────────────────────────────────────────

COOKIES_ARG = ["--cookies-from-browser", "chrome"]
print("🍪 Using Chrome browser session for YouTube auth")

# ── Resolution ─────────────────────────────────────────────────────

MAX_HEIGHT = os.environ.get("DESKREEN_YT_MAX_HEIGHT", "720")
AUDIO_ONLY = os.environ.get("DESKREEN_YT_AUDIO_ONLY", "") == "1"

if AUDIO_ONLY:
    FMT = "bestaudio/best"
else:
    FMT = f"bestvideo[height<={MAX_HEIGHT}]+bestaudio/best[height<={MAX_HEIGHT}]"

# ── Count videos ───────────────────────────────────────────────────

print("\n📋 Counting playlist videos...")
list_result = subprocess.run(
    ["yt-dlp"] + COOKIES_ARG + ["--remote-components", "ejs:github"] +
    ["--flat-playlist", "--print", "%(id)s", PLAYLIST_URL],
    capture_output=True, text=True, timeout=120,
)

video_ids = [line.strip() for line in list_result.stdout.strip().split("\n") if line.strip()]
total = len(video_ids)

if total == 0:
    print("   ⚠️  No videos with cookies, trying without auth...")
    list_result2 = subprocess.run(
        ["yt-dlp", "--remote-components", "ejs:github",
         "--flat-playlist", "--print", "%(id)s", PLAYLIST_URL],
        capture_output=True, text=True, timeout=120,
    )
    video_ids = [line.strip() for line in list_result2.stdout.strip().split("\n") if line.strip()]
    total = len(video_ids)
    COOKIES_ARG = []
    print("   ⚠️  Proceeding without auth (may hit rate limits)")

if total == 0:
    print("❌ No videos found in playlist.")
    sys.exit(1)

print(f"   ✅ {total} videos found\n")
print(f"🎬 Format: {'audio-only MP3 192k' if AUDIO_ONLY else f'{MAX_HEIGHT}p MP4 + embedded thumbnails + metadata + subs'}")
print(f"📁 Output:  {OUTPUT_DIR}")
print(f"💾 Archive: {ARCHIVE_FILE}\n")

# ── yt-dlp base command ────────────────────────────────────────────

cmd_base = ["yt-dlp"] + COOKIES_ARG + [
    "--remote-components", "ejs:github",
    "--format", FMT,
    "--download-archive", ARCHIVE_FILE,
    "--output", os.path.join(OUTPUT_DIR, "%(title)s.%(ext)s"),
    "--embed-metadata",
    "--embed-thumbnail",
    "--embed-subs",
    "--sub-langs", "all",
    "--abort-on-unavailable-fragment",
    "--no-playlist",
    "--socket-timeout", "30",
    "--retries", "5",
    "--fragment-retries", "5",
    "--concurrent-fragments", "3",
]

if AUDIO_ONLY:
    cmd_base += ["--extract-audio", "--audio-format", "mp3", "--audio-quality", "192k"]
else:
    cmd_base += ["--merge-output-format", "mp4"]

# ── Download loop ──────────────────────────────────────────────────

start_time = time.time()
success = 0
skipped = 0
failed = 0
failed_videos = []

for i, vid in enumerate(video_ids):
    url = f"https://www.youtube.com/watch?v={vid}"
    num = i + 1
    print(f"[{num}/{total}] {url}", end="", flush=True)

    try:
        result = subprocess.run(
            cmd_base + [url],
            capture_output=True, text=True, timeout=600,
        )
        combined = result.stdout + result.stderr
        if result.returncode == 0 or "already exists" in combined.lower() or "has already been recorded" in combined:
            if "has already been recorded" in combined or "already exists" in combined.lower():
                skipped += 1
                print(" ⏭️  skip")
            else:
                success += 1
                for line in combined.split("\n"):
                    if "[download] Destination:" in line:
                        fname = line.split("Destination:", 1)[1].strip()
                        print(f" ✅  {os.path.basename(fname)[:60]}")
                        break
                else:
                    print(" ✅")
        else:
            failed += 1
            err = result.stderr.strip()[-200:] if result.stderr else "unknown error"
            failed_videos.append({"url": url, "id": vid, "error": err})
            print(f" ❌  {err[:80]}")
    except subprocess.TimeoutExpired:
        failed += 1
        failed_videos.append({"url": url, "id": vid, "error": "timeout (10 min)"})
        print(" ❌ TIMEOUT")

    if num % 20 == 0 or num == total:
        elapsed = time.time() - start_time
        done = success + skipped + failed
        rate = done / elapsed * 60 if elapsed > 0 else 0
        remaining = total - done
        eta_min = remaining / rate if rate > 0 else 0
        print(f"  ── {done}/{total} done | {success} ok | {skipped} skip | {failed} fail | ~{rate:.0f}/min | ETA {eta_min:.0f}min")

# ── Summary ────────────────────────────────────────────────────────

elapsed = time.time() - start_time
print(f"\n{'='*60}")
print(f"✅ Done in {elapsed/60:.1f} minutes")
print(f"   Downloaded: {success}")
print(f"   Skipped:    {skipped}")
print(f"   Failed:     {failed}")
print(f"   Output:     {OUTPUT_DIR}")

if failed_videos:
    failed_path = os.path.join(OUTPUT_DIR, "failed.json")
    with open(failed_path, "w") as f:
        json.dump(failed_videos, f, indent=2)
    print(f"\n❌ {len(failed_videos)} failures saved to: {failed_path}")
    for t in failed_videos[:10]:
        print(f"   - {t['url']}: {t['error'][:80]}")
    if len(failed_videos) > 10:
        print(f"   ... and {len(failed_videos) - 10} more")

# Disk usage
total_bytes = 0
total_files = 0
for root, dirs, files in os.walk(OUTPUT_DIR):
    for f in files:
        fp = os.path.join(root, f)
        total_bytes += os.path.getsize(fp)
        total_files += 1
print(f"\n💾 Disk: {total_bytes/1024/1024/1024:.1f} GB / {total_files} files")
