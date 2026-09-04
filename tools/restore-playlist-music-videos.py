#!/usr/bin/env python3
"""Restore Music Videos (songs/) for playlist IDs missing an original MV.

Dual-presence pattern:
  - songs/{id}.mp4  tagged music  (Music Videos tab)
  - karaoke/{id}-karaoke.mp4 tagged karaoke (Custom / Karaoke)

Bypasses download-archive for the attempt (--no-download-archive) but re-adds
the id to the archive after a successful download so future sync stays correct.

Does not touch karaoke files. Safe to run while Demucs/stems batches run
(serial downloads by default — set WORKERS>1 only when CPU is free).

Usage:
  python3 tools/restore-playlist-music-videos.py
  python3 tools/restore-playlist-music-videos.py --playlist PLGKtSCMf0XtO3YKUexSYy4sG1K1Aul942
  python3 tools/restore-playlist-music-videos.py --ids-file /tmp/missing.txt --dry-run
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

SONGS = Path("/Volumes/maxone/Deskreen/songs")
KARAOKE = Path("/Volumes/maxone/Deskreen/karaoke")
ROOT = Path("/Volumes/maxone/Deskreen")
TAGS_PATH = ROOT / "tags.json"
ARCHIVE_PATH = ROOT / "youtube-download-archive.txt"
YT_DLP = "/opt/homebrew/bin/yt-dlp"
COOKIES = Path("/Users/macdonk/Documents/GitHub/Karol/.karol/yt-cookies.txt")
DEFAULT_PLAYLIST = "PLGKtSCMf0XtO3YKUexSYy4sG1K1Aul942"
YT_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
FMT = (
    "bv*[vcodec^=avc1][height<=1080]+ba/"
    "bv*[vcodec*=avc1][height<=1080]+ba/"
    "b[ext=mp4][vcodec*=avc1][height<=1080]/"
    "b[height<=720]/b[height<=1080]"
)
RESULTS = Path("/tmp/karol-restore-mv-results.json")
LOG = Path("/tmp/karol-restore-mv-run.log")


def probe_ok(path: str | Path) -> tuple[bool, str]:
    try:
        out = subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration,size:stream=codec_type,codec_name,duration,width,height",
                "-of",
                "json",
                str(path),
            ],
            stderr=subprocess.STDOUT,
            timeout=60,
        )
        d = json.loads(out)
    except Exception as e:
        return False, f"probe-fail:{e}"
    streams = d.get("streams") or []
    fmt = d.get("format") or {}
    v = [s for s in streams if s.get("codec_type") == "video" and s.get("codec_name") != "png"]
    a = [s for s in streams if s.get("codec_type") == "audio"]
    if not v or not a:
        return False, f"missing-av streams={len(streams)}"
    try:
        fdur = float(fmt.get("duration") or 0)
    except Exception:
        fdur = 0.0
    try:
        vdur = float(v[0].get("duration") or 0)
    except Exception:
        vdur = 0.0
    try:
        adur = float(a[0].get("duration") or 0)
    except Exception:
        adur = 0.0
    if fdur <= 0 and vdur <= 0:
        return False, "no-duration"
    ref = max(fdur, vdur, adur)
    if vdur > 0 and fdur > 15 and vdur < fdur * 0.85:
        return False, f"truncated-video vid={vdur:.2f} fmt={fdur:.0f}"
    if adur > 0 and fdur > 15 and adur < fdur * 0.85:
        return False, f"truncated-audio aud={adur:.2f} fmt={fdur:.0f}"
    if ref < 5:
        return False, f"too-short {ref:.2f}"
    size = int(fmt.get("size") or Path(path).stat().st_size)
    if ref >= 30 and size < 1_500_000:
        return False, f"tiny-file size={size} dur={ref:.0f}"
    wh = f"{v[0].get('width')}x{v[0].get('height')}"
    return True, f"{v[0].get('codec_name')}+{a[0].get('codec_name')} {wh} {ref:.1f}s size={size}"


def auth_args() -> list[str]:
    # Prefer live Chrome cookies; fall back to exported jar.
    return ["--cookies-from-browser", "chrome"]


def fetch_playlist_ids(playlist_id: str) -> list[str]:
    url = f"https://www.youtube.com/playlist?list={playlist_id}"
    cmd = [
        YT_DLP,
        "--flat-playlist",
        "--print",
        "id",
        *auth_args(),
        url,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if proc.returncode != 0:
        # Retry with cookie file
        cmd2 = [
            YT_DLP,
            "--flat-playlist",
            "--print",
            "id",
            "--cookies",
            str(COOKIES),
            url,
        ]
        proc = subprocess.run(cmd2, capture_output=True, text=True, timeout=180)
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or proc.stdout or "playlist fetch failed")[-500:])
    seen: set[str] = set()
    out: list[str] = []
    for ln in (proc.stdout or "").splitlines():
        vid = ln.strip()
        if YT_ID.match(vid) and vid not in seen:
            seen.add(vid)
            out.append(vid)
    return out


def load_tags() -> dict:
    if not TAGS_PATH.exists():
        return {}
    try:
        return json.loads(TAGS_PATH.read_text())
    except json.JSONDecodeError:
        return {}


def save_tags(tags: dict) -> None:
    tmp = TAGS_PATH.with_suffix(".json.tmp-restore")
    tmp.write_text(json.dumps(tags, indent=2, ensure_ascii=False))
    os.replace(tmp, TAGS_PATH)


def archive_has(video_id: str) -> bool:
    if not ARCHIVE_PATH.exists():
        return False
    needle = f"youtube {video_id}"
    return needle in ARCHIVE_PATH.read_text()


def archive_ensure(video_id: str) -> None:
    ARCHIVE_PATH.parent.mkdir(parents=True, exist_ok=True)
    entry = f"youtube {video_id}"
    text = ARCHIVE_PATH.read_text() if ARCHIVE_PATH.exists() else ""
    if entry in text:
        return
    needs_nl = bool(text) and not text.endswith("\n")
    with open(ARCHIVE_PATH, "a") as f:
        if needs_nl:
            f.write("\n")
        f.write(entry + "\n")


def music_path(video_id: str) -> Path | None:
    p = SONGS / f"{video_id}.mp4"
    if p.is_file() and p.stat().st_size > 100_000:
        return p
    r = ROOT / f"{video_id}.mp4"
    if r.is_file() and r.stat().st_size > 100_000:
        tags = load_tags()
        t = tags.get(video_id)
        if isinstance(t, str):
            t = {"tag": t}
        if isinstance(t, dict) and t.get("tag") in ("music", "song"):
            return r
    return None


def karaoke_path(video_id: str) -> Path | None:
    for name in (f"{video_id}-karaoke.mp4", f"{video_id}.mp4"):
        p = KARAOKE / name
        if p.is_file() and p.stat().st_size > 50_000:
            return p
    return None


def ensure_dual_tags(video_id: str, had_karaoke: bool) -> None:
    """Base id = music; {id}-karaoke stays karaoke (source preserved)."""
    tags = load_tags()
    base = tags.get(video_id)
    if isinstance(base, str):
        base = {"tag": base}
    if not isinstance(base, dict):
        base = {}
    # Don't clobber karaoke-maker on the wrong key — move provenance to -karaoke
    kk = f"{video_id}-karaoke"
    kentry = tags.get(kk)
    if isinstance(kentry, str):
        kentry = {"tag": kentry}
    if not isinstance(kentry, dict):
        kentry = {}

    if had_karaoke or kentry or karaoke_path(video_id):
        if not kentry.get("tag"):
            kentry["tag"] = "karaoke"
        if base.get("source") == "karaoke-maker" and kentry.get("source") != "karaoke-maker":
            kentry["source"] = "karaoke-maker"
        if base.get("title") and not kentry.get("title"):
            kentry["title"] = base["title"]
        if base.get("artist") and not kentry.get("artist"):
            kentry["artist"] = base["artist"]
        tags[kk] = kentry

    new_base = dict(base)
    new_base["tag"] = "music"
    # Base Music Video is not a karaoke-maker artifact — keep a non-empty
    # source so isMusicVideoTagEntry() doesn't hide MVs that have a -karaoke row.
    if new_base.get("source") in ("karaoke-maker", "", None):
        new_base["source"] = "music-video"
    tags[video_id] = new_base
    save_tags(tags)


def download_one(video_id: str, dry_run: bool = False) -> dict:
    dest = SONGS / f"{video_id}.mp4"
    kara = karaoke_path(video_id)
    existing = music_path(video_id)

    if existing and existing.resolve() == dest.resolve():
        ok, detail = probe_ok(dest)
        if ok:
            ensure_dual_tags(video_id, bool(kara))
            archive_ensure(video_id)
            return {"id": video_id, "status": "already-ok", "detail": detail, "karaoke": bool(kara)}

    if dry_run:
        return {
            "id": video_id,
            "status": "would-download",
            "karaoke": bool(kara),
            "in_archive": archive_has(video_id),
        }

    SONGS.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        ok, detail = probe_ok(dest)
        if ok:
            ensure_dual_tags(video_id, bool(kara))
            archive_ensure(video_id)
            return {"id": video_id, "status": "already-ok", "detail": detail, "karaoke": bool(kara)}
        try:
            dest.rename(str(dest) + ".bad-restore")
        except OSError:
            pass

    cmd = [
        YT_DLP,
        *auth_args(),
        "-f",
        FMT,
        "--merge-output-format",
        "mp4",
        "--no-playlist",
        "--no-download-archive",
        "--socket-timeout",
        "30",
        "--retries",
        "5",
        "--fragment-retries",
        "5",
        "--extractor-args",
        # ios helps when SABR blocks mweb/tv adaptive HTTPS (yt-dlp#12482)
        "youtube:player_client=mweb,ios,tv,web",
        "--write-info-json",
        "-o",
        str(SONGS / "%(id)s.%(ext)s"),
        f"https://www.youtube.com/watch?v={video_id}",
    ]
    t0 = time.time()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    except Exception as e:
        return {"id": video_id, "status": "error", "detail": str(e), "karaoke": bool(kara)}

    if proc.returncode != 0 or not dest.exists():
        # Fallback cookie jar
        cmd2 = list(cmd)
        # replace chrome cookies with jar
        try:
            i = cmd2.index("--cookies-from-browser")
            cmd2[i : i + 2] = ["--cookies", str(COOKIES)]
        except ValueError:
            cmd2[1:1] = ["--cookies", str(COOKIES)]
        try:
            proc = subprocess.run(cmd2, capture_output=True, text=True, timeout=600)
        except Exception as e:
            return {"id": video_id, "status": "error", "detail": str(e), "karaoke": bool(kara)}
        if proc.returncode != 0 or not dest.exists():
            err = (proc.stderr or proc.stdout or "")[-500:].replace("\n", " ")
            status = "unavailable"
            low = err.lower()
            if "private" in low:
                status = "private"
            elif "unavailable" in low or "removed" in low or "deleted" in low:
                status = "deleted"
            elif "sign in" in low or "confirm your age" in low:
                status = "auth-required"
            return {
                "id": video_id,
                "status": status if status != "unavailable" else "download-fail",
                "detail": err,
                "secs": round(time.time() - t0, 1),
                "karaoke": bool(kara),
            }

    ok, detail = probe_ok(dest)
    if not ok:
        try:
            dest.rename(str(dest) + ".bad-restore")
        except OSError:
            pass
        return {
            "id": video_id,
            "status": "still-bad",
            "detail": detail,
            "secs": round(time.time() - t0, 1),
            "karaoke": bool(kara),
        }

    ensure_dual_tags(video_id, bool(kara))
    archive_ensure(video_id)
    # Confirm karaoke untouched
    kara_after = karaoke_path(video_id)
    return {
        "id": video_id,
        "status": "ok",
        "detail": detail,
        "secs": round(time.time() - t0, 1),
        "karaoke": bool(kara_after),
        "karaoke_path": str(kara_after) if kara_after else None,
    }


def find_missing(playlist_ids: list[str]) -> list[str]:
    missing = []
    for vid in playlist_ids:
        p = music_path(vid)
        if p is None:
            missing.append(vid)
            continue
        # Prefer songs/ — if only root, still count as present for coverage
        ok, _ = probe_ok(p)
        if not ok:
            missing.append(vid)
    return missing


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--playlist", default=DEFAULT_PLAYLIST, help="YouTube playlist id")
    ap.add_argument("--ids-file", help="Skip playlist fetch; one video id per line")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="Max downloads (0 = all)")
    ap.add_argument("--workers", type=int, default=1, help="Parallel downloads (default 1 — be kind to Demucs)")
    args = ap.parse_args()

    if args.ids_file:
        playlist_ids = []
        seen: set[str] = set()
        for ln in Path(args.ids_file).read_text().splitlines():
            vid = ln.strip()
            if YT_ID.match(vid) and vid not in seen:
                seen.add(vid)
                playlist_ids.append(vid)
    else:
        print(f"Fetching playlist {args.playlist} …", flush=True)
        playlist_ids = fetch_playlist_ids(args.playlist)
    print(f"playlist unique {len(playlist_ids)}", flush=True)

    missing = find_missing(playlist_ids)
    print(f"missing Music Videos: {len(missing)}", flush=True)
    if args.limit > 0:
        missing = missing[: args.limit]
        print(f"limited to {len(missing)}", flush=True)

    if not missing:
        print("nothing to do")
        RESULTS.write_text(json.dumps({"playlist_count": len(playlist_ids), "missing": 0, "results": []}, indent=2))
        return 0

    results = []
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG, "a") as log:
        log.write(f"\n=== start {time.strftime('%Y-%m-%d %H:%M:%S')} todo={len(missing)} dry={args.dry_run} ===\n")
        if args.workers <= 1 or args.dry_run:
            for n, vid in enumerate(missing, 1):
                r = download_one(vid, dry_run=args.dry_run)
                results.append(r)
                line = f"[{n}/{len(missing)}] {r['status']:14} {r['id']}  karaoke={r.get('karaoke')}  {r.get('detail', '')}"
                print(line, flush=True)
                log.write(line + "\n")
                log.flush()
        else:
            from concurrent.futures import ThreadPoolExecutor, as_completed

            with ThreadPoolExecutor(max_workers=args.workers) as ex:
                futs = {ex.submit(download_one, vid, args.dry_run): vid for vid in missing}
                for n, fut in enumerate(as_completed(futs), 1):
                    r = fut.result()
                    results.append(r)
                    line = f"[{n}/{len(missing)}] {r['status']:14} {r['id']}  karaoke={r.get('karaoke')}  {r.get('detail', '')}"
                    print(line, flush=True)
                    log.write(line + "\n")
                    log.flush()

    # Final coverage
    still = find_missing(playlist_ids)
    summary = dict(Counter(r["status"] for r in results))
    report = {
        "playlist_count": len(playlist_ids),
        "attempted": len(results),
        "summary": summary,
        "still_missing": still,
        "still_missing_count": len(still),
        "results": results,
    }
    RESULTS.write_text(json.dumps(report, indent=2))
    print("summary", summary, flush=True)
    print(f"still missing after run: {len(still)}", flush=True)
    print(f"results → {RESULTS}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
