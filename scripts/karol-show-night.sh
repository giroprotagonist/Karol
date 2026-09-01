#!/bin/bash
# ═══ KAROL SHOW NIGHT — one command to rule them all ═══
# Karol → BlackHole → Karol Live Mic (Shure ch1 + BH ch2-3) → Ableton Live → TV
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTS="$ROOT/scripts"
LIVE_MIC="${KAROL_LIVE_MIC_NAME:-Karol Live Mic}"
TV_NAME="${KAROL_TV_NAME:-Living room TV}"
BH_NAME="${KAROL_BLACKHOLE_NAME:-BlackHole 2ch}"
LIVE_LOG="${HOME}/Library/Preferences/Ableton/Live 11.3.43/Log.txt"
PLIST_FIX="$SCRIPTS/karol-fix-plist-aggregate.py"

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
echo -e "${BOLD}═══ KAROL SHOW NIGHT SETUP (Plan B: Shure ch1) ═══${NC}"
echo ""

# ── 0a. LOUD warning if macOS output is NOT BlackHole ──
SAS="${SWITCH_AUDIO_SOURCE:-/opt/homebrew/bin/SwitchAudioSource}"
CUR_OUT=""
if [[ -x "$SAS" ]]; then
  CUR_OUT="$("$SAS" -c -t output 2>/dev/null || true)"
fi
if [[ -n "$CUR_OUT" && "$CUR_OUT" != "$BH_NAME" ]]; then
  echo ""
  echo -e "${RED}${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${RED}${BOLD}║  WRONG OUTPUT: ${CUR_OUT}${NC}"
  echo -e "${RED}${BOLD}║  Karol audio is going DIRECT to speakers/TV — NOT through Live!${NC}"
  echo -e "${RED}${BOLD}║  macOS output MUST be ${BH_NAME} for the Live path.${NC}"
  echo -e "${RED}${BOLD}║  You will hear Karol on TV but Live Track 2 stays SILENT.${NC}"
  echo -e "${RED}${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
fi

# ── 0. Warn if Live is running ──
if pgrep -x Live >/dev/null 2>&1; then
  warn "Ableton Live is running — quit it (Cmd+Q) for clean device cache."
  if [[ -t 0 && "${KAROL_SHOW_FORCE:-}" != "1" ]]; then
    echo "  Press Enter when Live is quit, or Ctrl+C to abort."
    read -r
  else
    warn "Continuing anyway (re-quit Live after setup)."
  fi
fi

# ── 1. BlackHole @ 44100 ──
step "BlackHole → 44100 Hz"
if [[ ! -x "$SCRIPTS/blackhole-44100" ]]; then
  swiftc -O -o "$SCRIPTS/blackhole-44100" "$SCRIPTS/blackhole-44100.swift"
fi
"$SCRIPTS/blackhole-44100" || warn "BlackHole rate align failed — quit Ableton and retry"

# ── 2. macOS output → BlackHole ──
step "macOS output → $BH_NAME"
"$SCRIPTS/set-default-blackhole.sh"
NEW_OUT=""
if [[ -x "$SAS" ]]; then
  NEW_OUT="$("$SAS" -c -t output 2>/dev/null || true)"
fi
if [[ "$NEW_OUT" == "$BH_NAME" ]]; then
  ok "macOS output confirmed → $BH_NAME"
else
  echo ""
  echo -e "${RED}${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${RED}${BOLD}║  FAILED to set output to ${BH_NAME} (still: ${NEW_OUT:-unknown})${NC}"
  echo -e "${RED}${BOLD}║  Karol will NOT reach Live until this is fixed!${NC}"
  echo -e "${RED}${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
fi

# ── 3. Create / recreate Karol Live Mic aggregate (Shure ch1 + BH ch2-3) ──
step "Create $LIVE_MIC aggregate (Shure ch1 + BH ch2-3)"
CREATE_BIN="$SCRIPTS/karol-create-live-mic-aggregate"
if [[ ! -x "$CREATE_BIN" ]]; then
  swiftc -O -o "$CREATE_BIN" "$SCRIPTS/karol-create-live-mic-aggregate.swift"
fi
"$CREATE_BIN" || true
sleep 0.5

