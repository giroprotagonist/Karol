#!/bin/bash
# Karol show setup — UMC PA (no TV / AirPlay).
# Option B: UMC mic + BlackHole Karol → Karol Live Mic → Live → UMC404HD → PA
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTS="$ROOT/scripts"
LIVE_MIC="${KAROL_LIVE_MIC_NAME:-Karol Live Mic}"
UMC_OUT="${KAROL_UMC_NAME:-UMC404HD 192k}"
BH_NAME="${KAROL_BLACKHOLE_NAME:-BlackHole 2ch}"
UMC_NAME="${KAROL_UMC_NAME:-UMC404HD 192k}"
LIVE_LOG="${HOME}/Library/Preferences/Ableton/Live 11.3.43/Log.txt"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

step()  { echo -e "${CYAN}→${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}!${NC} $1"; }

echo ""
echo -e "${BOLD}═══ KAROL UMC PA SETUP ═══${NC}"
echo ""

if pgrep -x Live >/dev/null 2>&1; then
  warn "Quit Ableton Live (Cmd+Q) before running, then reopen after this finishes."
  if [[ -t 0 && "${KAROL_SHOW_FORCE:-}" != "1" ]]; then
    read -r -p "Press Enter when Live is quit, or Ctrl+C… "
  fi
fi

step "BlackHole + UMC → 48000 Hz (stable laptop rate)"
BH48="$SCRIPTS/blackhole-48000"
if [[ ! -x "$BH48" ]]; then
  swiftc -O -o "$BH48" "$SCRIPTS/blackhole-48000.swift"
fi
if "$BH48"; then
  ok "Audio devices at 48000 Hz"
else
  warn "48000 align failed — quit Ableton and retry, or run: scripts/karol-fix-laptop-audio-stable.sh"
fi

step "macOS output → $BH_NAME (Karol feeds Live)"
"$SCRIPTS/set-default-blackhole.sh"
ok "Karol audio routes into Live via BlackHole"

step "Karol Live Mic aggregate (BlackHole + $UMC_NAME)"
CREATE_UMC="$SCRIPTS/karol-create-live-umc-aggregate"
if [[ ! -x "$CREATE_UMC" ]]; then
  swiftc -O -o "$CREATE_UMC" "$SCRIPTS/karol-create-live-umc-aggregate.swift"
fi
if KAROL_UMC_NAME="$UMC_NAME" "$CREATE_UMC"; then
  ok "$LIVE_MIC aggregate created"
else
  warn "Aggregate API returned non-zero — will fix plist next"
fi

step "Fix aggregate plist (UMC outs OFF, drift ON) — must run AFTER create"
PY="$(command -v python3)"
if [[ "$(id -u)" -eq 0 ]]; then
  "$PY" "$SCRIPTS/karol-fix-plist-aggregate.py" || true
elif osascript -e "do shell script \"$PY $SCRIPTS/karol-fix-plist-aggregate.py\" with administrator privileges" 2>/dev/null; then
  ok "Plist fixed"
  sleep 2
else
  warn "Run: sudo python3 $SCRIPTS/karol-fix-plist-aggregate.py"
fi

step "Audio probe"
PROBE_JSON="$("$SCRIPTS/karol-audio-probe" 2>/dev/null || true)"
KLM_IN="$(echo "$PROBE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); k=d.get('karolLiveMic') or {}; print(k.get('inputChannels',''))" 2>/dev/null || true)"
KLM_OUT="$(echo "$PROBE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); k=d.get('karolLiveMic') or {}; print(k.get('outputChannels',''))" 2>/dev/null || true)"
if [[ "$KLM_IN" == "6" && "$KLM_OUT" == "2" ]]; then
  ok "$LIVE_MIC probe: ${KLM_IN} in / ${KLM_OUT} out"
elif [[ -n "$KLM_IN" ]]; then
  warn "$LIVE_MIC probe: ${KLM_IN:-?} in / ${KLM_OUT:-?} out — open Audio MIDI Setup, remove Offline Device, uncheck UMC outputs"
fi

if [[ -f "$LIVE_LOG" ]]; then
  CH=$(grep "Input Channels:" "$LIVE_LOG" 2>/dev/null | tail -1 | grep -oE '[0-9]+$' || echo "?")
  if [[ "$CH" == "6" ]]; then
    ok "Live log: Input Channels: 6"
  else
    warn "Live log shows Input Channels: ${CH:-unknown} — enable ch 1-6 after reopening Live"
  fi
fi

echo ""
echo -e "${BOLD}── Open Ableton Live and set ──${NC}"
echo "  Preferences → Audio:"
echo "    Sample Rate:  48000 Hz"
echo "    Audio Input:  $LIVE_MIC"
echo "    Audio Output:      $UMC_OUT   ← PA / monitors on UMC main outs"
echo "    Buffer Size:       512 samples   (256 OK if stable — NOT 64)"
echo "  Input Config:   enable channels 1, 2, 3, 4, 5, 6"
echo ""
echo "  Track 1 (mic):   $LIVE_MIC / 3,   Monitor In, Arm ON  (UMC input 1 — use 3-4 if stereo pair)"
echo "  Track 2 (Karol): $LIVE_MIC / 1-2, Monitor In, Arm OFF"
echo "  Master:          $UMC_OUT / 1-2"
echo ""
echo "  Add Autotuna on Track 1, then:"
echo "    python3 $SCRIPTS/karol-charli-autotuna.py"
echo ""
echo -e "${BOLD}── Hear audio ──${NC}"
echo "  macOS stays on $BH_NAME (Karol → Live). PA hears Live output on $UMC_OUT."
echo "  Play a song in Karol, press Space in Live."
echo ""
