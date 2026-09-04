#!/bin/bash
# One-command show-night audio status check (green/red).
# Modes: KAROL_AUDIO_MODE=umc-direct (default) | umc-pa | live-tv
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTS="$ROOT/scripts"
SAS="${SWITCH_AUDIO_SOURCE:-/opt/homebrew/bin/SwitchAudioSource}"
MODE="${KAROL_AUDIO_MODE:-umc-direct}"
TV_NAME="${KAROL_TV_NAME:-Living room TV}"
BH_NAME="${KAROL_BLACKHOLE_NAME:-BlackHole 2ch}"
UMC_NAME="${KAROL_UMC_NAME:-UMC404HD 192k}"
LIVE_MIC_NAME="${KAROL_LIVE_MIC_NAME:-Karol Live Mic}"
AGG_NAME="${KAROL_AGGREGATE_NAME:-$LIVE_MIC_NAME}"
SHURE_NAME="${KAROL_SHURE_NAME:-Shure MVX2U}"

if [[ "$MODE" == "live-tv" ]]; then
  TARGET_SR=44100
  LIVE_OUT="$TV_NAME"
  EXPECT_MAC_OUT="$BH_NAME"
  EXPECT_LIVE_IN="$LIVE_MIC_NAME"
  EXPECT_AGG_IN=3
elif [[ "$MODE" == "umc-pa" ]]; then
  TARGET_SR=48000
  LIVE_OUT="$UMC_NAME"
  EXPECT_MAC_OUT="$BH_NAME"
  EXPECT_LIVE_IN="$LIVE_MIC_NAME"
  EXPECT_AGG_IN=6
else
  # umc-direct: near-instant mic — Live + Karol both on UMC
  TARGET_SR=48000
  LIVE_OUT="$UMC_NAME"
  EXPECT_MAC_OUT="$UMC_NAME"
  EXPECT_LIVE_IN="$UMC_NAME"
  EXPECT_AGG_IN=0
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
pass() { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; FAILURES=$((FAILURES + 1)); }
warn() { echo -e "${YELLOW}!${NC} $1"; }

FAILURES=0

echo "═══ Karol Audio Verify ($MODE @ ${TARGET_SR} Hz) ═══"
echo ""

PROBE="$SCRIPTS/karol-audio-probe"
if [[ ! -x "$PROBE" && -f "$SCRIPTS/karol-audio-probe.swift" ]]; then
  swiftc -O -o "$PROBE" "$SCRIPTS/karol-audio-probe.swift" 2>/dev/null || true
fi

PROBE_JSON=""
if [[ -x "$PROBE" ]]; then
  PROBE_JSON="$("$PROBE" 2>/dev/null || true)"
fi

json_field() {
  local key="$1"
  if [[ -n "$PROBE_JSON" ]]; then
    echo "$PROBE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$key',''))" 2>/dev/null || true
  fi
}

BH_SR="$(json_field blackholeRate)"
if [[ -z "$BH_SR" ]]; then
  BH_SR="$(system_profiler SPAudioDataType 2>/dev/null | awk -v n="$BH_NAME" '$0 ~ n {found=1} found && /Current SampleRate/ {gsub(/[^0-9]/,"",$3); print $3; exit}')"
fi
if [[ "$MODE" == "umc-direct" ]]; then
  if [[ "$BH_SR" == "$TARGET_SR" ]]; then
    pass "$BH_NAME at ${BH_SR} Hz (optional in umc-direct)"
  else
    warn "$BH_NAME at ${BH_SR:-unknown} Hz (optional — only needed for umc-pa Live-mix mode)"
  fi
else
  if [[ "$BH_SR" == "$TARGET_SR" ]]; then
    pass "$BH_NAME at ${BH_SR} Hz"
  else
    fail "$BH_NAME at ${BH_SR:-unknown} Hz (need ${TARGET_SR})"
  fi
fi

CUR_OUT=""
if [[ -x "$SAS" ]]; then
  CUR_OUT="$("$SAS" -c -t output 2>/dev/null || true)"
fi
if [[ "$CUR_OUT" == "$EXPECT_MAC_OUT" ]]; then
  pass "macOS output → $CUR_OUT"
else
  fail "macOS output → ${CUR_OUT:-unknown} (need $EXPECT_MAC_OUT)"
fi

