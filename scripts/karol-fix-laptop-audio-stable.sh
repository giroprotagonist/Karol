#!/bin/bash
# Stabilize laptop + UMC + Live audio (fixes glitchy/dropout aggregate path).
# Root causes: 64-sample buffer, UMC in aggregate + as Live output, 6-out aggregate, 44.1/48 kHz mismatch.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTS="$ROOT/scripts"
LIVE_MIC="${KAROL_LIVE_MIC_NAME:-Karol Live Mic}"
SPEAKERS="${KAROL_SPEAKERS_NAME:-MacBook Pro Speakers}"
BH_NAME="${KAROL_BLACKHOLE_NAME:-BlackHole 2ch}"
UMC_NAME="${KAROL_UMC_NAME:-UMC404HD 192k}"
TARGET_SR=48000

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

step()  { echo -e "${CYAN}→${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}!${NC} $1"; }
fail()  { echo -e "${RED}✗${NC} $1"; }

echo ""
echo -e "${BOLD}═══ KAROL LAPTOP AUDIO STABILITY FIX ═══${NC}"
echo ""

if pgrep -x Live >/dev/null 2>&1; then
  warn "Quit Ableton Live (Cmd+Q) first — CoreAudio locks devices while Live is open."
  if [[ -t 0 && "${KAROL_SHOW_FORCE:-}" != "1" ]]; then
    read -r -p "Press Enter when Live is quit, or Ctrl+C… "
  fi
fi

step "Align BlackHole + UMC → ${TARGET_SR} Hz (native laptop rate)"
BH48="$SCRIPTS/blackhole-48000"
if [[ ! -x "$BH48" ]]; then
  swiftc -O -o "$BH48" "$SCRIPTS/blackhole-48000.swift"
fi
if "$BH48"; then
  ok "Devices at ${TARGET_SR} Hz"
else
  warn "Rate align failed — quit all apps using audio and re-run"
fi

step "Rebuild $LIVE_MIC (BH ch1-2 + UMC ch3-6)"
CREATE_UMC="$SCRIPTS/karol-create-live-umc-aggregate"
if [[ ! -x "$CREATE_UMC" ]]; then
  swiftc -O -o "$CREATE_UMC" "$SCRIPTS/karol-create-live-umc-aggregate.swift"
fi
KAROL_UMC_NAME="$UMC_NAME" "$CREATE_UMC" || true

step "Fix aggregate plist AFTER recreate (UMC drift ON, UMC outputs OFF)"
PY="$(command -v python3)"
PLIST_OK=false
if [[ "$(id -u)" -eq 0 ]]; then
  if "$PY" "$SCRIPTS/karol-fix-plist-aggregate.py"; then PLIST_OK=true; fi
elif osascript -e "do shell script \"$PY $SCRIPTS/karol-fix-plist-aggregate.py\" with administrator privileges" 2>/dev/null; then
  PLIST_OK=true
else
  warn "Run plist fix manually (must be LAST step, after recreate):"
  echo "    sudo python3 $SCRIPTS/karol-fix-plist-aggregate.py"
fi
if [[ "$PLIST_OK" == true ]]; then
  ok "Plist fixed — CoreAudio restarted"
  sleep 2
fi

PROBE_JSON="$("$SCRIPTS/karol-audio-probe" 2>/dev/null || true)"
KLM_IN="$(echo "$PROBE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); k=d.get('karolLiveMic') or {}; print(k.get('inputChannels',''))" 2>/dev/null || true)"
KLM_OUT="$(echo "$PROBE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); k=d.get('karolLiveMic') or {}; print(k.get('outputChannels',''))" 2>/dev/null || true)"
if [[ "$KLM_IN" == "6" && "$KLM_OUT" == "2" ]]; then
  ok "$LIVE_MIC: 6 in / 2 out"
elif [[ -n "$KLM_OUT" && "$KLM_OUT" != "2" ]]; then
  fail "$LIVE_MIC: ${KLM_IN:-?} in / ${KLM_OUT} out — open Audio MIDI Setup, uncheck UMC outputs"
fi

step "macOS output → $BH_NAME (Karol → Live)"
"$SCRIPTS/set-default-blackhole.sh"
ok "Karol routes into Live via BlackHole"

echo ""
echo -e "${BOLD}── Reopen Ableton Live and set EXACTLY ──${NC}"
echo ""
echo "  Preferences → Audio:"
echo "    Sample Rate:       ${TARGET_SR} Hz        ← NOT 44100"
echo "    Audio Input:       $LIVE_MIC"
echo "    Audio Output:      $UMC_NAME   ← PA on UMC main outs"
echo "    Buffer Size:       512 samples   (256 if stable — NOT 64)"
echo ""
echo "  Input Config: enable channels 1–6"
echo "  Track 1 (mic):   $LIVE_MIC / 3-4,  Monitor In, Arm ON"
echo "  Track 2 (Karol): $LIVE_MIC / 1-2,  Monitor In, Arm OFF"
echo "  Master:          $UMC_NAME / 1-2"
echo ""
echo -e "${BOLD}── Why it was glitching ──${NC}"
echo "  • Buffer was 64 samples — too small for USB aggregate"
echo "  • Aggregate had UMC outputs mapped (feedback risk) — plist fix removes them"
echo "  • Input = aggregate, Output = $UMC_NAME directly (correct PA path)"
echo ""
echo "  Play Karol → press Space in Live to hear audio."
echo ""