# ── 4. Fix plist: Shure drift ON, Shure outs removed ──
step "Fix aggregate plist (drift ON, Shure outs off)"
PLIST_OK=false
PY="$(command -v python3)"
if "$PY" "$PLIST_FIX" 2>/dev/null; then
  PLIST_OK=true
  ok "Plist fixed (no admin needed)"
  sleep 2
elif [[ -t 0 ]]; then
  warn "Plist needs admin — showing password dialog (or cancel to skip)…"
  if osascript -e "do shell script \"$PY $PLIST_FIX\" with administrator privileges" 2>/dev/null; then
    PLIST_OK=true
    ok "Plist fixed via admin"
    sleep 2
  else
    warn "Plist fix skipped — run: sudo python3 $PLIST_FIX"
  fi
else
  warn "Plist fix needs admin — run: sudo python3 $PLIST_FIX"
fi

# Re-create aggregate after plist fix (CoreAudio reload may drop API-created device)
if [[ "$PLIST_OK" == true ]]; then
  "$CREATE_BIN" 2>/dev/null || true
  sleep 0.5
fi

# ── 5. Probe aggregate shape ──
PROBE="$SCRIPTS/karol-audio-probe"
if [[ ! -x "$PROBE" ]]; then
  swiftc -O -o "$PROBE" "$SCRIPTS/karol-audio-probe.swift" 2>/dev/null || true
fi
PROBE_JSON="$("$PROBE" 2>/dev/null || echo '{}')"
KLM_IN="$(echo "$PROBE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); k=d.get('karolLiveMic') or {}; print(k.get('inputChannels',''))" 2>/dev/null || true)"
KLM_OUT="$(echo "$PROBE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); k=d.get('karolLiveMic') or {}; print(k.get('outputChannels',''))" 2>/dev/null || true)"
SHURE_DRIFT="$(echo "$PROBE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); k=d.get('karolLiveMic') or {}; print(k.get('shureDrift',''))" 2>/dev/null || true)"

if [[ "$KLM_IN" == "3" ]]; then
  ok "$LIVE_MIC: 3 inputs (Shure ch1 + BH ch2-3)"
else
  fail "$LIVE_MIC: ${KLM_IN:-missing} inputs (need 3)"
fi
if [[ "$KLM_OUT" == "2" ]]; then
  ok "$LIVE_MIC: 2 outputs (BlackHole only)"
elif [[ "$KLM_OUT" == "4" ]]; then
  warn "$LIVE_MIC: 4 outputs (Shure outs still mapped — mic may still work)"
fi
if [[ "$SHURE_DRIFT" == "True" ]]; then
  ok "Shure drift correction ON"
else
  warn "Shure drift correction OFF — run: sudo python3 $PLIST_FIX"
fi

# ── 6. Shure direct test @ 48000 (proves Live+Shure hardware path) ──
step "Test Shure hardware direct @ 48000 Hz"
SHURE_DB=""
if command -v ffmpeg >/dev/null 2>&1; then
  if ffmpeg -y -loglevel error -f avfoundation -i ":Shure MVX2U" -t 2 -ar 48000 /tmp/karol-show-shure.wav 2>/dev/null; then
    SHURE_DB="$(ffmpeg -i /tmp/karol-show-shure.wav -af volumedetect -f null - 2>&1 | awk -F': ' '/mean_volume/ {print $2}' | head -1 || true)"
    SHURE_NUM="${SHURE_DB%dB}"
    if python3 -c "import sys; sys.exit(0 if float('${SHURE_NUM:- -999}') > -80 else 1)" 2>/dev/null; then
      ok "Shure direct @ 48k: ${SHURE_DB} (hardware OK — Live can use aggregate ch1)"
    else
      warn "Shure direct quiet (${SHURE_DB:-none}) — check XLR/gain"
    fi
  fi
fi

# ── 7. Aggregate ch1 mic test (3 sec) ──
step "Test $LIVE_MIC ch1 Shure (3 sec capture — SPEAK NOW)"
MIC_DB=""
MIC_OK=false
if command -v ffmpeg >/dev/null 2>&1; then
  if ffmpeg -y -loglevel error -f avfoundation -i ":$LIVE_MIC" -t 3 -ac 3 -ar 44100 /tmp/karol-show-ch1.wav 2>/dev/null; then
    MIC_DB="$(ffmpeg -i /tmp/karol-show-ch1.wav -af "pan=mono|c0=c0,volumedetect" -f null - 2>&1 | awk -F': ' '/mean_volume/ {print $2}' | head -1 || true)"
    MIC_NUM="${MIC_DB%dB}"
    if python3 -c "import sys; sys.exit(0 if float('${MIC_NUM:- -999}') > -80 else 1)" 2>/dev/null; then
      ok "ch1 Shure signal: ${MIC_DB} → saved /tmp/karol-show-ch1.wav"
      MIC_OK=true
    else
      warn "ch1 quiet (${MIC_DB:-none}) — speak into mic and re-run"
    fi
  fi
