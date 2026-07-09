#!/usr/bin/env bash
# Automated three-device YouTube DJ E2E: Mac API + S8 receiver + S24 controller
set -euo pipefail

ADB="${ADB:-/Users/macdonk/Library/Android/sdk/platform-tools/adb}"
PLAYLIST_URL="${PLAYLIST_URL:-https://www.youtube.com/playlist?list=PLRxCSLihrLO4}"
LOG_PATH="${LOG_PATH:-/Users/macdonk/Documents/GitHub/deskreen/.cursor/debug-25b906.log}"
S8_SERIAL="${S8_SERIAL:-adb-R52T608KZBL-6LdEsa._adb-tls-connect._tcp}"
S24_SERIAL="${S24_SERIAL:-adb-R5CWC3XF0DP-zLubmK._adb-tls-connect._tcp}"

log_event() {
	local hypothesis="$1"
	local message="$2"
	local data="$3"
	python3 - <<PY >> "$LOG_PATH"
import json, time
payload = {
  "sessionId": "25b906",
  "runId": "e2e-auto",
  "hypothesisId": "$hypothesis",
  "location": "verify-youtube-dj-three-device-e2e.sh",
  "message": "$message",
  "data": $data,
  "timestamp": int(time.time() * 1000),
}
print(json.dumps(payload))
PY
}

echo "=== YouTube DJ Three-Device E2E ==="

DISCOVER="$(curl -sf http://127.0.0.1:3131/api/discover.json || curl -sf http://127.0.0.1:3132/api/discover.json)"
HOST="$(echo "$DISCOVER" | python3 -c "import sys,json; print(json.load(sys.stdin)['host'])")"
PORT="$(echo "$DISCOVER" | python3 -c "import sys,json; print(json.load(sys.stdin)['port'])")"
SHARE_URL="$(echo "$DISCOVER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('shareUrl',''))")"
DJ_URL="$(echo "$DISCOVER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('djControllerUrl',''))")"
BASE="http://${HOST}:${PORT}"

echo "Mac: $BASE"
echo "S8 share: $SHARE_URL"
echo "S24 controller: $DJ_URL"

log_event "H4" "discover ok" "{\"host\":\"$HOST\",\"port\":$PORT,\"djUrl\":\"$DJ_URL\"}"

echo ""
echo "--- Step 1: Enable playlist + sync ---"
curl -sf -X POST "$BASE/api/youtube-dj/playlist" \
  -H 'Content-Type: application/json' \
  -d "{\"playlistUrl\":\"$PLAYLIST_URL\",\"enabled\":true}" | python3 -m json.tool | head -15

SYNC_RESULT="$(curl -sf -X POST "$BASE/api/youtube-dj/sync" -H 'Content-Type: application/json' -d '{}')"
echo "$SYNC_RESULT" | python3 -m json.tool | head -20
QUEUE_LEN="$(echo "$SYNC_RESULT" | python3 -c "import sys,json; r=json.load(sys.stdin); print(len(r.get('result',{}).get('added',[])))" 2>/dev/null || echo 0)"
echo "Sync added: $QUEUE_LEN videos"

echo ""
echo "--- Step 2: Launch S8 receiver (before playback) ---"
if [ -n "$SHARE_URL" ]; then
  "$ADB" -s "$S8_SERIAL" shell am force-stop com.deskreen.receiver 2>/dev/null || true
  "$ADB" -s "$S8_SERIAL" shell am start -a android.intent.action.VIEW -d "$SHARE_URL" com.deskreen.receiver/.MainActivity 2>&1 || true
  sleep 4
fi
log_event "H5" "s8 receiver launched" "{\"shareUrl\":\"$SHARE_URL\"}"

echo ""
echo "--- Step 3: Play current queue item ---"
QUEUE_JSON="$(curl -sf "$BASE/api/youtube-dj/queue")"
PLAY_ID="$(echo "$QUEUE_JSON" | python3 -c "
import sys,json
q=json.load(sys.stdin)
idx=max(0,q.get('currentIndex',0))
items=q.get('queue',[])
item=items[idx] if idx < len(items) else (items[0] if items else None)
print(item['id'] if item else '')
")"
if [ -z "$PLAY_ID" ]; then
  echo "FAIL: queue is empty"
  exit 1
fi
echo "Playing queue item: $PLAY_ID"
curl -sf -X POST "$BASE/api/youtube-dj/queue/$PLAY_ID/play" -H 'Content-Type: application/json' -d '{}' | python3 -c "
import sys,json
s=json.load(sys.stdin)
print('playNow ok, currentIndex=', s.get('state',{}).get('currentIndex'))
"