if [[ "$MODE" == "live-tv" ]]; then
  TV_SR="$(system_profiler SPAudioDataType 2>/dev/null | awk -v n="$TV_NAME" '$0 ~ n {found=1} found && /Current SampleRate/ {gsub(/[^0-9]/,"",$3); print $3; exit}')"
  if [[ "$TV_SR" == "$TARGET_SR" ]]; then
    pass "$TV_NAME at ${TV_SR} Hz"
  else
    fail "$TV_NAME at ${TV_SR:-unknown} Hz (need ${TARGET_SR})"
  fi
else
  UMC_SR="$(system_profiler SPAudioDataType 2>/dev/null | awk -v n="UMC404" '$0 ~ n {found=1} found && /Current SampleRate/ {gsub(/[^0-9]/,"",$3); print $3; exit}')"
  if system_profiler SPAudioDataType 2>/dev/null | grep -q 'UMC404'; then
    if [[ "$UMC_SR" == "$TARGET_SR" ]]; then
      pass "$UMC_NAME at ${UMC_SR} Hz"
    else
      fail "$UMC_NAME at ${UMC_SR:-unknown} Hz (need ${TARGET_SR})"
    fi
  else
    fail "$UMC_NAME not detected"
  fi
fi

if [[ "$MODE" != "umc-direct" ]]; then
  KLM_PROBE="$(echo "$PROBE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); k=d.get('karolLiveMic') or {}; print(k.get('inputChannels',''), k.get('outputChannels',''), k.get('sampleRate',''), ' '.join(k.get('subs') or []))" 2>/dev/null || true)"
  read -r KLM_IN KLM_OUT KLM_SR KLM_SUBS <<< "$KLM_PROBE"
  if [[ -z "$KLM_IN" ]]; then KLM_IN=""; KLM_OUT=""; KLM_SR=""; KLM_SUBS=""; fi

  if system_profiler SPAudioDataType 2>/dev/null | grep -q "$LIVE_MIC_NAME"; then
    if [[ "$KLM_SR" == "$TARGET_SR" && "$KLM_IN" == "$EXPECT_AGG_IN" ]]; then
      pass "$LIVE_MIC_NAME at ${KLM_SR} Hz, ${KLM_IN} inputs"
    elif [[ "$KLM_SR" == "$TARGET_SR" ]]; then
      warn "$LIVE_MIC_NAME at ${KLM_SR} Hz but ${KLM_IN:-?} inputs (need ${EXPECT_AGG_IN})"
    else
      fail "$LIVE_MIC_NAME wrong rate or missing (${KLM_SR:-?} Hz, ${KLM_IN:-?} in)"
    fi
    if [[ "$MODE" == "umc-pa" ]]; then
      if echo "$KLM_SUBS" | grep -q "BlackHole" && echo "$KLM_SUBS" | grep -q "UMC404"; then
        pass "Aggregate subs: BlackHole + UMC"
      else
        warn "Aggregate subs: ${KLM_SUBS:-unknown}"
      fi
      if [[ "$KLM_OUT" == "2" ]]; then
        pass "Aggregate outputs: 2 (BlackHole only — plist OK)"
      elif [[ -n "$KLM_OUT" ]]; then
        warn "Aggregate has ${KLM_OUT} outputs — run: sudo python3 $SCRIPTS/karol-fix-plist-aggregate.py"
      fi
    fi
  else
    fail "$LIVE_MIC_NAME not found — run karol-show-ready.sh"
  fi
else
  pass "Mode umc-direct — aggregate not required for show path"
fi

