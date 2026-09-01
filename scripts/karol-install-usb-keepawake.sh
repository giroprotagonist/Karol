#!/bin/bash
# Install / refresh USB keep-awake LaunchAgent for maxone + UMC hub.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/scripts/karol-usb-keepawake.sh"
PLIST_SRC="$ROOT/scripts/com.karol.usb-keepawake.plist"
SUPPORT="$HOME/Library/Application Support/karol"
AGENT="$HOME/Library/LaunchAgents/com.karol.usb-keepawake.plist"
LABEL="com.karol.usb-keepawake"
UID_NUM="$(id -u)"

mkdir -p "$SUPPORT" "$HOME/Library/LaunchAgents"
cp "$SRC" "$SUPPORT/karol-usb-keepawake.sh"
chmod +x "$SUPPORT/karol-usb-keepawake.sh"
cp "$PLIST_SRC" "$AGENT"
plutil -replace ProgramArguments -json "[\"/bin/bash\",\"$SUPPORT/karol-usb-keepawake.sh\"]" "$AGENT"

if launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$UID_NUM/$LABEL" 2>/dev/null || {
    pkill -f 'karol-usb-keepawake.sh' 2>/dev/null || true
    sleep 1
    launchctl kickstart -k "gui/$UID_NUM/$LABEL" 2>/dev/null || true
  }
else
  launchctl bootstrap "gui/$UID_NUM" "$AGENT" 2>/dev/null || launchctl load -w "$AGENT"
fi

echo "Installed/refreshed $LABEL"
echo "  script: $SUPPORT/karol-usb-keepawake.sh"
echo "  status: /tmp/karol-usb-keepawake.status"
sleep 2
bash "$ROOT/scripts/karol-usb-health.sh" || true
