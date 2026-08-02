#!/bin/bash
# Keep the USB hub + /Volumes/maxone from idle-sleeping.
# Runs under LaunchAgent com.karol.usb-keepawake.

DRIVE="${KAROL_EXTERNAL_DRIVE:-/Volumes/maxone}"
TAGS="$DRIVE/Deskreen/tags.json"

# Prevent idle system sleep + disk idle sleep (does not force display on).
/usr/bin/caffeinate -ims &
CAFFEINATE_PID=$!

cleanup() {
  kill "$CAFFEINATE_PID" 2>/dev/null || true
  exit 0
}
trap cleanup TERM INT EXIT

while true; do
  if [ -d "$DRIVE" ]; then
    # Confirm it's a real mount (device id differs from /Volumes)
    DRIVE_DEV=$(/usr/bin/stat -f '%d' "$DRIVE" 2>/dev/null || echo 0)
    VOL_DEV=$(/usr/bin/stat -f '%d' /Volumes 2>/dev/null || echo 0)
    if [ "$DRIVE_DEV" != "$VOL_DEV" ] && [ "$DRIVE_DEV" != "0" ]; then
      /bin/ls "$DRIVE" >/dev/null 2>&1 || true
      if [ -f "$TAGS" ]; then
        /bin/dd if="$TAGS" of=/dev/null bs=64 count=1 2>/dev/null || true
      fi
    fi
  fi
  sleep 30
done
