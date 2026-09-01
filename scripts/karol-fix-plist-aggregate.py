#!/usr/bin/env python3
"""Fix Karol Live Mic aggregate in SystemSettings.plist (UMC/Shure drift ON, mic outs removed)."""
import datetime
import os
import plistlib
import shutil
import subprocess
import sys

PLIST = "/Library/Preferences/Audio/com.apple.audio.SystemSettings.plist"
AGG_KEYS = [
    "MetaDevice.com.karol.live-mic-aggregate",
    "MetaDevice.com.karol.mic-ch1-aggregate",
    "MetaDevice.~:AMS2_Aggregate:0",
]
AGG_NAMES = {"Karol Live Mic", "Karol Mic Ch1", "Aggregate Device"}


def fix_meta(meta: dict) -> bool:
    changed = False
    subs = meta.get("subdevices", [])
    for sub in subs:
        name = sub.get("name", "")
        if "Shure" in name or "UMC404" in name:
            if sub.get("channels-out", 0) != 0:
                sub["channels-out"] = 0
                changed = True
                print(f"  {name}: channels-out → 0")
            if sub.get("drift", 0) != 1:
                sub["drift"] = 1
                changed = True
                print(f"  {name}: drift correction → ON")
        if "Offline" in name:
            print(f"  {name}: remove stale Offline Device in Audio MIDI Setup")
        if "BlackHole" in name:
            if sub.get("drift", 0) != 0:
                sub["drift"] = 0
                changed = True
                print(f"  {name}: drift correction → OFF (clock master)")
    return changed


def main() -> int:
    if not os.access(PLIST, os.W_OK):
        print("NEEDS_ADMIN", file=sys.stderr)
        return 2

    with open(PLIST, "rb") as f:
        data = plistlib.load(f)

    any_changed = False
    for key in AGG_KEYS:
        meta = data.get(key)
        if not meta or meta.get("name") not in AGG_NAMES:
            continue
        print(f"Fixing {meta.get('name')} ({key}):")
        if fix_meta(meta):
            any_changed = True
        else:
            print("  already correct")

    if not any_changed:
        print("No plist changes needed.")
        return 0

    backup = PLIST + ".bak-karol-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    shutil.copy2(PLIST, backup)
    print(f"Backup: {backup}")

    with open(PLIST, "wb") as f:
        plistlib.dump(data, f)
    print("Plist saved. Restarting CoreAudio…")
    subprocess.run(["killall", "coreaudiod"], check=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
