#!/bin/bash
# Keep the USB hub + /Volumes/maxone from idle-sleeping (and keep UMC on the bus).
# Runs under LaunchAgent com.karol.usb-keepawake.
#
# Strategy (macOS has no pmset "usb" selective-suspend toggle):
# 1) caffeinate -dims → prevent display/idle/disk idle + system sleep
# 2) READ I/O every ~10s on the ExFAT volume → keeps Mass Storage / hub awake
# 3) Status file in /tmp (LaunchAgents often lack Removable Volumes *write* TCC)
# Do NOT adb kill-server or reset USB — that drops the hub/phone/UMC.
#
# Writes to maxone may fail with "Operation not permitted" — reads still wake the hub.

DRIVE="${KAROL_EXTERNAL_DRIVE:-/Volumes/maxone}"
DESKREEN="$DRIVE/Deskreen"
KEEPALIVE="$DESKREEN/.karol-keepawake"
TAGS="$DESKREEN/tags.json"
STATUS="/tmp/karol-usb-keepawake.status"
INTERVAL="${KAROL_USB_KEEPAWAKE_INTERVAL:-10}"
SAS="${SWITCH_AUDIO_SOURCE:-/opt/homebrew/bin/SwitchAudioSource}"

/usr/bin/caffeinate -dims &
CAFFEINATE_PID=$!

cleanup() {
  kill "$CAFFEINATE_PID" 2>/dev/null || true
  exit 0
}
trap cleanup TERM INT EXIT

echo "[karol-usb-keepawake] started pid=$$ caffeinate=$CAFFEINATE_PID drive=$DRIVE interval=${INTERVAL}s"

write_status() {
  # shellcheck disable=SC2034
  local mounted="$1" readable="$2" wrote="$3" umc="$4" msg="$5"
  /bin/cat > "$STATUS" <<EOF
{
  "ts": "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "drive": "$DRIVE",
  "mounted": $mounted,
  "readable": $readable,
  "wroteKeepalive": $wrote,
  "umcPresent": $umc,
  "message": "$msg",
  "pid": $$,
  "caffeinatePid": $CAFFEINATE_PID
}
EOF
}

umc_present() {
  if [[ -x "$SAS" ]]; then
    "$SAS" -a 2>/dev/null | /usr/bin/grep -qi 'UMC404HD' && return 0
  fi
  /usr/sbin/system_profiler SPAudioDataType 2>/dev/null | /usr/bin/grep -q 'UMC404HD' && return 0
  return 1
}

TICK=0
while true; do
  TICK=$((TICK + 1))
  MOUNTED=false
  READABLE=false
  WROTE=0
  READ=0
  MSG="ok"
  UMC=false
  if umc_present; then UMC=true; fi

  if [ -d "$DRIVE" ]; then
    DRIVE_DEV=$(/usr/bin/stat -f '%d' "$DRIVE" 2>/dev/null || echo 0)
    VOL_DEV=$(/usr/bin/stat -f '%d' /Volumes 2>/dev/null || echo 0)
    if [ "$DRIVE_DEV" != "$VOL_DEV" ] && [ "$DRIVE_DEV" != "0" ]; then
      MOUNTED=true
      # Prefer READ heartbeats — LaunchAgent often cannot write Removable Volumes.
      if [ -f "$TAGS" ] && /bin/dd if="$TAGS" of=/dev/null bs=8192 count=1 2>/dev/null; then
        READ=1
        READABLE=true
      elif /usr/bin/stat "$DESKREEN" >/dev/null 2>&1; then
        READ=1
        READABLE=true
      elif /bin/ls "$DRIVE" >/dev/null 2>&1; then
        READ=1
        READABLE=true
      elif /usr/bin/stat "$DRIVE" >/dev/null 2>&1; then
        READ=1
      fi
      # Best-effort write (Karol.app usually has TCC; this agent may not).
      if /bin/date '+%Y-%m-%dT%H:%M:%S%z' > "$KEEPALIVE" 2>/dev/null; then
        WROTE=1
      elif /usr/bin/touch "$KEEPALIVE" 2>/dev/null; then
        WROTE=1
      fi
      if [ "$READ" -eq 0 ]; then
        MSG="mounted_but_unreadable"
      elif [ "$WROTE" -eq 0 ]; then
        MSG="read_ok_write_denied_tcc"
      fi
    else
      MSG="ghost_or_stub"
    fi
  else
    MSG="drive_missing"
  fi

  write_status "$MOUNTED" "$READABLE" "$WROTE" "$UMC" "$MSG"

  if [ "$TICK" -eq 1 ] || [ $((TICK % 12)) -eq 0 ]; then
    echo "[karol-usb-keepawake] tick=$TICK mounted=$MOUNTED read=$READ wrote=$WROTE umc=$UMC msg=$MSG"
  fi
  sleep "$INTERVAL"
done
