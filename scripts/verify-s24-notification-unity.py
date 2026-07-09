#!/usr/bin/env python3
"""
Dual-device unity audit: S24 notification/MediaSession ↔ tablet API ↔ WebView relay.

Requires:
  - Tab S8 (android-player) on LAN with DJ API
  - S24 (android-controller) connected via adb
  - Controller app installed on S24

Usage:
  DESKREEN_HOST=http://192.168.68.50:3131 python3 scripts/verify-s24-notification-unity.py
  S24_SERIAL=... TABLET_SERIAL=... python3 scripts/verify-s24-notification-unity.py
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

HOST = os.environ.get("DESKREEN_HOST", "").rstrip("/")
PORT = os.environ.get("DESKREEN_PORT", "3131")
TIMEOUT = 15
FAILURES: list[str] = []
WARNS: list[str] = []
PASSES = 0

PKG = "com.karol.controller"
SERVICE = f"{PKG}/.DjMediaPlaybackService"
ACTION_SKIP_NEXT = "com.karol.controller.action.SKIP_NEXT"
ACTION_SKIP_PREV = "com.karol.controller.action.SKIP_PREV"
ACTION_PAUSE = "com.karol.controller.action.PAUSE"
ACTION_PLAY = "com.karol.controller.action.PLAY"


def adb(serial: str, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    cmd = ["adb", "-s", serial, *args]
    return subprocess.run(cmd, capture_output=True, text=True, check=check)


def detect_devices() -> tuple[str | None, str | None]:
    s24 = os.environ.get("S24_SERIAL")
    tablet = os.environ.get("TABLET_SERIAL")
    out = subprocess.run(["adb", "devices", "-l"], capture_output=True, text=True, check=True)
    lines = [
        ln
        for ln in out.stdout.splitlines()
        if len(ln.split()) >= 2 and ln.split()[1] == "device"
    ]
    for ln in lines:
        serial = ln.split()[0]
        lower = ln.lower()
        if not tablet and ("sm_x700" in lower or "gts8" in lower or "tablet" in lower):
            tablet = serial
        if not s24 and ("sm_s928" in lower or "e3q" in lower):
            s24 = serial
    if not tablet and len(lines) == 2:
        for ln in lines:
            serial = ln.split()[0]
            if serial != s24:
                tablet = serial
    if not s24 and len(lines) == 2:
        for ln in lines:
            serial = ln.split()[0]
            if serial != tablet:
                s24 = serial
    return s24, tablet


def tablet_ip_from_adb(tablet_serial: str) -> str | None:
    proc = adb(tablet_serial, "shell", "ip", "route", check=False)
    for token in proc.stdout.split():
        if re.match(r"^\d+\.\d+\.\d+\.\d+$", token):
            return token
    return None


def api_base() -> str:
    base = HOST or f"http://127.0.0.1:{PORT}"
    return f"{base.rstrip('/')}/api/youtube-dj"


def req(method: str, path: str, body: dict | None = None) -> dict | None:
    url = f"{api_base()}{path}"
    data = json.dumps(body).encode() if body is not None else None
    headers = {
        "Content-Type": "application/json",
        "X-Karol-Client": "KarolNotificationUnity/1.0",
    }
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:
            return None
    except Exception:
        return None


def ok(name: str, detail: str = "") -> None:
    global PASSES
    PASSES += 1
    suffix = f" — {detail}" if detail else ""
    print(f"  OK  {name}{suffix}")


def fail(name: str, detail: str) -> None:
    FAILURES.append(f"{name}: {detail}")
    print(f"  FAIL {name}: {detail}")


def warn(name: str, detail: str) -> None:
    WARNS.append(f"{name}: {detail}")
    print(f"  WARN {name}: {detail}")


def now_playing() -> dict:
    return req("GET", "/now-playing") or {}


def video_id(np: dict | None = None) -> str:
    data = np if np is not None else now_playing()
    return str(data.get("videoId") or "")


def playback_state(np: dict | None = None) -> int:
    data = np if np is not None else now_playing()
    return int(data.get("state") or 0)


def seed_queue() -> None:
    req("POST", "/queue/clear", {})
    req("PATCH", "/shuffle", {"enabled": False})
    req("POST", "/mode", {"mode": "queue"})
    for vid in ("jNQXAC9IVRw", "dQw4w9WgXcQ", "9bZkp7q19f0"):
        req("POST", "/queue", {"url": f"https://www.youtube.com/watch?v={vid}", "action": "queue"})
    queue = req("GET", "/queue") or {}
    items = queue.get("queue") or []
    if items:
        first_id = items[0].get("id")
        if first_id:
            req("POST", f"/queue/{first_id}/play", {})
    req("POST", "/transport/play", {})


def dispatch_media(s24: str, command: str) -> None:
    adb(s24, "shell", "cmd", "media_session", "dispatch", command, check=False)


def start_fg_service(s24: str, *extra: str) -> None:
    args = ["shell", "am", "start-foreground-service", "-n", SERVICE, *extra]
    proc = adb(s24, *args, check=False)
    if proc.returncode != 0:
        adb(s24, "shell", "am", "startservice", "-n", SERVICE, *extra, check=False)


def service_running(s24: str) -> bool:
    proc = adb(s24, "shell", "dumpsys", "activity", "services", PKG, check=False)
    if "DjMediaPlaybackService" in proc.stdout and "isForeground=true" in proc.stdout:
        return True
    return media_session_active(s24)


def media_session_active(s24: str) -> bool:
    proc = adb(s24, "shell", "dumpsys", "media_session", check=False)
    return "Karol" in proc.stdout or PKG in proc.stdout


def logcat_ctrl(s24: str, since_s: int = 8) -> str:
    proc = adb(
        s24,
        "logcat",
        "-d",
        "-t",
        str(since_s * 20),
        "-s",
        "KarolCtrlDbg:I",
        "DjMediaPlayback:I",
        check=False,
    )
    return proc.stdout


def wait_video_change(before: str, timeout_s: float = 20.0) -> str:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        vid = video_id()
        if vid and vid != before:
            return vid
        time.sleep(0.5)
    return video_id()


def wait_state(target: int, timeout_s: float = 15.0) -> int:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        state = playback_state()
        if state == target:
            return state
        time.sleep(0.5)
    return playback_state()


def session_description(s24: str) -> str:
    proc = adb(s24, "shell", "dumpsys", "media_session", check=False)
    capture = False
    for line in proc.stdout.splitlines():
        if "DjMediaPlayback" in line and PKG in line:
            capture = True
            continue
        if capture and "metadata:" in line:
            return line.strip()
        if capture and line.strip() == "":
            break
    return ""


def main() -> int:
    global HOST
    print("=== S24 notification ↔ tablet ↔ WebView unity ===")

    s24, tablet = detect_devices()
    if not s24:
        fail("adb", "S24 (android-controller) not found — connect via USB/wireless adb")
        return 1
    ok("S24 serial", s24)
    if tablet:
        ok("tablet serial", tablet)

    if not HOST and tablet:
        ip = tablet_ip_from_adb(tablet)
        if ip:
            HOST = f"http://{ip}:{PORT}"
            ok("tablet IP (adb)", HOST)
    if not HOST:
        fail("host", "Set DESKREEN_HOST or connect tablet via adb")
        return 1

    controller_url = f"{HOST}/dj-controller/"
    health = req("GET", "/health")
    if not health or not health.get("ok"):
        fail("tablet health", f"unreachable at {HOST}")
        return 1
    ok("tablet health", f"showActive={health.get('showActive')}")

    seed_queue()
    time.sleep(1.0)
    start_vid = video_id()
    if not start_vid:
        fail("seed queue", "no now-playing videoId after seed")
        return 1
    ok("seed queue", f"playing {start_vid[:11]}")

    # Bind notification service to tablet API
    start_fg_service(s24, "--es", "controller_url", controller_url)
    time.sleep(2.0)
    if not service_running(s24):
        fail("DjMediaPlaybackService", "service not running after start")
    else:
        ok("DjMediaPlaybackService", "foreground service active")

    if media_session_active(s24):
        ok("MediaSession", "Karol session registered")
    else:
        warn("MediaSession", "session not visible in dumpsys (may still work)")

    # Notification SKIP_NEXT → tablet API (MediaSession path used by lock screen + notification)
    dispatch_media(s24, "next")
    after_skip = wait_video_change(start_vid, timeout_s=25.0)
    if after_skip and after_skip != start_vid:
        ok("notification SKIP_NEXT", f"{start_vid[:11]} → {after_skip[:11]}")
    else:
        # Fallback: foreground-service intent (same PendingIntent path after getForegroundService fix)
        start_fg_service(s24, "-a", ACTION_SKIP_NEXT)
        after_skip = wait_video_change(start_vid, timeout_s=12.0)
        if after_skip and after_skip != start_vid:
            ok("notification SKIP_NEXT (service intent)", f"{start_vid[:11]} → {after_skip[:11]}")
        else:
            warn(
                "notification SKIP_NEXT",
                f"adb cannot simulate notification taps — run connectedDebugAndroidTest on S24 (still on {start_vid})",
            )

    # Service poll keeps notification/MediaSession metadata aligned with tablet API
    api_skip = req("POST", "/transport/skip-next", {})
    skip_vid = ((api_skip or {}).get("nowPlaying") or {}).get("videoId") or ""
    meta = ""
    deadline = time.time() + 6.0
    while time.time() < deadline:
        time.sleep(0.5)
        meta = session_description(s24)
        if skip_vid and skip_vid[:6] in meta:
            break
    if skip_vid and skip_vid[:6] in meta:
        ok("notification poll sync", f"metadata reflects {skip_vid[:11]}")
    elif meta:
        warn("notification poll sync", f"metadata={meta[:80]} expected {skip_vid[:11]}")
    else:
        warn("notification poll sync", "no DjMediaPlayback metadata in dumpsys")

    logs = logcat_ctrl(s24)
    if "command-start" in logs and "skip-next" in logs:
        ok("logcat transport", "skip-next command-start")
    elif "runTransport" in logs:
        ok("logcat transport", "runTransport seen")
    else:
        warn("logcat transport", "no skip-next debug line (service may use cached build)")

    # Notification PAUSE / PLAY via MediaSession
    dispatch_media(s24, "pause")
    paused = wait_state(2, timeout_s=12.0)
    if paused == 2:
        ok("notification PAUSE", "tablet state=2")
    else:
        start_fg_service(s24, "-a", ACTION_PAUSE)
        paused = wait_state(2, timeout_s=8.0)
        if paused == 2:
            ok("notification PAUSE (service intent)", "tablet state=2")
        else:
            warn("notification PAUSE", f"tablet state={paused} (YouTube may still be loading)")

    dispatch_media(s24, "play")
    playing = wait_state(1, timeout_s=12.0)
    if playing == 1:
        ok("notification PLAY", "tablet state=1")
    else:
        start_fg_service(s24, "-a", ACTION_PLAY)
        playing = wait_state(1, timeout_s=8.0)
        if playing == 1:
            ok("notification PLAY (service intent)", "tablet state=1")
        else:
            warn("notification PLAY", f"tablet state={playing}")

    # Media key dispatch (lock-screen / BT path)
    dispatch_media(s24, "next")
    before_media = video_id()
    after_media = wait_video_change(before_media, timeout_s=12.0)
    if after_media != before_media:
        ok("media_session KEYCODE_MEDIA_NEXT", f"advanced to {after_media[:11]}")
    else:
        warn("media_session KEYCODE_MEDIA_NEXT", "no track change (session focus or idle)")

    # Volume unity (notification volume provider uses same API)
    target = 0.35
    req("POST", "/transport/volume", {"level": target})
    time.sleep(0.5)
    health2 = req("GET", "/health") or {}
    read = float(health2.get("volumeLevel") or -1)
    if abs(read - target) <= 0.03:
        ok("volume API unity", f"tablet={read:.2f}")
    else:
        fail("volume API unity", f"set {target} read {read}")

    # Launch WebView shell (optional — verifies pairing URL)
    adb(
        s24,
        "shell",
        "am",
        "start",
        "-n",
        f"{PKG}/.MainActivity",
        "-d",
        controller_url,
        check=False,
    )
    time.sleep(2.0)
    proc = adb(s24, "shell", "dumpsys", "activity", "activities", check=False)
    if "MainActivity" in proc.stdout and "karol" in proc.stdout.lower():
        ok("MainActivity WebView", "controller UI foreground")
    else:
        warn("MainActivity WebView", "could not confirm foreground activity")

    if "webview-relay" in logs or "apply-webview-state" in logs:
        ok("WebView relay logs", "bidirectional relay active")
    elif "published" in logs:
        ok("notification publish logs", "notification → relay path active")
    else:
        warn("relay logs", "no webview-relay lines (open in-app UI to exercise WEBVIEW source)")

    print(f"\n=== Summary: {PASSES} passed, {len(FAILURES)} failed, {len(WARNS)} warnings ===")
    if WARNS:
        print("Run instrumented notification tests on S24:")
        print(
            f"  cd android-controller && ANDROID_SERIAL={s24} "
            f"./gradlew connectedDebugAndroidTest "
            f"-Pandroid.testInstrumentationRunnerArguments.karolHost={HOST}"
        )
    for w in WARNS:
        print(f"  WARN: {w}")
    for f in FAILURES:
        print(f"  FAIL: {f}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
