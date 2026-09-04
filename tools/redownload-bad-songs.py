#!/usr/bin/env python3
"""Quarantine-aware redownload of broken music-video MP4s as H.264-preferring copies."""
from __future__ import annotations

import concurrent.futures
import json
import os
import subprocess
import sys
import time

SONGS = "/Volumes/maxone/Deskreen/songs"
COOKIES = "/Users/macdonk/Documents/GitHub/Karol/.karol/yt-cookies.txt"
YT_DLP = "/opt/homebrew/bin/yt-dlp"
FMT = (
    "bv*[vcodec^=avc1][height<=1080]+ba/"
    "bv*[vcodec*=avc1][height<=1080]+ba/"
    "b[ext=mp4][vcodec*=avc1][height<=1080]/"
    "b[height<=720]/b[height<=1080]"
)
NEED = "/tmp/karol-redownload-need.txt"
LOG = "/tmp/karol-redownload-run.log"
RESULTS = "/tmp/karol-redownload-results.json"
WORKERS = 2


def probe_ok(path: str) -> tuple[bool, str]:
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
                path,
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
    if fdur <= 0 and vdur <= 0:
        return False, "no-duration"
    # Truncated video stream with long container/audio (classic playhead freeze)
    ref = max(fdur, vdur)
    if vdur > 0 and fdur > 15 and vdur < fdur * 0.85:
        return False, f"truncated-video vid={vdur:.2f} fmt={fdur:.0f}"
    if vdur > 0 and fdur > 15 and vdur < 3 and fdur > vdur * 5:
        return False, f"short-video vid={vdur:.2f} fmt={fdur:.0f}"
    if max(fdur, vdur) < 5:
        return False, f"too-short {max(fdur, vdur):.2f}"
    wh = f"{v[0].get('width')}x{v[0].get('height')}"
    return True, f"{v[0].get('codec_name')}+{a[0].get('codec_name')} {wh} {max(fdur, vdur):.1f}s"


def download_one(video_id: str) -> dict:
    dest = os.path.join(SONGS, f"{video_id}.mp4")
    if os.path.exists(dest):
        ok, detail = probe_ok(dest)
        if ok:
            return {"id": video_id, "status": "already-ok", "detail": detail}
        # Bad leftover — quarantine before retry
        os.rename(dest, dest + ".bad-retry")
    cmd = [
        YT_DLP,
        "-f",
        FMT,
        "--merge-output-format",
        "mp4",
        "--no-playlist",
        "--socket-timeout",
        "30",
        "--retries",
        "5",
        "--fragment-retries",
        "5",
        "--extractor-args",
        "youtube:player_client=mweb,tv,web",
        "-o",
        os.path.join(SONGS, "%(id)s.%(ext)s"),
        f"https://www.youtube.com/watch?v={video_id}",
    ]
    # Prefer cookies-from-browser; exported jar is often stale/invalid.
    cmd[1:1] = ["--cookies-from-browser", "chrome"]
    t0 = time.time()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    except Exception as e:
        return {"id": video_id, "status": "error", "detail": str(e)}
    if proc.returncode != 0 or not os.path.exists(dest):
        err = (proc.stderr or proc.stdout or "")[-400:].replace("\n", " ")
        return {"id": video_id, "status": "download-fail", "detail": err, "secs": round(time.time() - t0, 1)}
    ok, detail = probe_ok(dest)
    if not ok:
        try:
            os.rename(dest, dest + ".bad-redownload")
        except Exception:
            pass
        return {"id": video_id, "status": "still-bad", "detail": detail, "secs": round(time.time() - t0, 1)}
    return {"id": video_id, "status": "ok", "detail": detail, "secs": round(time.time() - t0, 1)}


def main() -> int:
    ids = [ln.strip() for ln in open(NEED) if ln.strip()]
    # Skip ones already healthy
    todo = []
    for i in ids:
        p = os.path.join(SONGS, f"{i}.mp4")
        if os.path.exists(p):
            ok, _ = probe_ok(p)
            if ok:
                continue
        todo.append(i)
    print(f"need {len(todo)}/{len(ids)}", flush=True)
    results = []
    with open(LOG, "a") as log:
        log.write(f"\n=== start {time.strftime('%Y-%m-%d %H:%M:%S')} todo={len(todo)} ===\n")
        with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as ex:
            futs = {ex.submit(download_one, i): i for i in todo}
            for n, fut in enumerate(concurrent.futures.as_completed(futs), 1):
                r = fut.result()
                results.append(r)
                line = f"[{n}/{len(todo)}] {r['status']:14} {r['id']}  {r.get('detail','')}"
                print(line, flush=True)
                log.write(line + "\n")
                log.flush()
    json.dump(results, open(RESULTS, "w"), indent=2)
    from collections import Counter

    print("summary", dict(Counter(r["status"] for r in results)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
