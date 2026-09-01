#!/bin/bash
# Diagnose Shure mic on aggregate ch3 + repair/create "Karol Live Mic" for Ableton Live.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTS="$ROOT/scripts"
AGG_NAME="${KAROL_AGGREGATE_NAME:-Aggregate Device}"
LIVE_MIC_NAME="${KAROL_LIVE_MIC_NAME:-Karol Live Mic}"
SHURE_NAME="${KAROL_SHURE_NAME:-Shure MVX2U}"
BH_NAME="${KAROL_BLACKHOLE_NAME:-BlackHole 2ch}"
TV_NAME="${KAROL_TV_NAME:-Living room TV}"
PLIST="/Library/Preferences/Audio/com.apple.audio.SystemSettings.plist"
LIVE_LOG="${HOME}/Library/Preferences/Ableton/Live 11.3.43/Log.txt"
NUCLEAR=false
CREATE=false

for arg in "$@"; do
  case "$arg" in
    --nuclear) NUCLEAR=true ;;
    --create) CREATE=true ;;
  esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'
pass() { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
step() { echo -e "${CYAN}→${NC} $1"; }

echo "═══ Karol: fix Aggregate mic (ch3) for Live ═══"
echo ""

# --- compile probe ---
PROBE="$SCRIPTS/karol-audio-probe"
if [[ ! -x "$PROBE" && -f "$SCRIPTS/karol-audio-probe.swift" ]]; then
  swiftc -O -o "$PROBE" "$SCRIPTS/karol-audio-probe.swift" 2>/dev/null || true
fi

json_field() {
  local key="$1"
  echo "$PROBE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$key',''))" 2>/dev/null || true
}

PROBE_JSON=""
if [[ -x "$PROBE" ]]; then
  PROBE_JSON="$("$PROBE" 2>/dev/null || true)"
fi

RECOMMENDED="$(json_field recommendedInputDevice)"
AGG_IN="$(json_field aggregateInputChannels)"
AGG_OUT="$(json_field aggregateOutputChannels)"
AGG_SR="$(json_field aggregateRate)"
KLM_IN="$(echo "$PROBE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); k=d.get('karolLiveMic') or {}; print(k.get('inputChannels',''))" 2>/dev/null || true)"
KLM_OUT="$(echo "$PROBE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); k=d.get('karolLiveMic') or {}; print(k.get('outputChannels',''))" 2>/dev/null || true)"
KLM_HAS_SHURE="$(echo "$PROBE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); k=d.get('karolLiveMic') or {}; print(k.get('hasShure',''))" 2>/dev/null || true)"

echo "── OS / CoreAudio ──"
if [[ "$AGG_IN" == "3" ]]; then
  pass "$AGG_NAME: ${AGG_IN} inputs @ ${AGG_SR:-?} Hz"
elif [[ -n "$AGG_IN" ]]; then
  fail "$AGG_NAME: ${AGG_IN} inputs @ ${AGG_SR:-?} Hz (need 3 — Shure missing or TV wrongly added)"
else
  warn "$AGG_NAME: could not read input count"
fi

if [[ "$KLM_IN" == "3" ]]; then
  pass "$LIVE_MIC_NAME: ${KLM_IN} inputs (Shure on ch3) — USE THIS IN LIVE"
elif [[ -n "$KLM_IN" ]]; then
  warn "$LIVE_MIC_NAME: ${KLM_IN:-?} inputs — run: $0 --create"
else
  fail "$LIVE_MIC_NAME not found — run: $0 --create"
fi

if [[ "$AGG_OUT" == "2" ]]; then
  pass "$AGG_NAME outputs: 2 (BlackHole only)"
elif [[ "$AGG_OUT" == "4" ]]; then
  fail "$AGG_NAME outputs: 4 — Shure/TV outs mapped; remove in Audio MIDI Setup"
fi

# Shure direct test
SHURE_DB=""
if command -v ffmpeg >/dev/null 2>&1; then
  SHURE_DB="$(ffmpeg -y -loglevel error -f avfoundation -i ":$SHURE_NAME" -t 1.5 -ar 48000 /tmp/karol-shure-direct.wav 2>/dev/null && \
    ffmpeg -i /tmp/karol-shure-direct.wav -af volumedetect -f null - 2>&1 | awk -F': ' '/mean_volume/ {print $2}' | head -1 || true)"
  if [[ -n "$SHURE_DB" ]]; then
    SHURE_NUM="${SHURE_DB%dB}"
    if python3 -c "import sys; sys.exit(0 if float('${SHURE_NUM}') > -80 else 1)" 2>/dev/null; then
      pass "Shure direct signal: ${SHURE_DB} (hardware OK)"
    else
      warn "Shure direct quiet (${SHURE_DB}) — check XLR, gain, mute on MVX2U"
    fi
  fi
fi