LIVE_LOG="${HOME}/Library/Preferences/Ableton/Live 11.3.43/Log.txt"
if [[ -f "$LIVE_LOG" ]]; then
  LIVE_IN_CH="$(grep "Audio In Out: Input Channels:" "$LIVE_LOG" | tail -1 | awk '{print $NF}')"
  LIVE_IN_DEV="$(grep "Audio In Out: Input Device:" "$LIVE_LOG" | tail -1 | sed 's/.*Input Device: //')"
  LIVE_OUT_DEV="$(grep "Audio In Out: Output Device:" "$LIVE_LOG" | tail -1 | sed 's/.*Output Device: //')"
  LIVE_SR="$(grep "Audio In Out: Sample Rate:" "$LIVE_LOG" | tail -1 | awk '{print $NF}')"
  LIVE_BUF="$(grep "Audio In Out: Input Buffer Size:" "$LIVE_LOG" | tail -1 | awk '{print $(NF-1)}')"
  if [[ "$LIVE_IN_DEV" == *"$EXPECT_LIVE_IN"* ]] || [[ "$LIVE_IN_DEV" == *"${EXPECT_LIVE_IN/ 192k/}"* ]]; then
    pass "Live input: $LIVE_IN_DEV"
  else
    warn "Live input: ${LIVE_IN_DEV:-unknown} (want $EXPECT_LIVE_IN)"
  fi
  if [[ "$LIVE_OUT_DEV" == *"${LIVE_OUT/ 192k/}"* ]] || [[ "$LIVE_OUT_DEV" == *"$LIVE_OUT"* ]]; then
    pass "Live output: $LIVE_OUT_DEV"
  else
    warn "Live output: ${LIVE_OUT_DEV:-unknown} (want $LIVE_OUT)"
  fi
  if [[ "$LIVE_SR" == "$TARGET_SR" ]]; then
    pass "Live sample rate: ${LIVE_SR} Hz"
  else
    warn "Live sample rate: ${LIVE_SR:-?} (want ${TARGET_SR})"
  fi
  if [[ "$MODE" == "umc-direct" ]]; then
    if [[ -n "$LIVE_BUF" && "$LIVE_BUF" -le 128 ]]; then
      pass "Live buffer: ${LIVE_BUF} samples (low-latency)"
    elif [[ -n "$LIVE_BUF" ]]; then
      warn "Live buffer ${LIVE_BUF} samples — for near-instant mic use 64 or 128"
    fi
    if [[ -n "$LIVE_IN_CH" && "$LIVE_IN_CH" -ge 2 ]]; then
      pass "Live Input Config: ${LIVE_IN_CH} channels"
    elif [[ -n "$LIVE_IN_CH" ]]; then
      warn "Live Input Config: ${LIVE_IN_CH} ch (want ≥2)"
    fi
  else
    if [[ -n "$LIVE_BUF" && "$LIVE_BUF" -lt 128 ]]; then
      warn "Live buffer ${LIVE_BUF} samples — use 512 (256 min if stable)"
    elif [[ -n "$LIVE_BUF" ]]; then
      pass "Live buffer: ${LIVE_BUF} samples"
    fi
    if [[ "$LIVE_IN_CH" == "$EXPECT_AGG_IN" ]]; then
      pass "Live Input Config: ${LIVE_IN_CH} channels"
    elif [[ -n "$LIVE_IN_CH" ]]; then
      warn "Live Input Config: ${LIVE_IN_CH} ch (want ${EXPECT_AGG_IN})"
    fi
  fi
fi

echo ""
echo "── Ableton Live ($MODE) ──"
echo "  Sample Rate:  ${TARGET_SR} Hz"
echo "  Audio Input:  $EXPECT_LIVE_IN"
echo "  Audio Output: $LIVE_OUT"
if [[ "$MODE" == "umc-direct" ]]; then
  echo "  Buffer:       64–128 samples"
  echo "  Track 1 Mic:    $UMC_NAME / 1, Monitor In, Arm ON (+ Autotuna)"
  echo "  Karol:          macOS → $UMC_NAME (no Live input track)"
  echo "  Master:         $UMC_NAME / 1-2"
  echo ""
  echo "── Setup ──"
  echo "  $SCRIPTS/karol-low-latency-show.sh"
else
  echo "  Buffer:       512 samples"
  if [[ "$MODE" == "umc-pa" ]]; then
    echo "  Track 1 Mic:    $LIVE_MIC_NAME / 3-4, Monitor In, Arm ON"
    echo "  Track 2 Karol:  $LIVE_MIC_NAME / 1-2, Monitor In, Arm OFF"
  else
    echo "  Track 1 Mic:    $LIVE_MIC_NAME / 1, Monitor In, Arm ON"
    echo "  Track 2 Karol:  $LIVE_MIC_NAME / 2-3, Monitor In, Arm OFF"
  fi
  echo "  Master:         $LIVE_OUT / 1-2"
  echo ""
  echo "── Setup ──"
  echo "  $SCRIPTS/karol-show-ready.sh"
fi
echo "  docs/SHOW-READY.md"
echo ""

if [[ "$FAILURES" -eq 0 ]]; then
  echo -e "${GREEN}All critical checks passed.${NC}"
  exit 0
else
  echo -e "${RED}$FAILURES critical check(s) failed.${NC}"
  exit 1
fi
