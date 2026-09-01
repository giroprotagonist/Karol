#!/bin/bash
# One command before every show — state-of-the-art UMC PA + Live + Karol.
# Usage: karol-show-ready.sh [--build] [--force]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTS="$ROOT/scripts"
export KAROL_AUDIO_MODE=umc-pa
export KAROL_SHOW_FORCE="${KAROL_SHOW_FORCE:-}"

BUILD=false
for arg in "$@"; do
  case "$arg" in
    --build) BUILD=true ;;
    --force) export KAROL_SHOW_FORCE=1 ;;
  esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

step()  { echo -e "${CYAN}→${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}!${NC} $1"; }

echo ""
echo -e "${BOLD}═══ KAROL SHOW READY (UMC PA) ═══${NC}"
echo ""

if pgrep -x Live >/dev/null 2>&1; then
  warn "Quit Ableton Live (Cmd+Q) before audio setup."
  if [[ -z "$KAROL_SHOW_FORCE" && -t 0 ]]; then
    read -r -p "Press Enter when Live is quit, or Ctrl+C… "
  fi
fi

if [[ "$BUILD" == true ]]; then
  step "Build + install Karol.app"
  "$SCRIPTS/karol-install-app.sh"
  ok "Karol.app installed"
fi

step "Audio setup (48 kHz, aggregate, BlackHole)"
KAROL_SHOW_FORCE=1 "$SCRIPTS/karol-show-laptop.sh"

step "USB / drive / UMC health"
"$SCRIPTS/karol-usb-health.sh" || warn "USB health reported issues"

echo ""
step "Audio verification"
if KAROL_AUDIO_MODE=umc-pa "$SCRIPTS/karol-audio-verify.sh"; then
  ok "Audio verify passed"
else
  warn "Audio verify failed — see messages above"
fi

echo ""
echo -e "${BOLD}═══ READY CHECKLIST ═══${NC}"
echo ""
echo "  1. Open Karol DJ Controller (Library + Show tabs)"
echo "  2. Open Ableton Live — load your show template"
echo "  3. Live: 48 kHz · Input Karol Live Mic · Output UMC404HD · Buffer 512"
echo "  4. Karol Show tab: Out 55–70% · Vocals 0%"
echo "  5. Autotuna: python3 $SCRIPTS/karol-charli-autotuna.py"
echo "  6. Play Karol → Space in Live → sing"
echo ""
echo "  Full doc: $ROOT/docs/SHOW-READY.md"
echo ""
