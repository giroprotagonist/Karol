#!/usr/bin/env python3
"""
Verify S24 controller ↔ Tab S8 player pairing contract.
Checks API surface, dj-controller bundle, volume/skip/lock-screen paths.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

HOST = os.environ.get("DESKREEN_HOST", "192.168.68.57")
PORT = os.environ.get("DESKREEN_PORT", "3131")
ORIGIN = f"http://{HOST}:{PORT}"
API = f"{ORIGIN}/api/youtube-dj"
FAILURES: list[str] = []


def ok(msg: str) -> None:
    print(f"  OK  {msg}")


def fail(msg: str) -> None:
    FAILURES.append(msg)
    print(f"  FAIL {msg}")


def req(method: str, url: str, body: dict | None = None) -> dict | None:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json", "X-Deskreen-Client": "DeskreenPairing/1.0"}
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=12) as resp:
            raw = resp.read().decode()
            if not raw:
                return {}
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                return None
    except urllib.error.HTTPError as e:
        fail(f"{method} {url} HTTP {e.code}")
        return None


def section(title: str) -> None:
    print(f"\n=== {title} ===")


def check_discovery() -> None:
    section("Discovery (what S24 auto-find uses)")
    data = req("GET", f"{ORIGIN}/api/discover.json")
    if not data:
        fail("discover endpoint")
        return
    for key in ("host", "port", "djControllerUrl", "youtubeDjHealthUrl"):
        if key not in data:
            fail(f"discover missing {key}")
        else:
            ok(f"discover.{key} = {data.get(key)}")
    if data.get("role") != "dj-player":
        fail(f"discover role={data.get('role')} expected dj-player")
    else:
        ok("discover role=dj-player")


def check_controller_spa() -> None:
    section("dj-controller SPA (S24 WebView loads this)")
    try:
        with urllib.request.urlopen(f"{ORIGIN}/dj-controller/", timeout=12) as resp:
            html = resp.read().decode()
    except Exception as e:
        fail(f"dj-controller HTML: {e}")
        return
    if "Deskreen DJ" not in html and "root" not in html:
        fail("dj-controller HTML missing app shell")
    else:
        ok("dj-controller HTML loads")
    js_match = re.search(r'assets/(index-[^"]+\.js)', html)
    if not js_match:
        fail("dj-controller bundle js not referenced")
        return
    js_path = js_match.group(1)
    try:
        with urllib.request.urlopen(f"{ORIGIN}/dj-controller/assets/{js_path}", timeout=12) as resp:
            js = resp.read().decode(errors="replace")
    except Exception as e:
        fail(f"bundle js: {e}")
        return
    ok(f"bundle js {js_path} ({len(js)} bytes)")
    for needle, label in (
        ("/transport/skip-next", "skip-next API path"),
        ("/transport/volume", "volume API path"),
        ("__deskreenNativeVolume", "native volume bridge"),
        ("onConnectionState", "native connection bridge"),
    ):
        if needle not in js:
            fail(f"bundle missing {label}")
        else:
            ok(f"bundle has {label}")


def check_api_contract() -> None:
    section("API contract (S24 native + WebView)")
    health = req("GET", f"{API}/health")
    if not health or not health.get("ok"):
        fail("health")
    else:
        ok(f"health host={health.get('host')} showActive={health.get('showActive')}")
    for key in ("volumeLevel", "showActive", "hostMode", "interstitialMessage"):
        if key in (health or {}):
            ok(f"health.{key}")
        else:
            fail(f"health missing {key}")
    status = req("GET", f"{API}/status")
    if not status:
        fail("status")
    else:
        ok("status")
    np = req("GET", f"{API}/now-playing")
    if np is None:
        fail("now-playing")
    else:
        for key in ("title", "videoId", "state", "volumeLevel", "currentTime", "duration"):
            if key in np:
                ok(f"now-playing.{key}")
            else:
                fail(f"now-playing missing {key}")
    queue = req("GET", f"{API}/queue")
    if not queue or "queue" not in queue:
        fail("queue")
    else:
        ok(f"queue length={len(queue.get('queue', []))}")


def check_native_transport() -> None:
    section("Native transport (lock screen / notification / Vol keys)")
    req("POST", f"{API}/transport/volume", {"level": 0.6})
    time.sleep(0.2)
    health = req("GET", f"{API}/health")
    vol = float((health or {}).get("volumeLevel", -1))
    if abs(vol - 0.6) > 0.03:
        fail(f"volume set 0.6 read {vol}")
    else:
        ok(f"volume proxy {vol:.2f}")
    play = req("POST", f"{API}/transport/play", {})
    if not play or not play.get("ok"):
        fail("transport/play")
    else:
        ok("transport/play")
    skip = req("POST", f"{API}/transport/skip-next", {})
    if not skip or not skip.get("ok"):
        fail("transport/skip-next")
    else:
        np = skip.get("nowPlaying") or {}
        ok(f"skip-next → {(np.get('title') or '')[:40]}")
    back = req("POST", f"{API}/transport/skip-prev", {})
    if not back or not back.get("ok"):
        fail("transport/skip-prev")
    else:
        ok("transport/skip-prev")
    shuffle = req("PATCH", f"{API}/shuffle", {"enabled": True})
    if not shuffle or not shuffle.get("ok"):
        fail("shuffle enable")
    else:
        ok("shuffle PATCH")
    req("PATCH", f"{API}/shuffle", {"enabled": False})


def main() -> int:
    print(f"S24 ↔ S8 pairing audit → {ORIGIN}")
    check_discovery()
    check_controller_spa()
    check_api_contract()
    check_native_transport()
    print("\n=== Summary ===")
    if FAILURES:
        print(f"{len(FAILURES)} failure(s):")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("S24 and S8 are aligned — pairing contract OK.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
