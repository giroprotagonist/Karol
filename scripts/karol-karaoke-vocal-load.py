#!/usr/bin/env python3
"""Load the general Karol Karaoke vocal chain onto Live's MIC track.

Order (required — Autotuna must stay outside the FX rack):
  1. Karol Karaoke Autotuna
  2. Karol Karaoke Vocal FX

Then applies chromatic Autotuna settings (any key, ~78%, latency off).

Requires: Ableton Live open with AbletonOSC, MIC track selected/available.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time

from pythonosc import udp_client

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from karol_autotuna_lib import PRESETS, OscClient, apply_preset

UL = os.path.expanduser("~/Music/Ableton/User Library/Presets/Audio Effects")
AUTOTUNA_ADV = os.path.join(UL, "Max Audio Effect", "Karol Karaoke Autotuna.adv")
VOCAL_FX_ADG = os.path.join(UL, "Audio Effect Rack", "Karol Karaoke Vocal FX.adg")
LIVE_APP = "Ableton Live 11 Suite"


def _open_preset(path: str) -> None:
    subprocess.run(["osascript", "-e", f'tell application "{LIVE_APP}" to activate'], check=False)
    time.sleep(0.35)
    subprocess.run(["open", "-a", LIVE_APP, path], check=False)


def main() -> int:
    for p in (AUTOTUNA_ADV, VOCAL_FX_ADG):
        if not os.path.isfile(p):
            print(f"Missing preset: {p}", file=sys.stderr)
            return 1

    osc = OscClient(client=udp_client.SimpleUDPClient("127.0.0.1", 11000))
    server = osc.start_listener()
    time.sleep(0.1)
    try:
        track = 0
        osc.send("/live/view/set/selected_track", track, wait=0.15)
        nd = osc.query("/live/track/get/num_devices", track, wait=0.25)
        n = int(nd[0][1][1]) if nd else 0
        if n == 0:
            print("Loading Karol Karaoke Autotuna…")
            osc.send("/live/api/show_message", "Loading Karol Karaoke Autotuna…", wait=0.15)
            _open_preset(AUTOTUNA_ADV)
            time.sleep(2.5)
            print("Loading Karol Karaoke Vocal FX…")
            osc.send("/live/view/set/selected_track", track, wait=0.1)
            osc.send("/live/api/show_message", "Loading Karol Karaoke Vocal FX…", wait=0.15)
            _open_preset(VOCAL_FX_ADG)
            time.sleep(3.0)
        else:
            print(f"Track {track} already has {n} device(s) — skipping file load, applying Autotuna only")

        osc.send("/live/track/set/name", track, "MIC Karaoke", wait=0.15)
        report = apply_preset(osc, PRESETS["karaoke"], track=track, reset=True)
        print("Devices:")
        nd = osc.query("/live/track/get/num_devices", track, wait=0.2)
        n = int(nd[0][1][1]) if nd else 0
        for d in range(n):
            name_r = osc.query("/live/device/get/name", track, d, wait=0.12)
            name = name_r[0][1][2] if name_r else "?"
            print(f"  [{d}] {name}")
        print("Autotuna:", ", ".join(report["set_ok"][-6:]))
        if report["set_failed"]:
            print("FAILED:", report["set_failed"])
            return 1
        osc.send("/live/api/show_message", "Karol Karaoke vocal chain ready", wait=0.15)
        print("OK — sing into UMC In 1 (Monitor In, Arm ON)")
        return 0
    finally:
        server.shutdown()


if __name__ == "__main__":
    sys.exit(main())
