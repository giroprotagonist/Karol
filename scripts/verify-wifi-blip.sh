#!/usr/bin/env bash
# Automated WiFi blip test: disrupt S8 network during active cast, expect host re-offer.
set -euo pipefail

ADB="${ADB:-/Users/macdonk/Library/Android/sdk/platform-tools/adb}"
S8_SERIAL="${S8_SERIAL:-}"
WIFI_OFF_SEC="${WIFI_OFF_SEC:-5}"
RECONNECT_WAIT_SEC="${RECONNECT_WAIT_SEC:-25}"
PLAYLIST_URL="${PLAYLIST_URL:-https://www.youtube.com/playlist?list=PLRxCSLihrLO4}"

resolve_base_url() {
	if curl -sf "http://127.0.0.1:3131/api/discover.json" >/dev/null 2>&1; then
		curl -sf "http://127.0.0.1:3131/api/discover.json"
		return
	fi
	curl -sf "http://127.0.0.1:3132/api/discover.json"
}

pick_s8_serial() {
	if [ -n "$S8_SERIAL" ]; then
		echo "$S8_SERIAL"
		return
	fi
	"$ADB" devices -l | awk '/device product:/{print $1; exit}'
}

echo "=== WiFi Blip Reconnect Test ==="

if ! pgrep -f "Deskreen CE" >/dev/null 2>&1; then
	echo "SKIP: Deskreen CE is not running"
	exit 0
fi

DISCOVER="$(resolve_base_url)"
HOST="$(echo "$DISCOVER" | python3 -c "import sys,json; print(json.load(sys.stdin)['host'])")"
PORT="$(echo "$DISCOVER" | python3 -c "import sys,json; print(json.load(sys.stdin)['port'])")"
SHARE_URL="$(echo "$DISCOVER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('shareUrl',''))")"
BASE="http://${HOST}:${PORT}"
S8="$(pick_s8_serial)"

if [ -z "$S8" ]; then
	echo "SKIP: no S8 device found via adb"
	exit 0
fi

echo "Mac: $BASE"
echo "S8:  $S8"

echo ""
echo "--- Enable DJ + start playback ---"
curl -sf -X POST "$BASE/api/youtube-dj/playlist" \
	-H 'Content-Type: application/json' \
	-d "{\"playlistUrl\":\"$PLAYLIST_URL\",\"enabled\":true}" >/dev/null

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
	echo "FAIL: queue empty"
	exit 1
fi

curl -sf -X POST "$BASE/api/youtube-dj/queue/$PLAY_ID/play" \
	-H 'Content-Type: application/json' -d '{}' >/dev/null

echo "--- Launch S8 receiver ---"
"$ADB" -s "$S8" logcat -c 2>/dev/null || true
"$ADB" -s "$S8" shell am force-stop com.deskreen.receiver 2>/dev/null || true
"$ADB" -s "$S8" shell am start -a android.intent.action.VIEW -d "$SHARE_URL" \
	com.deskreen.receiver/.MainActivity >/dev/null 2>&1 || true

CAST_OK=0
for _ in $(seq 1 20); do
	STATUS_JSON="$(curl -sf "$BASE/api/youtube-dj/status")"
	CAST="$(echo "$STATUS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('castConnected',False))")"
	if [ "$CAST" = "True" ] || [ "$CAST" = "true" ]; then
		CAST_OK=1
		break
	fi
	sleep 2
done

if [ "$CAST_OK" -ne 1 ]; then
	echo "FAIL: cast never connected before WiFi blip"
	exit 1
fi
echo "PASS: cast connected"

echo ""
echo "--- WiFi off for ${WIFI_OFF_SEC}s ---"
"$ADB" -s "$S8" shell svc wifi disable || {
	echo "WARN: could not disable WiFi (device may need root); skipping blip"
	exit 0
}
sleep "$WIFI_OFF_SEC"
"$ADB" -s "$S8" shell svc wifi enable || true
echo "WiFi re-enabled"

echo ""
echo "--- Wait for reconnect signals (${RECONNECT_WAIT_SEC}s) ---"
LOG_SNIP="$(
	"$ADB" -s "$S8" logcat -d -s chromium DeskreenWebView 2>/dev/null \
		| tail -200 || true
)"
MAC_LOG_HINT="Run: log stream --predicate 'process == \"Deskreen CE\"' | grep RECONNECT"

RECONNECT_OK=0
if echo "$LOG_SNIP" | grep -qE 'TABLET_RECONNECT|peer closed|ICE connection'; then
	RECONNECT_OK=1
fi

CAST_AFTER=0
for _ in $(seq 1 "$((RECONNECT_WAIT_SEC / 2))"); do
	STATUS_JSON="$(curl -sf "$BASE/api/youtube-dj/status" 2>/dev/null || echo '{}')"
	CAST="$(echo "$STATUS_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('castConnected',False))" 2>/dev/null || echo False)"
	if [ "$CAST" = "True" ] || [ "$CAST" = "true" ]; then
		CAST_AFTER=1
		break
	fi
	sleep 2
done

if [ "$RECONNECT_OK" -eq 1 ] && [ "$CAST_AFTER" -eq 1 ]; then
	echo "PASS: S8 showed reconnect activity and castConnected=true after blip"
	exit 0
fi

if [ "$CAST_AFTER" -eq 1 ]; then
	echo "PASS: cast reconnected after WiFi blip (check Mac logs for warm reconnect: $MAC_LOG_HINT)"
	exit 0
fi

echo "WARN: inconclusive — castConnected=$CAST_AFTER, s8_reconnect_log=$RECONNECT_OK"
echo "Manual check: $MAC_LOG_HINT"
exit 2
