#!/bin/bash
# Low-latency karaoke/DJ path (near-instant mic + Autotuna).
#
# Why this exists:
#   Aggregate "Karol Live Mic" (BlackHole+UMC) adds real monitor delay vs UMC-direct.
#   Stripping UMC outs from the aggregate needs `sudo` plist fix and still costs latency.
#
# Architecture (macOS mixes both apps onto the same interface clock):
#   Karol player  → UMC404HD outs → PA
#   Mic → UMC404HD ins → Ableton Live (Autotuna) → UMC404HD outs → PA
#
# Usage: karol-low-latency-show.sh [--force]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTS="$ROOT/scripts"
export KAROL_AUDIO_MODE=umc-direct
UMC_NAME="${KAROL_UMC_NAME:-UMC404HD 192k}"
BH_NAME="${KAROL_BLACKHOLE_NAME:-BlackHole 2ch}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

step()  { echo -e "${CYAN}→${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}!${NC} $1"; }

echo ""
echo -e "${BOLD}═══ KAROL LOW-LATENCY SHOW (UMC DIRECT) ═══${NC}"
echo ""

if pgrep -x Live >/dev/null 2>&1; then
  warn "Ableton Live is open — sample-rate changes may fail until you reopen Live."
  if [[ -z "${KAROL_SHOW_FORCE:-}" && "${1:-}" != "--force" && -t 0 ]]; then
    read -r -p "Press Enter to continue, or Ctrl+C… "
  fi
fi

step "Align UMC + BlackHole → 48000 Hz"
BH48="$SCRIPTS/blackhole-48000"
if [[ ! -x "$BH48" ]]; then
  swiftc -O -o "$BH48" "$SCRIPTS/blackhole-48000.swift"
fi
"$BH48" || warn "48000 align failed — quit Live and re-run"
ok "Devices at 48000 Hz"

step "macOS output → $UMC_NAME (Karol plays straight to PA)"
"$SCRIPTS/set-default-umc.sh"
ok "Karol → UMC (OS mixes with Live)"

echo ""
echo -e "${BOLD}── Ableton Live (set once, save as default) ──${NC}"
echo "  Preferences → Audio:"
echo "    Driver Type:        CoreAudio"
echo "    Audio Input Device: $UMC_NAME"
echo "    Audio Output Device:$UMC_NAME"
echo "    Sample Rate:        48000 Hz"
echo "    Buffer Size:        64 or 128   ← near-instant (you confirmed 64)"
echo "    Reduced Latency When Monitoring: ON"
echo "  Input Config:  enable 1–4"
echo "  Output Config: enable 1–2"
echo ""
echo "  Track 1 (MIC Karaoke + Autotuna + Vocal FX):"
echo "    Audio From: Ext. In → 1   (UMC front In 1)"
echo "    Monitor: In · Arm: ON"
echo "  Do NOT add a Karol input track — Karol hits the PA via macOS, not Live."
echo "  Master: $UMC_NAME / 1-2"
echo ""
echo -e "${BOLD}── Karol Show tab ──${NC}"
echo "  Out: 55–70%  ·  Vocals: 0%  ·  Play song → sing (Live Space if needed)"
echo ""
echo "  Verify:  KAROL_AUDIO_MODE=umc-direct $SCRIPTS/karol-audio-verify.sh"
echo "  Full mix through Live (higher latency): $SCRIPTS/karol-show-ready.sh"
echo "  Docs: $ROOT/docs/SHOW-READY.md"
echo ""

if KAROL_AUDIO_MODE=umc-direct "$SCRIPTS/karol-audio-verify.sh"; then
  ok "Verify passed"
else
  warn "Verify reported issues — see above"
fi
