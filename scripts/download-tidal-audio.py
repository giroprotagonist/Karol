#!/usr/bin/env python3
"""
Download all audio tracks from a Tidal playlist using tidal-dl internals.
Uses saved tidalapi session for authentication.

Usage: python3 scripts/download-tidal-audio.py
"""

import json
import os
import sys
import time
import shutil

import tidal_dl
from tidal_dl import TIDAL_API, SETTINGS, TOKEN, apiKey
from tidal_dl.enums import AudioQuality

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "..", ".deskreen", "tidal-exports", "audio")
TRACKS_JSON = os.path.join(SCRIPT_DIR, "..", ".deskreen", "tidal-exports", "playlist_tracks.json")
SESSION_FILE = os.path.join(SCRIPT_DIR, "..", ".deskreen", "tidal-exports", "tidal-session.json")
FAILED_JSON = os.path.join(OUTPUT_DIR, "failed.json")

os.makedirs(OUTPUT_DIR, exist_ok=True)

# --- Load data ---
with open(SESSION_FILE, "r") as f:
    session_data = json.load(f)

with open(TRACKS_JSON, "r") as f:
    playlist_data = json.load(f)

tracks = playlist_data.get("tracks", [])
total = len(tracks)

# --- Configure tidal-dl ---
# Use TV API key (index 3) - supports HiFi/Master
SETTINGS.apiKeyIndex = 3
TIDAL_API.apiKey = apiKey.getItem(3)
print(f"API key: {TIDAL_API.apiKey['platform']} - {TIDAL_API.apiKey['formats']}")

SETTINGS.audioQuality = AudioQuality.HiFi
SETTINGS.downloadPath = OUTPUT_DIR
SETTINGS.checkExist = True
SETTINGS.saveCovers = True
SETTINGS.multiThread = False

# --- Authenticate ---
print("🔐 Logging in with saved access token...")
TIDAL_API.loginByAccessToken(session_data["access_token"])
print(f"   Country: {TIDAL_API.key.countryCode} | User ID: {TIDAL_API.key.userId}")

print(f"\n🎵 Downloading {total} tracks from \"{playlist_data['playlist_name']}\"")
print(f"   Output: {OUTPUT_DIR}")
print(f"   Quality: HiFi\n")

# --- Download ---
success = 0
skipped = 0
failed = 0
failed_tracks = []
start_time = time.time()

# Cache albums to avoid redundant API calls
album_cache = {}

for i, track_data in enumerate(tracks):
    track_id = str(track_data["tidal_id"])
    title = track_data["title"]
    artist = track_data["artists"]
    album_id = str(track_data.get("album_id", ""))

    try:
        print(f"[{i+1}/{total}] {artist} - {title}")

        # Fetch track
        track = TIDAL_API.getTrack(track_id)

        # Fetch album (use cache to avoid duplicate API calls)
        if album_id and album_id in album_cache:
            album = album_cache[album_id]
        else:
            album = TIDAL_API.getAlbum(track.album.id)
            if album_id:
                album_cache[album_id] = album

        # Download cover image for the album
        if SETTINGS.saveCovers:
            tidal_dl.downloadCover(album)

        # Download the track
        result_ok, err_msg = tidal_dl.downloadTrack(track, album=album)

        if result_ok:
            success += 1
        elif "already exists" in str(err_msg).lower() or "skip" in str(err_msg).lower():
            skipped += 1
        else:
            failed += 1
            failed_tracks.append({
                "tidal_id": track_id,
                "title": title,
                "artists": artist,
                "error": err_msg,
            })

    except Exception as e:
        err_str = str(e)
        print(f"  ❌ ERROR: {err_str}")
        failed += 1
        failed_tracks.append({
            "tidal_id": track_id,
            "title": title,
            "artists": artist,
            "error": err_str,
        })
        continue

    # Progress report every 50 tracks
    if (i + 1) % 50 == 0:
        elapsed = time.time() - start_time
        rate = (i + 1) / elapsed * 60
        eta = (total - i - 1) / rate
        print(f"  --- Progress: {i+1}/{total} | {success} ok, {skipped} skip, {failed} fail | ~{rate:.0f}/min, ETA {eta:.0f}min ---")

# --- Summary ---
elapsed = time.time() - start_time
print(f"\n{'='*55}")
print(f"✅ Complete in {elapsed/60:.1f} minutes")
print(f"   Downloaded: {success}")
print(f"   Skipped (existed): {skipped}")
print(f"   Failed: {failed}")
print(f"   Output: {OUTPUT_DIR}")

if failed_tracks:
    with open(FAILED_JSON, "w") as f:
        json.dump(failed_tracks, f, indent=2)
    print(f"\n❌ {len(failed_tracks)} failed tracks saved to: {FAILED_JSON}")
    for t in failed_tracks[:10]:
        print(f"   - {t['artists']} - {t['title']}: {t['error'][:80]}")
    if len(failed_tracks) > 10:
        print(f"   ... and {len(failed_tracks) - 10} more")

# Show disk usage
total_size = 0
file_count = 0
for root, dirs, files in os.walk(OUTPUT_DIR):
    for f in files:
        fp = os.path.join(root, f)
        total_size += os.path.getsize(fp)
        file_count += 1
print(f"\n💾 Disk usage: {total_size/1024/1024/1024:.1f} GB across {file_count} files")
