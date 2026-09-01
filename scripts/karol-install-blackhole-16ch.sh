#!/bin/bash
# Install BlackHole 16ch (needed for multi-track Ableton routing: 1-2 karaoke, 3-4 BGM, etc.)
# and rebuild the Karol shared Multi-Output / aggregate layout.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="${BLACKHOLE16_PKG:-/opt/homebrew/Caskroom/blackhole-16ch/0.7.1/BlackHole16ch-0.7.1.pkg}"
HAL="/Library/Audio/Plug-Ins/HAL"

echo "═══ BlackHole 16ch + Karol shared audio ═══"
echo ""

if [[ -d "$HAL/BlackHole16ch.driver" ]]; then
  echo "✓ BlackHole16ch.driver already installed"
else
  if [[ ! -f "$PKG" ]]; then
    echo "BlackHole 16ch pkg missing — installing via Homebrew…"
    brew install --cask blackhole-16ch
    PKG="/opt/homebrew/Caskroom/blackhole-16ch/0.7.1/BlackHole16ch-0.7.1.pkg"
  fi
  echo "Installing driver (admin password required)…"
  if sudo installer -pkg "$PKG" -target /; then
    echo "✓ Driver installed"
  else
    echo "Opening installer GUI — finish install, then reboot if macOS asks."
    open "$PKG"
    exit 1
  fi
fi

# CoreAudio may need a kick; reboot is the reliable path after first install
if ! system_profiler SPAudioDataType 2>/dev/null | grep -q 'BlackHole 16ch'; then
  echo ""
  echo "BlackHole 16ch driver is on disk but not loaded yet."
  echo "→ Quit Ableton Live + Karol, then reboot (or: sudo killall coreaudiod)"
  echo "  After reboot you should see: BlackHole 16ch (16 in / 16 out)"
  exit 2
fi

echo "✓ BlackHole 16ch visible to CoreAudio"
echo ""
echo "Ableton / shared-device routing with BlackHole 16ch:"
echo "  Track Karol DJ:     Ext. In → BlackHole 16ch / 1-2"
echo "  Track BGM:          Ext. In → BlackHole 16ch / 3-4"
echo "  (spare):            channels 5-6, 7-8, …"
echo ""
echo "macOS output for Karol player → BlackHole 16ch (or Multi-Output 'Karol')"
echo "  bash $ROOT/scripts/set-default-blackhole.sh   # sets 2ch — prefer Audio MIDI Setup for 16ch"
echo ""
echo "Create Multi-Output 'Karol' in Audio MIDI Setup:"
echo "  1. Open Audio MIDI Setup → + → Create Multi-Output Device"
echo "  2. Check: BlackHole 16ch + UMC404HD 192k (drift on UMC if needed)"
echo "  3. Rename to Karol"
echo "  4. Use as Live Master output when you want speakers + interface"
