#!/bin/bash
# Show night: Karol + Shure mic → Aggregate → Ableton Live → Living room TV (44100 Hz).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTS="$ROOT/scripts"
SAS="/opt/homebrew/bin/SwitchAudioSource"
TV_NAME="${KAROL_TV_NAME:-Living room TV}"
BH_NAME="${KAROL_BLACKHOLE_NAME:-BlackHole 2ch}"
AGG_NAME="${KAROL_AGGREGATE_NAME:-Karol Live Mic}"
LIVE_MIC_NAME="${KAROL_LIVE_MIC_NAME:-Karol Live Mic}"

echo "═══ Karol show audio: Live → TV + Shure mic ═══"
echo ""

# 1) Align BlackHole to 44100 (aggregate clock source)
if [[ -x "$SCRIPTS/blackhole-44100" ]]; then
  echo "[1/3] BlackHole sample rate:"
  "$SCRIPTS/blackhole-44100" || echo "  (warn: align failed — quit Ableton and retry)"
else
  echo "[1/3] Compiling blackhole-44100…"
  swiftc -O -o "$SCRIPTS/blackhole-44100" "$SCRIPTS/blackhole-44100.swift"
  "$SCRIPTS/blackhole-44100"
fi

# 2) Route macOS output to BlackHole so Karol player feeds Live via aggregate ch 1-2
echo ""
echo "[2/3] Default output:"
"$SCRIPTS/set-default-blackhole.sh"

# 3) Verify aggregate is present and configured
echo ""
echo "[3/3] Aggregate device check:"
if ! system_profiler SPAudioDataType 2>/dev/null | grep -q "$AGG_NAME"; then
  echo "  $AGG_NAME not found — creating via CoreAudio API…"
  CREATE_BIN="$SCRIPTS/karol-create-live-mic-aggregate"
  if [[ ! -x "$CREATE_BIN" ]]; then
    swiftc -O -o "$CREATE_BIN" "$SCRIPTS/karol-create-live-mic-aggregate.swift"
  fi
  "$CREATE_BIN" || {
    echo "  ERROR: could not create $AGG_NAME"
    echo "  Run: $SCRIPTS/karol-show-night.sh"
    exit 1
  }
fi

AGG_SR="$(system_profiler SPAudioDataType 2>/dev/null | awk -v n="$AGG_NAME" '$0 ~ n {found=1} found && /Current SampleRate/ {gsub(/[^0-9]/,"",$3); print $3; exit}')"
AGG_CH="$(system_profiler SPAudioDataType 2>/dev/null | awk -v n="$AGG_NAME" '$0 ~ n {found=1} found && /Input Channels/ {print $3; exit}')"
echo "  $AGG_NAME: ${AGG_SR:-?} Hz, ${AGG_CH:-?} inputs"

if [[ "$AGG_SR" != "44100" ]]; then
  echo "  WARN: Aggregate should be 44100 Hz (clock = BlackHole). Open Audio MIDI Setup and confirm."
fi
if [[ "$AGG_CH" != "3" ]]; then
  echo "  WARN: Expected 3 inputs (BlackHole 1-2 + Shure 3). Check aggregate wiring."
fi

echo ""
echo "── Shure mic note ──"
echo "  Shure MVX2U is 48000 Hz native but WORKS at 44100 through the aggregate"
echo "  when drift correction is ON (already configured on this Mac)."
echo "  Do NOT select Shure MVX2U directly in Live — use $AGG_NAME ch 3."
echo ""
echo "── Ableton Live checklist ──"
echo "  • Sample Rate: 44100 Hz"
echo "  • Audio Input:  $AGG_NAME (NOT BlackHole alone, NOT Shure alone)"
echo "  • Audio Output: $TV_NAME"
echo "  • Input Config: channels 1, 2, 3 enabled"
echo "  • Track 1 Karol: Ext. In $AGG_NAME 1-2, Monitor In"
echo "  • Track 2 Mic:   Ext. In $AGG_NAME 3 (mono), Monitor In, ARM"
echo "  • Master → $TV_NAME"
echo ""
if [[ -x "$SAS" ]]; then
  cur="$("$SAS" -c -t output 2>/dev/null || true)"
  echo "Current macOS output: ${cur:-unknown}"
fi
echo "Video: screen mirroring to $TV_NAME"
echo ""
echo "Verify: $SCRIPTS/karol-audio-verify.sh"
echo "Done."
