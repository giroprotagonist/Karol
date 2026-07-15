#!/usr/bin/env bash
# Extended verify for Deskreen Direct Player: error injection, skip chain, reconnect probe.
set -euo pipefail

HOST="${DESKREEN_HOST:-127.0.0.1}"
PORT="${DESKREEN_PORT:-3131}"
BASE="http://${HOST}:${PORT}"
PLAYLIST_URL="${PLAYLIST_URL:-https://www.youtube.com/playlist?list=PLRxCSLihrLO4}"

echo "=== Deskreen Direct Player extended verify (${BASE}) ==="

check_json() {
	local path="$1"
	curl -sf "${BASE}${path}" | python3 -m json.tool | head -20
}

echo ""
echo "--- discover + status fields ---"
STATUS="$(curl -sf "${BASE}/api/youtube-dj/status")"
echo "$STATUS" | python3 -m json.tool
echo "$STATUS" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for key in ('showActive', 'queueLength', 'hostMode'):
    assert key in d, f'missing status.{key}'
print('status schema ok')
"

echo ""
echo "--- health ---"
check_json "/api/youtube-dj/health"

echo ""
echo "--- import playlist ---"
curl -sf -X POST "${BASE}/api/youtube-dj/import-playlist" \
	-H 'Content-Type: application/json' \
	-d "{\"playlistUrl\":\"$PLAYLIST_URL\",\"playFirst\":false}" | python3 -m json.tool | head -15

echo ""
echo "--- skip chain (transport/skip-next x2) ---"
for _ in 1 2; do
	curl -sf -X POST "${BASE}/api/youtube-dj/transport/skip-next" \
		-H 'Content-Type: application/json' -d '{}' | python3 -c "
import sys,json
d=json.load(sys.stdin)
assert d.get('ok'), d
print('skip ok, queue len', len(d.get('state',{}).get('queue',[])))
"
	sleep 1
done

echo ""
echo "--- error injection: play missing queue id ---"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/youtube-dj/queue/does-not-exist/play")"
if [ "$CODE" != "404" ]; then
	echo "FAIL expected 404 for missing play, got $CODE"
	exit 1
fi
echo "OK missing play returns 404"

echo ""
echo "--- reconnect probe (rapid health x5) ---"
for i in 1 2 3 4 5; do
	curl -sf "${BASE}/api/youtube-dj/health" >/dev/null
	echo "  health $i ok"
	sleep 0.3
done

echo ""
echo "--- dj-controller static ---"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/dj-controller/")"
if [ "$CODE" != "200" ]; then
	echo "FAIL /dj-controller/ HTTP $CODE"
	exit 1
fi
echo "OK /dj-controller/ HTTP $CODE"

echo ""
echo "=== Extended verify complete ==="
