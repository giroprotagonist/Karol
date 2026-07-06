#!/usr/bin/env bash
# Verify Deskreen Direct Player API on tablet (or emulator with port forward).
set -euo pipefail

HOST="${DESKREEN_HOST:-127.0.0.1}"
PORT="${DESKREEN_PORT:-3131}"
BASE="http://${HOST}:${PORT}"
PLAYLIST_URL="${PLAYLIST_URL:-https://www.youtube.com/playlist?list=PLRxCSLihrLO4}"

echo "=== Deskreen Direct Player verify (${BASE}) ==="

check_json() {
	local path="$1"
	curl -sf "${BASE}${path}" | python3 -m json.tool | head -20
}

echo ""
echo "--- discover.json ---"
DISCOVER="$(curl -sf "${BASE}/api/discover.json")"
echo "$DISCOVER" | python3 -m json.tool
ROLE="$(echo "$DISCOVER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('role',''))")"
if [ "$ROLE" != "dj-player" ]; then
	echo "WARN: expected role=dj-player, got '$ROLE' (is Mac Deskreen running instead?)"
fi

echo ""
echo "--- health + status ---"
check_json "/api/youtube-dj/health"
check_json "/api/youtube-dj/status"

echo ""
echo "--- dj-controller static ---"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/dj-controller/")"
if [ "$CODE" != "200" ]; then
	echo "FAIL /dj-controller/ HTTP $CODE"
	exit 1
fi
echo "OK /dj-controller/ HTTP $CODE"

echo ""
echo "--- import playlist + play ---"
curl -sf -X POST "${BASE}/api/youtube-dj/import-playlist" \
	-H 'Content-Type: application/json' \
	-d "{\"playlistUrl\":\"$PLAYLIST_URL\",\"playFirst\":true}" | python3 -m json.tool | head -25

echo ""
echo "--- now-playing progress ---"
for i in 1 2 3; do
	curl -sf "${BASE}/api/youtube-dj/now-playing" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f\"  t={d.get('currentTime',0):.1f}s state={d.get('state')} vid={d.get('videoId','')[:11]}\")
"
	sleep 2
done

echo ""
echo "--- reorder queue ---"
QUEUE="$(curl -sf "${BASE}/api/youtube-dj/queue")"
LEN="$(echo "$QUEUE" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('queue',[])))")"
if [ "$LEN" -ge 2 ]; then
	curl -sf -X POST "${BASE}/api/youtube-dj/queue/reorder" \
		-H 'Content-Type: application/json' \
		-d '{"fromIndex":0,"toIndex":1}' | python3 -c "import sys,json; print('reorder ok', json.load(sys.stdin).get('ok'))"
else
	echo "SKIP reorder (queue len=$LEN)"
fi

echo ""
echo "=== Direct player verify complete ==="