# ch3 on recommended aggregate
MIC_DB=""
MIC_DEV="${RECOMMENDED:-$LIVE_MIC_NAME}"
if command -v ffmpeg >/dev/null 2>&1; then
  MIC_DB="$(ffmpeg -y -loglevel error -f avfoundation -i ":$MIC_DEV" -t 1.5 -ac 3 -ar 44100 /tmp/karol-fix-mic.wav 2>/dev/null && \
    ffmpeg -i /tmp/karol-fix-mic.wav -af "pan=mono|c0=c0,volumedetect" -f null - 2>&1 | awk -F': ' '/mean_volume/ {print $2}' | head -1 || true)"
  if [[ -n "$MIC_DB" ]]; then
    MIC_NUM="${MIC_DB%dB}"
    if python3 -c "import sys; sys.exit(0 if float('${MIC_NUM}') > -80 else 1)" 2>/dev/null; then
      pass "OS ch1 (Shure) on $MIC_DEV: ${MIC_DB}"
    else
      warn "OS ch1 quiet on $MIC_DEV (${MIC_DB:-none}) — speak into mic and re-run"
    fi
  fi
fi

# --- plist ---
echo ""
echo "── Audio MIDI Setup config (plist) ──"
if [[ -r "$PLIST" ]]; then
  python3 <<PY
import plistlib
path = "$PLIST"
for agg in ["$AGG_NAME", "$LIVE_MIC_NAME"]:
    with open(path, "rb") as f:
        data = plistlib.load(f)
    key = next((k for k in data if k.startswith("MetaDevice.") and data[k].get("name") == agg), None)
    if not key:
        print(f"  {agg}: (not in plist — API-created or missing)")
        continue
    meta = data[key]
    print(f"  {agg}:")
    print(f"    clock: {meta.get('master')}")
    for sub in meta.get("subdevices", []):
        print(f"    {sub.get('name')}: in={sub.get('channels-in')} out={sub.get('channels-out')} drift={sub.get('drift')}")
PY
else
  warn "Cannot read $PLIST"
fi

# --- Live log ---
echo ""
echo "── Ableton Live (from Log.txt) ──"
LIVE_ISSUE=""
LIVE_IN_CH=""
if [[ -f "$LIVE_LOG" ]]; then
  LIVE_AGG_IN="$(grep "CoreAudio: Device init:" "$LIVE_LOG" | grep -E "Aggregate Device|Karol Live Mic" | tail -1 | sed -n 's/.*(\([0-9]*\) In.*/\1/p')"
  LIVE_IN_CH="$(grep "Audio In Out: Input Channels:" "$LIVE_LOG" | tail -1 | awk '{print $NF}')"
  LIVE_SR="$(grep "Audio In Out: Sample Rate:" "$LIVE_LOG" | tail -1 | awk '{print $NF}')"
  LIVE_IN_DEV="$(grep "Audio In Out: Input Device:" "$LIVE_LOG" | tail -1 | sed 's/.*Input Device: //')"
  LIVE_OUT_DEV="$(grep "Audio In Out: Output Device:" "$LIVE_LOG" | tail -1 | sed 's/.*Output Device: //')"

  echo "  Last session: input=${LIVE_IN_DEV:-?}"
  echo "  Output=${LIVE_OUT_DEV:-?}  SR=${LIVE_SR:-?} Hz  Input Channels enabled=${LIVE_IN_CH:-?}"

  if [[ "$LIVE_IN_DEV" == *"Shure"* ]]; then
    fail "Live input is Shure direct (48 kHz) — switch to $LIVE_MIC_NAME"
    LIVE_ISSUE="shure_direct"
  elif [[ "$LIVE_IN_DEV" == *"$AGG_NAME"* && "$AGG_IN" != "3" ]]; then
    fail "Live uses broken $AGG_NAME (${AGG_IN:-?} in) — switch to $LIVE_MIC_NAME"
    LIVE_ISSUE="broken_aggregate"
  elif [[ -n "$LIVE_AGG_IN" && -n "$LIVE_IN_CH" && "$LIVE_IN_CH" -lt "$LIVE_AGG_IN" ]]; then
    fail "Live Input Config enables $LIVE_IN_CH ch — device has $LIVE_AGG_IN (ch3 NOT enabled)"
    LIVE_ISSUE="input_config"
  elif [[ "$LIVE_IN_CH" == "2" && ( "$LIVE_AGG_IN" == "3" || "$KLM_IN" == "3" ) ]]; then
    fail "Live Input Config: only 2 channels enabled — enable ch 3 (mono, not 3/4)"
    LIVE_ISSUE="input_config"
  elif [[ -n "$LIVE_IN_CH" && "$LIVE_IN_CH" -ge 3 ]]; then
    pass "Live Input Channels: $LIVE_IN_CH enabled"
  fi

  if pgrep -x Live >/dev/null 2>&1; then
    warn "Ableton Live is running — quit fully (Cmd+Q) after changing devices/Input Config"
  fi
