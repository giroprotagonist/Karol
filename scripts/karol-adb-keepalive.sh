#!/bin/bash
# Keep the Android Debug Bridge server alive for Karol phone-mirror.
# Runs under LaunchAgent com.karol.adb-keepalive.
# Does not reset USB ports or kill device sessions — only ensures adb server stays up.

ADB="${KAROL_ADB:-/opt/homebrew/bin/adb}"
LOG="${KAROL_ADB_KEEPALIVE_LOG:-/tmp/karol-adb-keepalive.log}"

log() {
  echo "$(date '+%Y-%m-%dT%H:%M:%S') $*" >>"$LOG"
}

if [ ! -x "$ADB" ]; then
  log "adb missing at $ADB"
  sleep 30
  exit 1
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Start (or reuse) the adb server — never adb kill-server here (that drops USB sessions).
"$ADB" start-server >/dev/null 2>&1 || true

while true; do
  if ! "$ADB" start-server >/dev/null 2>&1; then
    log "start-server failed; retrying"
  else
    # Light poll — devices may be empty if phone unplugged; that is OK.
    "$ADB" devices >/dev/null 2>&1 || true
  fi
  sleep 45
done
