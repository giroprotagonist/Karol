#!/bin/bash
# Verify external drive (maxone), UMC404HD, and USB hub keep-awake.
set -euo pipefail

DRIVE="${KAROL_EXTERNAL_DRIVE:-/Volumes/maxone}"
STATUS="/tmp/karol-usb-keepawake.status"
SAS="${SWITCH_AUDIO_SOURCE:-/opt/homebrew/bin/SwitchAudioSource}"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; FAILS=$((FAILS+1)); }
FAILS=0

echo "═══ Karol USB / Drive / UMC Health ═══"
echo ""

# Drive
if [[ -d "$DRIVE" ]]; then
  DRIVE_DEV=$(stat -f '%d' "$DRIVE" 2>/dev/null || echo 0)
  VOL_DEV=$(stat -f '%d' /Volumes 2>/dev/null || echo 0)
  if [[ "$DRIVE_DEV" != "$VOL_DEV" && "$DRIVE_DEV" != "0" ]]; then
    if ls "$DRIVE/Deskreen" >/dev/null 2>&1; then
      COUNT=$(find "$DRIVE/Deskreen" -maxdepth 2 -name '*.mp4' 2>/dev/null | wc -l | tr -d ' ')
      ok "External drive mounted & readable: $DRIVE ($COUNT mp4 in Deskreen)"
    else
      fail "Drive mounted but Deskreen unreadable — grant Removable Volumes to Karol"
    fi
  else
    fail "Ghost folder at $DRIVE (not a real mount) — remove it and remount"
  fi
else
  fail "Drive not mounted: $DRIVE"
fi

# UMC
UMC_OK=0
if [[ -x "$SAS" ]] && "$SAS" -a 2>/dev/null | grep -qi 'UMC404HD'; then
  ok "UMC404HD present (SwitchAudioSource)"
  UMC_OK=1
elif system_profiler SPAudioDataType 2>/dev/null | grep -q 'UMC404HD'; then
  ok "UMC404HD present (CoreAudio)"
  UMC_OK=1
else
  fail "UMC404HD not found — check USB hub / cable / Audio MIDI Setup"
fi

# Keepawake agent
if launchctl print "gui/$(id -u)/com.karol.usb-keepawake" 2>/dev/null | grep -q 'state = running'; then
  ok "LaunchAgent com.karol.usb-keepawake running"
else
  fail "USB keep-awake agent NOT running — bash scripts/karol-install-usb-keepawake.sh"
fi

if pgrep -x caffeinate >/dev/null; then
  ok "caffeinate active (prevents system/disk idle sleep)"
else
  warn "caffeinate not running"
fi

if [[ -f "$STATUS" ]]; then
  echo "  keepawake status: $(cat "$STATUS")"
  if grep -q '"umcPresent": true' "$STATUS" 2>/dev/null; then
    ok "Keepawake sees UMC"
  elif [[ "$UMC_OK" -eq 1 ]]; then
    warn "Keepawake status may be stale — wait ~10s and re-run"
  fi
  if grep -q '"readable": true' "$STATUS" 2>/dev/null; then
    ok "Keepawake can read maxone (hub heartbeat OK)"
  fi
  if grep -q '"wroteKeepalive": 0' "$STATUS" 2>/dev/null; then
    warn "Keepawake cannot WRITE maxone (TCC) — reads still keep hub awake; Karol.app writes when open"
  fi
else
  warn "No /tmp/karol-usb-keepawake.status yet"
fi

# Disk sleep
DS=$(pmset -g 2>/dev/null | awk '/disksleep/{print $2; exit}')
if [[ "$DS" == "0" ]]; then
  ok "pmset disksleep = 0"
else
  warn "pmset disksleep = ${DS:-?} (prefer 0 on AC). Try: sudo pmset -c disksleep 0"
fi

# Karol Removable Volumes hint
if [[ -d /Applications/Karol.app ]]; then
  ok "Karol.app installed"
  echo "  Tip: System Settings → Privacy & Security → Removable Volumes → enable Karol"
else
  warn "Karol.app not in /Applications"
fi

echo ""
if [[ "$FAILS" -eq 0 ]]; then
  echo -e "${GREEN}All critical checks passed.${NC}"
  exit 0
else
  echo -e "${RED}${FAILS} critical check(s) failed.${NC}"
  exit 1
fi
