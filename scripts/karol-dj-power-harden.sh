#!/bin/bash
# Harden macOS power settings for an always-plugged Karol DJ laptop.
# Prefer USB/disk/idle sleep off on AC; optional battery profile for gigs on UPS.
#
# NOTE: Modern macOS has NO `pmset usb` key (selective suspend is not exposed).
# Hub sleep is prevented by: caffeinate -ims, Karol powerSaveBlocker, light
# I/O to /Volumes/maxone, and staying on AC with sleep=0 / disksleep=0.
#
# Requires sudo for pmset changes.

set -euo pipefail

MODE="${1:-ac}" # ac | battery | both | show

echo "=== Current pmset ==="
pmset -g custom
echo
echo "=== Assertions (USB/caffeinate) ==="
pmset -g assertions | head -40
echo

apply_ac() {
  # Always-on DJ on wall power — do NOT use disablesleep (too broad / lid quirks).
  sudo pmset -c sleep 0
  sudo pmset -c disksleep 0
  sudo pmset -c displaysleep 0
  sudo pmset -c powernap 0
  sudo pmset -c standby 0
  sudo pmset -c autopoweroff 0 2>/dev/null || true
  sudo pmset -c tcpkeepalive 1
  sudo pmset -c ttyskeepawake 1
  sudo pmset -c womp 1
  sudo pmset -c hibernatemode 0
  echo "Applied AC (charger) DJ profile."
}

apply_battery() {
  # Only if you intentionally run a gig on battery/UPS. Still prefer plugging in.
  sudo pmset -b sleep 0
  sudo pmset -b disksleep 0
  sudo pmset -b displaysleep 0
  sudo pmset -b powernap 0
  sudo pmset -b standby 0
  sudo pmset -b lessbright 0
  echo "Applied battery DJ profile (sleep/disksleep off)."
}

case "$MODE" in
  show) exit 0 ;;
  ac) apply_ac ;;
  battery) apply_battery ;;
  both) apply_ac; apply_battery ;;
  *)
    echo "Usage: $0 [ac|battery|both|show]"
    exit 1
    ;;
esac

echo
echo "=== After ==="
pmset -g custom
echo
echo "Tip: Closed-lid karaoke still needs AC + HDMI (Karol Closed-lid ready)."
echo "     Plug the Mac in — battery idle sleep was the main hub-killer risk."
