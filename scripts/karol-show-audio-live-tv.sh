#!/bin/bash
# Show night: Karol → BlackHole → Ableton Live → Living room TV (44100 Hz).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTS="$ROOT/scripts"
SAS="/opt/homebrew/bin/SwitchAudioSource"
TV_NAME="${KAROL_TV_NAME:-Living room TV}"
BH_NAME="${KAROL_BLACKHOLE_NAME:-BlackHole 2ch}"

echo "═══ Karol show audio: Mirror + Live → TV ═══"
echo ""

# 1) Align BlackHole to 44100 (quit-safe — CoreAudio only)
if [[ -x "$SCRIPTS/blackhole-44100" ]]; then
  echo "[1/2] BlackHole sample rate:"
  "$SCRIPTS/blackhole-44100" || echo "  (warn: align failed — close Ableton and retry)"
else
  echo "[1/2] Compiling blackhole-44100…"
  swiftc -O -o "$SCRIPTS/blackhole-44100" "$SCRIPTS/blackhole-44100.swift"
  "$SCRIPTS/blackhole-44100"
fi

# 2) Route macOS output to BlackHole so Karol player feeds Live
echo ""
echo "[2/2] Default output:"
"$SCRIPTS/set-default-blackhole.sh"

echo ""
echo "── Ableton Live checklist ──"
echo "  • Audio: Sample Rate 44100 Hz"
echo "  • Input:  BlackHole 2ch (stereo) — arm monitor track for Karol"
echo "  • Output: $TV_NAME (AirPlay)"
echo "  • Do NOT use Shure MVX2U or UMC404HD in this session (48 kHz only)"
echo "  • Master track: output to $TV_NAME"
echo ""
echo "  For Shure mic too, use: $SCRIPTS/karol-show-audio-live-tv-with-mic.sh"
echo "  (Aggregate Device input — see docs/LIVE-TRACK-SETUP.md)"
echo ""
if [[ -x "$SAS" ]]; then
  cur="$("$SAS" -c -t output 2>/dev/null || true)"
  echo "Current macOS output: ${cur:-unknown}"
fi
echo "Video: keep screen mirroring to $TV_NAME (already working)"
echo "Done."