fi

# ── 8. QuickTime-style record test hint ──
step "QuickTime record test"
if [[ "$MIC_OK" == true ]]; then
  ok "OS records Shure on ch1 — QuickTime: New Audio Recording → $LIVE_MIC → record → play back"
else
  warn "ch1 dead at OS — QuickTime test will also fail until aggregate fixed"
fi

# ── 9. Live log check ──
step "Check Ableton Live log"
if [[ -f "$LIVE_LOG" ]]; then
  LIVE_IN_CH="$(grep "Audio In Out: Input Channels:" "$LIVE_LOG" | tail -1 | awk '{print $NF}')"
  LIVE_IN_DEV="$(grep "Audio In Out: Input Device:" "$LIVE_LOG" | tail -1 | sed 's/.*Input Device: //')"
  echo "  Last session: ${LIVE_IN_DEV:-?}"
  echo "  Input Channels enabled: ${LIVE_IN_CH:-?}"
  if [[ "$LIVE_IN_CH" == "3" ]]; then
    ok "Live had 3 input channels enabled"
  else
    echo ""
    echo -e "${RED}${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}${BOLD}║  LIVE INPUT CONFIG WRONG: only ${LIVE_IN_CH:-0} channels enabled${NC}"
    echo -e "${RED}${BOLD}║  Track 2 (Karol ch2-3) is SILENT until you enable ch 1, 2, AND 3${NC}"
    echo -e "${RED}${BOLD}║  Preferences → Audio → Input Config → ✓ 1 ✓ 2 ✓ 3 → quit/reopen Live${NC}"
    echo -e "${RED}${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    warn "Also set Monitor to IN (not Off) on both tracks"
  fi
else
  warn "Live log not found"
fi

# ── 10. Full verify ──
echo ""
step "Running karol-audio-verify.sh"
echo ""
KAROL_AGGREGATE_NAME="$LIVE_MIC" KAROL_LIVE_MIC_NAME="$LIVE_MIC" \
  bash "$SCRIPTS/karol-audio-verify.sh" || VERIFY_FAIL=1
VERIFY_FAIL="${VERIFY_FAIL:-0}"

# ── 11. Open Live prefs if Live running ──
if pgrep -x Live >/dev/null 2>&1 && [[ -f "$SCRIPTS/karol-open-live-audio-prefs.applescript" ]]; then
  osascript "$SCRIPTS/karol-open-live-audio-prefs.applescript" 2>/dev/null || true
fi

# ── DONE ──
echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  NOW OPEN LIVE — EXACT TRACK NUMBERS${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo "  1. Quit Live if open (Cmd+Q), then reopen Live"
echo "  2. Preferences → Audio:"
echo "       Input:  $LIVE_MIC"
echo "       Output: $TV_NAME"
echo "       Sample Rate: 44100"
echo "  3. Input Config → enable channels 1, 2, 3"
echo ""
echo "  TRACK 1 — MIC (Shure):"
echo "    Ext. In → $LIVE_MIC / 1"
echo "    Monitor: IN  ← NOT Off"
echo "    Arm: ON"
echo ""
echo "  TRACK 2 — KAROL:"
echo "    Ext. In → $LIVE_MIC / 2-3"
echo "    Monitor: IN  ← NOT Off"
echo "    Arm: OFF"
echo ""
echo "  MASTER → $TV_NAME / 1-2"
echo ""
echo "  Full steps: $SCRIPTS/karol-live-input-config-instructions.txt"
echo "  Re-verify:  $SCRIPTS/karol-audio-verify.sh"
echo ""

if [[ "${VERIFY_FAIL:-0}" -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}Audio path ready. Go sing.${NC}"
  exit 0
else
  echo -e "${YELLOW}${BOLD}Some checks failed — see above. Follow track wiring anyway.${NC}"
  exit 1
fi
