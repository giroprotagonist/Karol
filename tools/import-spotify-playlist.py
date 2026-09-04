#!/usr/bin/env python3
"""Import a Spotify playlist into Karol show queue as YouTube music videos.

Fetches track list from Spotify embed page (no API key needed).
Matches local library first (tags.json + songs/), else yt-dlp YouTube search.
Adds to queue via localhost:3131 when Karol is running.

Usage:
  python3 tools/import-spotify-playlist.py "https://open.spotify.com/playlist/4RrWWP7HZISPhESToBeoG4"
  python3 tools/import-spotify-playlist.py --playlist 4RrWWP7HZISPhESToBeoG4 --dry-run
  python3 tools/import-spotify-playlist.py --playlist 4RrWWP7HZISPhESToBeoG4 --jukebox
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

YT_DLP = "/opt/homebrew/bin/yt-dlp"
COOKIES = Path("/Users/macdonk/Documents/GitHub/Karol/.karol/yt-cookies.txt")
LIBRARY_ROOT = Path("/Volumes/maxone/Deskreen")
SONGS_DIR = LIBRARY_ROOT / "songs"
TAGS_PATH = LIBRARY_ROOT / "tags.json"
API_BASE = "http://localhost:3131"
BIRTHDAY_PLAYLIST_PATH = Path("/Users/macdonk/Documents/GitHub/Karol/.karol/birthday-playlist.json")
RESULTS_PATH = Path("/tmp/karol-spotify-import-results.json")
YT_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
STOP = {
    "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "at",
    "official", "music", "video", "lyrics", "audio", "hd", "4k", "mv",
    "feat", "ft", "vs", "remaster", "remastered", "mix", "original",
}


def log(msg: str) -> None:
    print(msg, flush=True)


def normalize(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").lower().strip())


def tokens(s: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", normalize(s))) - STOP


def fetch_spotify_tracks(playlist_id: str) -> list[dict]:
    url = f"https://open.spotify.com/embed/playlist/{playlist_id}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        html = resp.read().decode("utf-8", errors="replace")
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.DOTALL)
    if not m:
        raise RuntimeError("Could not parse Spotify embed page")
    data = json.loads(m.group(1))
    entity = (
        data.get("props", {})
        .get("pageProps", {})
        .get("state", {})
        .get("data", {})
        .get("entity", {})
    )
    playlist_name = entity.get("name") or entity.get("title") or playlist_id
    tracks = []
    for row in entity.get("trackList") or []:
        if row.get("entityType") != "track":
            continue
        title = (row.get("title") or "").strip()
        artist = (row.get("subtitle") or "").strip()
        dur_ms = int(row.get("duration") or 0)
        tracks.append({
            "title": title,
            "artist": artist,
            "duration_sec": dur_ms / 1000.0 if dur_ms else None,
            "spotify_uri": row.get("uri") or "",
        })
    return {"name": playlist_name, "tracks": tracks}


def load_tags() -> dict:
    for path in (TAGS_PATH, Path("/Users/macdonk/Documents/GitHub/Karol/.karol/tags.json")):
        if path.is_file():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                pass
    return {}


def local_music_path(video_id: str) -> Path | None:
    for base in (SONGS_DIR, LIBRARY_ROOT):
        p = base / f"{video_id}.mp4"
        if p.is_file() and p.stat().st_size > 50_000:
            return p
    return None


def find_local_match(artist: str, title: str, tags: dict) -> dict | None:
    want_title = normalize(title)
    want_artist = normalize(artist)
    title_tok = tokens(title)
    artist_tok = tokens(artist)
    best = None
    best_score = 0
    for vid, entry in tags.items():
        if not YT_ID.match(str(vid).replace("-karaoke", "")):
            continue
        base = str(vid).replace("-karaoke", "")
        if isinstance(entry, str):
            entry = {"tag": entry}
        if not isinstance(entry, dict):
            continue
        tag = (entry.get("tag") or "").lower()
        if tag not in ("music", "song", ""):
            # karaoke-only entries are lower priority unless title matches well
            if tag == "karaoke":
                pass
            elif tag:
                continue
        t_title = normalize(entry.get("title") or "")
        t_artist = normalize(entry.get("artist") or "")
        if not t_title and not t_artist:
            continue
        score = 0
        if want_title and t_title == want_title:
            score += 20
        elif title_tok and title_tok <= tokens(t_title):
            score += 12
        elif title_tok and title_tok & tokens(t_title):
            score += 6 * len(title_tok & tokens(t_title))
        if want_artist and t_artist:
            if want_artist in t_artist or t_artist in want_artist:
                score += 10
            elif artist_tok & tokens(t_artist):
                score += 5 * len(artist_tok & tokens(t_artist))
        if score < 14:
            continue
        if not local_music_path(base):
            score -= 3
        if score > best_score:
            best_score = score
            best = {
                "videoId": base,
                "title": entry.get("title") or title,
                "artist": entry.get("artist") or artist,
                "score": score,
                "source": "library",
            }
    return best


def ytdlp_auth() -> list[str]:
    return ["--cookies-from-browser", "chrome"]


def search_youtube(artist: str, title: str, duration_sec: float | None) -> dict | None:
    query = f'ytsearch8:"{artist} {title} official music video"'
    cmd = [YT_DLP, "--flat-playlist", "--dump-json", "--no-playlist", *ytdlp_auth(), query]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
    except Exception as e:
        return {"error": str(e)}
    if proc.returncode != 0:
        cmd2 = [YT_DLP, "--flat-playlist", "--dump-json", "--no-playlist", "--cookies", str(COOKIES), query]
        try:
            proc = subprocess.run(cmd2, capture_output=True, text=True, timeout=45)
        except Exception as e:
            return {"error": str(e)}
    if proc.returncode != 0:
        return {"error": (proc.stderr or proc.stdout or "search failed")[-300:]}

    title_tok = tokens(title)
    artist_tok = tokens(artist)
    candidates = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            info = json.loads(line)
        except json.JSONDecodeError:
            continue
        vid = info.get("id") or ""
        if not YT_ID.match(vid):
            continue
        vid_title = info.get("title") or ""
        vid_dur = info.get("duration")
        low = vid_title.lower()
        score = 0
        if "karaoke" in low or "cover" in low or "lyrics" in low:
            score -= 5
        if "official" in low:
            score += 8
        if "music video" in low or "mv" in low.split():
            score += 6
        overlap = title_tok & tokens(vid_title)
        if title_tok and not overlap:
            continue
        score += 4 * len(overlap)
        if artist_tok & tokens(vid_title):
            score += 4
        if duration_sec and vid_dur and abs(vid_dur - duration_sec) <= 30:
            score += 5
        elif duration_sec and vid_dur and abs(vid_dur - duration_sec) > 90:
            score -= 4
        candidates.append({
            "videoId": vid,
            "title": vid_title,
            "duration": vid_dur,
            "score": score,
        })
    if not candidates:
        # fallback: simpler search
        query2 = f'ytsearch5:"{artist} {title}"'
        cmd3 = [YT_DLP, "--flat-playlist", "--dump-json", "--no-playlist", *ytdlp_auth(), query2]
        proc2 = subprocess.run(cmd3, capture_output=True, text=True, timeout=45)
        for line in (proc2.stdout or "").splitlines():
            try:
                info = json.loads(line.strip())
            except json.JSONDecodeError:
                continue
            vid = info.get("id") or ""
            if YT_ID.match(vid):
                candidates.append({
                    "videoId": vid,
                    "title": info.get("title") or "",
                    "duration": info.get("duration"),
                    "score": 1,
                })
    if not candidates:
        return None
    candidates.sort(key=lambda c: c["score"], reverse=True)
    best = candidates[0]
    return {
        "videoId": best["videoId"],
        "title": f"{artist} — {title}",
        "yt_title": best["title"],
        "score": best["score"],
        "source": "youtube-search",
    }


def api_available() -> bool:
    try:
        with urllib.request.urlopen(f"{API_BASE}/api/health.json", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def api_post(path: str, body: dict) -> dict:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{API_BASE}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def add_to_queue(items: list[dict], requester: str, jukebox: bool) -> dict:
    added = 0
    skipped = 0
    errors: list[dict] = []
    # API only exposes single queue-add; jukebox-start needs IPC (not on HTTP API)
    for item in items:
        body = {
            "videoId": item["videoId"],
            "title": item.get("title") or "",
            "requester": requester,
            "name": requester,
        }
        try:
            r = api_post("/api/youtube-dj/queue", body)
            if r.get("ok"):
                added += 1
            else:
                skipped += 1
                errors.append({"videoId": item["videoId"], "error": r.get("error")})
        except Exception as e:
            skipped += 1
            errors.append({"videoId": item["videoId"], "error": str(e)})
        time.sleep(0.05)
    return {"added": added, "skipped": skipped, "errors": errors, "jukebox": jukebox}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("url", nargs="?", help="Spotify playlist URL")
    ap.add_argument("--playlist", help="Spotify playlist ID")
    ap.add_argument("--dry-run", action="store_true", help="Match only, do not add to queue")
    ap.add_argument("--jukebox", action="store_true", help="Prefer local-only matches (jukebox-ready)")
    ap.add_argument("--requester", default="Spotify Import", help="Queue requester name")
    ap.add_argument("--limit", type=int, default=0, help="Max tracks to process (0=all)")
    args = ap.parse_args()

    playlist_id = args.playlist or ""
    if args.url:
        m = re.search(r"playlist/([A-Za-z0-9]+)", args.url)
        if m:
            playlist_id = m.group(1)
    if not playlist_id:
        ap.error("Provide a Spotify playlist URL or --playlist ID")

    log(f"Fetching Spotify playlist {playlist_id} …")
    meta = fetch_spotify_tracks(playlist_id)
    tracks = meta["tracks"]
    if args.limit > 0:
        tracks = tracks[: args.limit]
    log(f"Playlist: {meta['name']} — {len(tracks)} tracks")

    tags = load_tags()
    results = []
    matched_local = 0
    matched_yt = 0
    failed = 0

    for i, tr in enumerate(tracks, 1):
        artist = tr["artist"]
        title = tr["title"]
        log(f"[{i}/{len(tracks)}] {artist} — {title}")
        match = find_local_match(artist, title, tags)
        if match:
            matched_local += 1
            row = {**tr, **match, "status": "matched-local", "spotifyTitle": title}
            results.append(row)
            log(f"  → local {match['videoId']} ({match.get('title', '')})")
            continue
        if args.jukebox:
            row = {**tr, "status": "no-local-skip"}
            results.append(row)
            failed += 1
            log("  → no local file (jukebox mode — skipped)")
            continue
        yt = search_youtube(artist, title, tr.get("duration_sec"))
        if not yt or yt.get("error"):
            failed += 1
            row = {**tr, "status": "failed", "error": (yt or {}).get("error") or "no match"}
            results.append(row)
            log(f"  → FAILED {(yt or {}).get('error') or 'no match'}")
            continue
        matched_yt += 1
        row = {**tr, **yt, "status": "matched-youtube", "spotifyTitle": title}
        results.append(row)
        log(f"  → yt {yt['videoId']} ({yt.get('yt_title', '')})")

    queue_items = [
        {
            "videoId": r["videoId"],
            "title": r.get("title") or f"{r['artist']} — {r.get('spotifyTitle') or r['title']}",
            "artist": r.get("artist") or "",
            "spotifyTitle": r.get("spotifyTitle") or r.get("title") or "",
            "displayTitle": r.get("title") or f"{r['artist']} — {r.get('spotifyTitle') or r['title']}",
            "source": r.get("source") or r.get("status", "").replace("matched-", ""),
            "local": r.get("status") == "matched-local",
        }
        for r in results
        if r.get("videoId") and r.get("status", "").startswith("matched")
    ]

    birthday_payload = {
        "name": meta["name"],
        "spotifyPlaylistId": playlist_id,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "djName": "Naynay/Karolpdx",
        "trackCount": len(tracks),
        "matchedLocal": matched_local,
        "matchedYoutube": matched_yt,
        "failed": failed,
        "tracks": queue_items,
    }
    BIRTHDAY_PLAYLIST_PATH.parent.mkdir(parents=True, exist_ok=True)
    BIRTHDAY_PLAYLIST_PATH.write_text(json.dumps(birthday_payload, indent=2, ensure_ascii=False))
    log(f"Saved birthday playlist → {BIRTHDAY_PLAYLIST_PATH} ({len(queue_items)} tracks)")

    import_result = None
    if not args.dry_run and queue_items:
        if api_available():
            log(f"Karol API up — adding {len(queue_items)} items to queue …")
            import_result = add_to_queue(queue_items, args.requester, args.jukebox)
            log(f"Queue add: {import_result['added']} added, {import_result['skipped']} skipped")
        else:
            log("Karol API not running — saved results only (start Karol and re-run without --dry-run)")

    report = {
        "playlist_id": playlist_id,
        "playlist_name": meta["name"],
        "track_count": len(tracks),
        "matched_local": matched_local,
        "matched_youtube": matched_yt,
        "failed": failed,
        "queue_ready": len(queue_items),
        "birthday_playlist_path": str(BIRTHDAY_PLAYLIST_PATH),
        "karol_api_running": api_available(),
        "import_result": import_result,
        "results": results,
    }
    RESULTS_PATH.write_text(json.dumps(report, indent=2, ensure_ascii=False))
    log(f"\nSummary: {len(tracks)} tracks | local {matched_local} | youtube {matched_yt} | failed {failed}")
    log(f"Results → {RESULTS_PATH}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