echo "Waiting for now-playing..."
NOW_PLAYING_OK=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  NP="$(curl -sf "$BASE/api/youtube-dj/now-playing")"
  STATE="$(echo "$NP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('state',-2))")"
  VID="$(echo "$NP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('videoId',''))")"
  if [ "$STATE" = "1" ] && [ -n "$VID" ]; then
    echo "$NP" | python3 -m json.tool
    NOW_PLAYING_OK=1
    break
  fi
  sleep 2
done
if [ "$NOW_PLAYING_OK" -ne 1 ]; then
  echo "WARN: now-playing did not reach playing state"
  curl -sf "$BASE/api/youtube-dj/now-playing" | python3 -m json.tool
fi

echo ""
echo "--- Step 4: Status + transport ---"
CAST_OK=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  STATUS_JSON="$(curl -sf "$BASE/api/youtube-dj/status")"
  CAST="$(echo "$STATUS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('castConnected',False))")"
  if [ "$CAST" = "True" ] || [ "$CAST" = "true" ]; then
    CAST_OK=1
    break
  fi
  sleep 2
done
echo "$STATUS_JSON" | python3 -m json.tool
curl -sf -X POST "$BASE/api/youtube-dj/transport/pause" -H 'Content-Type: application/json' -d '{}' && echo " pause ok"
sleep 1
curl -sf -X POST "$BASE/api/youtube-dj/transport/play" -H 'Content-Type: application/json' -d '{}' && echo " play ok"

echo ""
echo "--- Step 5: Launch S24 controller ---"
"$ADB" -s "$S24_SERIAL" shell am force-stop com.karol.controller 2>/dev/null || true
"$ADB" -s "$S24_SERIAL" shell am start -a android.intent.action.VIEW -d "$DJ_URL" com.karol.controller/.MainActivity 2>&1 || true
sleep 3

STATUS_JSON="$(curl -sf "$BASE/api/youtube-dj/status")"
CAST="$(echo "$STATUS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('castConnected',False))")"
CAPTURE="$(echo "$STATUS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('captureReady',False))")"

echo ""
echo "--- Step 6: S8 receiver buffer (7s playout) ---"
BUFFER_OK=0
AV_START_OK=0
if [ "$CAST_OK" -eq 1 ]; then
  sleep 16
  "$ADB" -s "$S8_SERIAL" logcat -d 2>/dev/null | grep -F '[S8_PLAYBACK]' | tail -40 || true
  if "$ADB" -s "$S8_SERIAL" logcat -d 2>/dev/null | grep -F '[S8_PLAYBACK]' | grep -E 'playoutDelaySeconds.:7|"playoutDelaySeconds":7' >/dev/null; then
    BUFFER_OK=1
    echo "PASS: S8 logcat shows 7s playout delay"
  else
    echo "WARN: S8 logcat missing playoutDelaySeconds:7 (receiver may still be buffering)"
    if "$ADB" -s "$S8_SERIAL" logcat -d 2>/dev/null | grep -F '[S8_PLAYBACK]' | grep -E '7000|jitterTargetMs.:4000' >/dev/null; then
      BUFFER_OK=1
      echo "PASS: S8 logcat shows 4000ms jitter / 7000ms pre-roll indicators"
    fi
  fi
  if "$ADB" -s "$S8_SERIAL" logcat -d 2>/dev/null | grep -F '[S8_PLAYBACK]' | grep -F 'av-start' >/dev/null; then
    AV_START_OK=1
    echo "PASS: S8 logcat shows av-start (audio gated on video ready)"
  else
    echo "WARN: S8 logcat missing av-start line"
  fi
else
  echo "SKIP: cast not connected — buffer check skipped"
fi

log_event "H5" "e2e finished" "{\"queueLenFromSync\":$QUEUE_LEN,\"castConnected\":$CAST,\"captureReady\":$CAPTURE,\"nowPlayingOk\":$NOW_PLAYING_OK,\"castOk\":$CAST_OK,\"bufferOk\":$BUFFER_OK,\"avStartOk\":$AV_START_OK}"

echo ""
echo "=== E2E complete ==="
echo "castConnected=$CAST captureReady=$CAPTURE nowPlayingOk=$NOW_PLAYING_OK castOk=$CAST_OK bufferOk=$BUFFER_OK avStartOk=$AV_START_OK"
echo "Debug log: $LOG_PATH"

if [ "$NOW_PLAYING_OK" -ne 1 ]; then
  exit 2
fi
if [ "$CAST_OK" -ne 1 ]; then
  exit 3
fi
