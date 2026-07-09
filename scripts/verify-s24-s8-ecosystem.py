#!/usr/bin/env python3
"""
Automated S24 + Tab S8 ecosystem audit.
Exercises tablet API: connectivity, volume latency, skip chain, play/pause resume, UI assets.

Usage:
  DESKREEN_HOST=192.168.68.57 python3 scripts/verify-s24-s8-ecosystem.py
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

HOST = os.environ.get("DESKREEN_HOST", "192.168.68.57")
PORT = os.environ.get("DESKREEN_PORT", "3131")
BASE = f"http://{HOST}:{PORT}"
API = f"{BASE}/api/youtube-dj"
TIMEOUT = 12
FAILURES: list[str] = []
WARNS: list[str] = []


def req(
    method: str,
    url: str,
    body: dict | None = None,
) -> tuple[float, dict | None, int]:
    data = None
    headers = {"Content-Type": "application/json", "X-Karol-Client": "KarolAudit/1.0"}
    if body is not None:
        data = json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    start = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as resp:
            elapsed_ms = (time.perf_counter() - start) * 1000
            raw = resp.read().decode()
            parsed = None
            if raw:
                try:
                    parsed = json.loads(raw)
                except json.JSONDecodeError:
                    parsed = None
            return elapsed_ms, parsed, resp.status
    except urllib.error.HTTPError as e:
        elapsed_ms = (time.perf_counter() - start) * 1000
        try:
            parsed = json.loads(e.read().decode())
        except Exception:
            parsed = None
        return elapsed_ms, parsed, e.code


def ok(name: str, detail: str = "") -> None:
    suffix = f" — {detail}" if detail else ""
    print(f"  OK  {name}{suffix}")


def fail(name: str, detail: str) -> None:
    FAILURES.append(f"{name}: {detail}")
    print(f"  FAIL {name}: {detail}")


def warn(name: str, detail: str) -> None:
    WARNS.append(f"{name}: {detail}")
    print(f"  WARN {name}: {detail}")


def section(title: str) -> None:
    print(f"\n=== {title} ===")


def check_connectivity() -> None:
    section("Connectivity")
    ms, health, code = req("GET", f"{API}/health")
    if code != 200 or not health or not health.get("ok"):
        fail("health", f"HTTP {code}")
        return
    ok("health", f"{ms:.0f}ms host={health.get('host')} showActive={health.get('showActive')}")

    ms, _, code = req("GET", f"{BASE}/dj-controller/")
    if code != 200:
        fail("dj-controller", f"HTTP {code}")
    else:
        ok("dj-controller SPA", f"{ms:.0f}ms")

    for key in ("volumeLevel", "showActive", "hostMode", "captureReady"):
        if key not in health:
            warn("health schema", f"missing {key}")


def check_ui_assets() -> None:
    section("UI assets (dj-controller bundle)")
    ms, _, code = req("GET", f"{BASE}/dj-controller/")
    if code != 200:
        fail("dj-controller html", f"HTTP {code}")
        return
    import re

    html = ""
    try:
        with urllib.request.urlopen(f"{BASE}/dj-controller/", timeout=TIMEOUT) as r:
            html = r.read().decode()
    except Exception as e:
        fail("dj-controller html read", str(e))
        return
    js_match = re.search(r'assets/(index-[^"]+\.js)', html)
    css_match = re.search(r'assets/(index-[^"]+\.css)', html)
    if not js_match:
        fail("bundle js", "no index-*.js in index.html")
    else:
        js_path = js_match.group(1)
        _, _, js_code = req("GET", f"{BASE}/dj-controller/assets/{js_path}")
        if js_code == 200:
            ok("bundle js", js_path)
        else:
            fail("bundle js", f"HTTP {js_code} for {js_path}")
    if not css_match:
        warn("bundle css", "no index-*.css in index.html")
    else:
        css_path = css_match.group(1)
        _, _, css_code = req("GET", f"{BASE}/dj-controller/assets/{css_path}")
        if css_code == 200:
            ok("bundle css", css_path)
        else:
            warn("bundle css", f"HTTP {css_code}")


def check_volume_latency() -> None:
    section("Volume proxy latency")
    levels = [0.3, 0.55, 0.8, 1.0]
    latencies: list[float] = []
    for level in levels:
        ms, body, code = req("POST", f"{API}/transport/volume", {"level": level})
        if code != 200 or not body or not body.get("ok"):
            fail("transport/volume", f"level={level} HTTP {code}")
            continue
        latencies.append(ms)
        ms2, health, _ = req("GET", f"{API}/health")
        read = health.get("volumeLevel") if health else None
        if read is None or abs(float(read) - level) > 0.02:
            fail("volume round-trip", f"set {level} read {read}")
        else:
            ok(f"volume {level}", f"post {ms:.0f}ms read {ms2:.0f}ms")
    if latencies:
        avg = sum(latencies) / len(latencies)
        p95 = sorted(latencies)[-1]
        ok("volume latency stats", f"avg={avg:.0f}ms p95={p95:.0f}ms")
        if p95 > 500:
            warn("volume latency", f"p95 {p95:.0f}ms > 500ms (may feel sluggish on device)")


def check_skip_prev() -> None:
    section("Skip previous (sequential)")
    _, start, _ = req("GET", f"{API}/now-playing")
    start_vid = (start or {}).get("videoId") or ""
    req("POST", f"{API}/transport/skip-next", {})
    time.sleep(1.0)
    _, after_next, _ = req("GET", f"{API}/now-playing")
    next_vid = (after_next or {}).get("videoId") or ""
    if not next_vid or next_vid == start_vid:
        warn("skip-prev setup", "skip-next did not change track")
    ms, body, code = req("POST", f"{API}/transport/skip-prev", {})
    if code != 200 or not body or not body.get("ok"):
        fail("skip-prev", f"HTTP {code}")
        return
    prev_vid = ((body.get("nowPlaying") or {}).get("videoId")) or ""
    if prev_vid == next_vid:
        fail("skip-prev", f"still on {next_vid}")
    elif start_vid and prev_vid != start_vid:
        warn("skip-prev", f"got {prev_vid} expected {start_vid} (shuffle or seek-to-start)")
    else:
        ok("skip-prev", f"{ms:.0f}ms back to {prev_vid[:11]}")


def check_shuffle_skip_back() -> None:
    section("Shuffle mode skip back")
    req("PATCH", f"{API}/shuffle", {"enabled": True})
    time.sleep(0.3)
    trail: list[str] = []
    for i in range(3):
        _, body, code = req("POST", f"{API}/transport/skip-next", {})
        if code != 200 or not body:
            fail(f"shuffle skip-next #{i+1}", f"HTTP {code}")
            continue
        vid = ((body.get("nowPlaying") or {}).get("videoId")) or ""
        trail.append(vid)
        time.sleep(1.0)
    if len(trail) < 2:
        warn("shuffle trail", "not enough tracks to test back")
        return
    last = trail[-1]
    ms, back_body, code = req("POST", f"{API}/transport/skip-prev", {})
    if code != 200 or not back_body:
        fail("shuffle skip-prev", f"HTTP {code}")
        return
    back_vid = ((back_body.get("nowPlaying") or {}).get("videoId")) or ""
    expected = trail[-2]
    if back_vid == last:
        fail("shuffle skip-prev", "did not leave current track")
    elif back_vid == expected:
        ok("shuffle skip-prev", f"{ms:.0f}ms restored {back_vid[:11]}")
    else:
        warn("shuffle skip-prev", f"got {back_vid[:11]} expected {expected[:11]} (random path)")
    req("PATCH", f"{API}/shuffle", {"enabled": False})


def check_volume_across_skips() -> None:
    section("Volume consistency across skips")
    target = 0.42
    req("POST", f"{API}/transport/volume", {"level": target})
    time.sleep(0.3)
    levels: list[float] = []
    for i in range(3):
        _, health, _ = req("GET", f"{API}/health")
        read = float((health or {}).get("volumeLevel") or -1)
        levels.append(read)
        if abs(read - target) > 0.03:
            fail(f"volume before skip #{i+1}", f"expected ~{target} got {read}")
        req("POST", f"{API}/transport/skip-next", {})
        time.sleep(1.2)
        _, health2, _ = req("GET", f"{API}/health")
        read2 = float((health2 or {}).get("volumeLevel") or -1)
        if abs(read2 - target) > 0.03:
            fail(f"volume after skip #{i+1}", f"expected ~{target} got {read2}")
        else:
            ok(f"volume held skip #{i+1}", f"{read2:.2f}")
    if levels:
        ok("volume baseline", f"{levels[0]:.2f}")


def check_skip_chain() -> None:
    section("Skip chain (transport stability)")
    video_ids: list[str] = []
    skip_times: list[float] = []
    prev_vid = ""
    for i in range(4):
        ms, body, code = req("POST", f"{API}/transport/skip-next", {})
        skip_times.append(ms)
        if code != 200 or not body or not body.get("ok"):
            fail(f"skip-next #{i+1}", f"HTTP {code}")
            continue
        np = body.get("nowPlaying") or {}
        vid = np.get("videoId") or ""
        title = (np.get("title") or "")[:40]
        video_ids.append(vid)
        if vid and vid == prev_vid:
            warn(f"skip #{i+1}", f"videoId unchanged ({vid})")
        else:
            ok(f"skip #{i+1}", f"{ms:.0f}ms vid={vid[:11]} title={title}")
        prev_vid = vid
        time.sleep(1.5)
    unique = {v for v in video_ids if v}
    if len(unique) < 2 and len(video_ids) >= 3:
        warn("skip variety", f"only {len(unique)} unique videoIds in {len(video_ids)} skips")
    if skip_times:
        avg = sum(skip_times) / len(skip_times)
        ok("skip latency stats", f"avg={avg:.0f}ms max={max(skip_times):.0f}ms")
        if max(skip_times) > 2000:
            warn("skip latency", f"max {max(skip_times):.0f}ms")


def check_play_pause_resume() -> None:
    section("Play / pause / resume")
    req("POST", f"{API}/transport/play", {})
    time.sleep(3.0)
    _, playing, _ = req("GET", f"{API}/now-playing")
    if not playing:
        fail("now-playing after play", "empty response")
        return
    t0 = float(playing.get("currentTime") or 0)
    state = playing.get("state")
    ok("playing", f"state={state} time={t0:.1f}s")

    time.sleep(3.0)
    _, mid, _ = req("GET", f"{API}/now-playing")
    t1 = float((mid or {}).get("currentTime") or 0)
    if state == 1 and t1 <= t0 + 0.5:
        warn("playback clock", f"time barely advanced ({t0:.1f} -> {t1:.1f}) — YouTube may still be buffering")
    else:
        ok("playback clock", f"{t0:.1f}s -> {t1:.1f}s")

    req("POST", f"{API}/transport/pause", {})
    time.sleep(0.8)
    _, paused, _ = req("GET", f"{API}/now-playing")
    pause_time = float((paused or {}).get("currentTime") or 0)
    ok("paused", f"time={pause_time:.1f}s state={(paused or {}).get('state')}")

    req("POST", f"{API}/transport/play", {})
    time.sleep(1.5)
    _, resumed, _ = req("GET", f"{API}/now-playing")
    resume_time = float((resumed or {}).get("currentTime") or 0)
    resume_state = (resumed or {}).get("state")
    if resume_state != 1:
        fail("resume", f"state={resume_state} expected 1")
    elif resume_time < pause_time - 3:
        fail("resume position", f"restarted at {resume_time:.1f}s (was {pause_time:.1f}s)")
    else:
        ok("resume", f"time={resume_time:.1f}s (was {pause_time:.1f}s)")


def check_status_surfaces() -> None:
    section("Status surfaces (UI wiring data)")
    _, status, _ = req("GET", f"{API}/status")
    if not status:
        fail("status", "empty")
        return
    for key in ("interstitialMessage", "lastPlaybackError", "volumeLevel", "currentTitle"):
        if key in status:
            ok(f"status.{key}", str(status.get(key))[:50])
        else:
            warn("status schema", f"missing {key}")


def main() -> int:
    print(f"Deskreen S24+Tab S8 ecosystem audit → {BASE}")
    check_connectivity()
    if FAILURES:
        print("\n=== Aborted (tablet unreachable) ===")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    check_ui_assets()
    check_status_surfaces()
    check_volume_latency()
    check_volume_across_skips()
    check_play_pause_resume()
    check_skip_chain()
    check_skip_prev()
    check_shuffle_skip_back()

    print("\n=== Summary ===")
    if WARNS:
        print(f"Warnings ({len(WARNS)}):")
        for w in WARNS:
            print(f"  - {w}")
    if FAILURES:
        print(f"Failures ({len(FAILURES)}):")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