else
  warn "Live log not found at $LIVE_LOG"
fi

# --- create / nuclear ---
if [[ "$CREATE" == true ]]; then
  echo ""
  step "Creating $LIVE_MIC_NAME via CoreAudio API…"
  CREATE_BIN="$SCRIPTS/karol-create-live-mic-aggregate"
  if [[ ! -x "$CREATE_BIN" ]]; then
    swiftc -O -o "$CREATE_BIN" "$SCRIPTS/karol-create-live-mic-aggregate.swift"
  fi
  "$CREATE_BIN" || true
  PROBE_JSON="$("$PROBE" 2>/dev/null || true)"
  RECOMMENDED="$(json_field recommendedInputDevice)"
fi

if [[ "$NUCLEAR" == true ]]; then
  echo ""
  step "Nuclear: fix plist + restart CoreAudio (admin password required)…"
  PY="$(command -v python3)"
  PLIST_FIX="$SCRIPTS/karol-fix-plist-aggregate.py"
  if osascript -e "do shell script \"$PY $PLIST_FIX\" with administrator privileges" 2>/dev/null; then
    pass "Plist fixed"
    sleep 2
  else
    fail "Plist fix failed — run: sudo python3 $PLIST_FIX"
  fi
  step "Recreate $LIVE_MIC_NAME…"
  CREATE_BIN="$SCRIPTS/karol-create-live-mic-aggregate"
  [[ -x "$CREATE_BIN" ]] || swiftc -O -o "$CREATE_BIN" "$SCRIPTS/karol-create-live-mic-aggregate.swift"
  "$CREATE_BIN" || true
fi

echo ""
echo "═══ ROOT CAUSE (evidence) ═══"
echo ""
if [[ "$AGG_IN" != "3" ]]; then
  echo "• $AGG_NAME is BROKEN: only ${AGG_IN:-?} inputs. Shure was removed; Living room TV"
  echo "  was wrongly added as aggregate sub-device. Channel 3 does not exist on this device."
  echo ""
fi
if [[ "$LIVE_ISSUE" == "input_config" || "$LIVE_IN_CH" == "2" ]]; then
  echo "• Even when aggregate had 3 inputs, Live log shows Input Channels: 2"
  echo "  → ch3 never reaches Live until Input Config enables channel 3 (mono)."
  echo ""
fi
if [[ -n "$MIC_DB" ]] && python3 -c "import sys; sys.exit(0 if float('${MIC_DB%dB}') > -80 else 1)" 2>/dev/null; then
  echo "• $LIVE_MIC_NAME ch3 HAS signal (${MIC_DB}) — OS path works. Use it in Live."
  echo ""
fi
if [[ -n "$SHURE_DB" ]]; then
  echo "• Shure hardware OK direct (${SHURE_DB}). Problem is aggregate/Live wiring, not XLR."
  echo ""
fi

echo "═══ FIX NOW (minimal — show tonight) ═══"
echo ""
step "1. Use $LIVE_MIC_NAME (not $AGG_NAME) in Ableton Live"
echo ""
step "2. Quit Live completely (Cmd+Q)"
echo ""
step "3. Live → Preferences → Audio"
echo "     Sample Rate: 44100 Hz"
echo "     Audio Input:  $LIVE_MIC_NAME"
echo "     Audio Output: $TV_NAME"
echo "     Input Config: enable 1, 2, **3** (single mono ch3 — NOT stereo 3/4)"
echo ""
step "4. Track 1: Ext. In → $LIVE_MIC_NAME / **1**, Monitor **In**, Arm ON"
echo ""
step "5. Track 2: Ext. In → $LIVE_MIC_NAME / **2-3**, Monitor **In**, Arm OFF"
echo ""
step "5. Verify: $SCRIPTS/karol-audio-verify.sh"
echo ""

if [[ "$KLM_IN" != "3" && "$CREATE" != true ]]; then
  echo "── Create $LIVE_MIC_NAME first ──"
  echo "  $0 --create"
  echo ""
fi

echo "── If $LIVE_MIC_NAME missing or ch3 dead ──"
echo "  $0 --create          # CoreAudio API (no sudo)"
echo "  $0 --nuclear         # rewrite plist + restart coreaudiod (sudo)"
echo ""
echo "── Tonight fallback (MacBook mic on ch3) ──"
echo "  Audio MIDI Setup → add MacBook Pro Microphone as ch3 in aggregate"
echo "  (44100-compatible; lower quality than Shure)"
echo ""

if [[ -x "$SCRIPTS/karol-audio-verify.sh" && "$CREATE" != true && "$NUCLEAR" != true ]]; then
  echo "Running verify…"
  echo ""
  KAROL_AGGREGATE_NAME="$LIVE_MIC_NAME" "$SCRIPTS/karol-audio-verify.sh" || true
fi
