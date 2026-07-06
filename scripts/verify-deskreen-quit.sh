#!/usr/bin/env bash
# Smoke test: Deskreen CE quits cleanly during active DJ mode (Cmd+Q path).
set -euo pipefail

APP_NAME="${APP_NAME:-Deskreen CE}"
PORT="${PORT:-3131}"
BACKUP_PORT="${BACKUP_PORT:-3132}"
PLAYLIST_URL="${PLAYLIST_URL:-https://www.youtube.com/playlist?list=PLRxCSLihrLO4}"
QUIT_TIMEOUT_SEC="${QUIT_TIMEOUT_SEC:-10}"

resolve_base_url() {
	if curl -sf "http://127.0.0.1:${PORT}/api/discover.json" >/dev/null 2>&1; then
		echo "http://127.0.0.1:${PORT}"
		return
	fi
	if curl -sf "http://127.0.0.1:${BACKUP_PORT}/api/discover.json" >/dev/null 2>&1; then
		echo "http://127.0.0.1:${BACKUP_PORT}"
		return
	fi
	echo ""
}

echo "=== Deskreen Quit Smoke Test ==="

if ! pgrep -f "$APP_NAME" >/dev/null 2>&1; then
	echo "SKIP: $APP_NAME is not running — start the app and re-run"
	exit 0
fi

BASE="$(resolve_base_url)"
if [ -z "$BASE" ]; then
	echo "FAIL: Deskreen HTTP server not reachable on ${PORT} or ${BACKUP_PORT}"
	exit 1
fi

echo "Using API: $BASE"

echo ""
echo "--- Enable DJ mode (playlist + play) ---"
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

if [ -n "$PLAY_ID" ]; then
	curl -sf -X POST "$BASE/api/youtube-dj/queue/$PLAY_ID/play" \
		-H 'Content-Type: application/json' -d '{}' >/dev/null || true
	sleep 2
fi

DJ_ACTIVE="$(curl -sf "$BASE/api/youtube-dj/status" | python3 -c "import sys,json; print(json.load(sys.stdin).get('djActive',False))" 2>/dev/null || echo False)"
echo "djActive=$DJ_ACTIVE"

echo ""
echo "--- Request quit (AppleScript → Cmd+Q) ---"
osascript -e "tell application \"$APP_NAME\" to quit" 2>/dev/null || true

DEAD=0
for _ in $(seq 1 "$((QUIT_TIMEOUT_SEC * 2))"); do
	if ! pgrep -f "$APP_NAME" >/dev/null 2>&1; then
		DEAD=1
		break
	fi
	sleep 0.5
done

if [ "$DEAD" -ne 1 ]; then
	echo "FAIL: $APP_NAME still running after ${QUIT_TIMEOUT_SEC}s"
	pgrep -fl "$APP_NAME" || true
	exit 1
fi

echo "PASS: process exited"

ACTIVE_PORT=""
for p in "$PORT" "$BACKUP_PORT"; do
	if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
		ACTIVE_PORT="$p"
	fi
done

if [ -n "$ACTIVE_PORT" ]; then
	echo "FAIL: port $ACTIVE_PORT still listening after quit"
	lsof -nP -iTCP:"$ACTIVE_PORT" -sTCP:LISTEN || true
	exit 2
fi

echo "PASS: signaling port released"
echo "=== Quit smoke test complete ==="
