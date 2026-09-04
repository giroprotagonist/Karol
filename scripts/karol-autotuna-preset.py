#!/usr/bin/env python3
"""Apply Autotuna presets to Ableton Live via AbletonOSC.

Presets: karaoke (general), charli (Von Dutch), believe (Cher), one-more-time (Daft Punk)

Usage:
  python3 scripts/karol-autotuna-preset.py karaoke
  python3 scripts/karol-autotuna-preset.py believe
  python3 scripts/karol-autotuna-preset.py one-more-time --track 0
  python3 scripts/karol-autotuna-preset.py --list
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

from pythonosc import udp_client

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from karol_autotuna_lib import NOTES_TOP_TO_BOTTOM, PRESETS, OscClient, apply_preset


def print_report(report: dict) -> None:
    preset = PRESETS[report["preset"]]
    print(f"=== {preset.artist} — {preset.title} (Autotuna) ===")
    print(f"Track {report['track_index']} ({report.get('track_name')})")
    print(f"Device {report['device_index']} ({report['device_name']})")
    print("\nSet OK:")
    for line in report["set_ok"]:
        print(f"  - {line}")
    if report["set_failed"]:
        print("\nSet FAILED:")
        for line in report["set_failed"]:
            print(f"  - {line}")
    if report["manual"]:
        print("\nManual (if grid grey/wrong):")
        for line in report["manual"]:
            print(f"  - {line}")
    if report["errors"]:
        print("\nNotes:")
        for line in report["errors"]:
            print(f"  - {line}")
    print("\nRead-back:")
    rb = report["readback"]
    for k in ("tempo", "tonic", "pattern", "amount", "dry_wet", "quality", "gain", "sibilance", "correction"):
        if k in rb:
            print(f"  {k}: {rb[k]}")
    if "scale_notes" in rb:
        print("  scale:")
        for note in NOTES_TOP_TO_BOTTOM:
            val = rb["scale_notes"].get(note)
            want = "ON" if note in preset.scale_on else "off"
            got = "ON" if val and val >= 0.5 else "off"
            mark = "OK" if got == want else "FIX"
            print(f"    {note}: {got} (want {want}) [{mark}]")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "preset",
        nargs="?",
        choices=list(PRESETS.keys()),
        help="Preset id: karaoke, charli, believe, one-more-time",
    )
    parser.add_argument("--list", action="store_true", help="List presets and exit")
    parser.add_argument("--track", type=int, default=None, help="Track index (default: auto-find Autotuna)")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-reset", action="store_true", help="Skip scale reset before apply")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    if args.list:
        for p in PRESETS.values():
            print(f"{p.id:16}  {p.artist} — {p.title}  @ {p.tempo:.0f} BPM  key={p.tonic}")
            print(f"                 {p.manual_hint()}")
        return 0

    if not args.preset:
        parser.error("preset required (or use --list)")

    preset = PRESETS[args.preset]
    osc = OscClient(client=udp_client.SimpleUDPClient("127.0.0.1", 11000))
    server = osc.start_listener()
    time.sleep(0.1)
    try:
        report = apply_preset(
            osc,
            preset,
            track=args.track,
            dry_run=args.dry_run,
            reset=not args.no_reset,
        )
    finally:
        server.shutdown()

    if args.json:
        print(json.dumps(report, indent=2, default=str))
        return 0

    print_report(report)
    return 0 if not report["set_failed"] else 1


if __name__ == "__main__":
    sys.exit(main())
