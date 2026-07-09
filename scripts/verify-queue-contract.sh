#!/usr/bin/env bash
# API contract smoke test for Android Direct player (queue + transport + playlist ops).
set -uo pipefail

BASE="${DESKREEN_HOST:-http://127.0.0.1:3131}"
API="$BASE/api/youtube-dj"
PASS=0
FAIL=0

check() {
	local name="$1"
	shift
	if eval "$@"; then
		echo "PASS: $name"
		PASS=$((PASS + 1))
	else
		echo "FAIL: $name"
		FAIL=$((FAIL + 1))
	fi
}

json_get() {
	curl -sf --max-time 8 "$1" 2>/dev/null || echo ""
}

post_json() {
	local url="$1"
	local body="${2:-{}}"
	curl -sf --max-time 12 -X POST -H 'Content-Type: application/json' \
		-H 'X-Karol-Client: KarolContractTest/1.0' \
		-d "$body" "$url" 2>/dev/null || echo '{"ok":false}'
}

echo "=== Queue contract verification → $API ==="

STATUS=$(json_get "$API/status")
check "GET /status" '[[ -n "$STATUS" ]] && echo "$STATUS" | grep -q "\"ok\""'

QUEUE=$(json_get "$API/queue")
check "GET /queue has queue array" 'echo "$QUEUE" | grep -q "\"queue\""'

NP=$(json_get "$API/now-playing")
check "GET /now-playing" 'echo "$NP" | grep -qE "\"videoId\"|\"title\""'

CLEAR=$(post_json "$API/queue/clear" '{}')
check "POST /queue/clear" 'echo "$CLEAR" | grep -q "\"ok\":true"'

ADD=$(post_json "$API/queue" '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","action":"queue"}')
check "POST /queue add" 'echo "$ADD" | grep -q "\"ok\":true"'

ADD2=$(post_json "$API/queue" '{"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw","action":"queue"}')
check "POST /queue add second" 'echo "$ADD2" | grep -q "\"ok\":true"'

SORT=$(post_json "$API/queue/sort" '{"mode":"title-asc"}')
check "POST /queue/sort" 'echo "$SORT" | grep -q "\"ok\":true"'

REORDER=$(post_json "$API/queue/reorder" '{"fromIndex":0,"toIndex":1}')
check "POST /queue/reorder" 'echo "$REORDER" | grep -q "\"ok\":true"'

SHUF=$(post_json "$API/queue/shuffle-upcoming" '{}')
check "POST /queue/shuffle-upcoming" 'echo "$SHUF" | grep -q "\"ok\""'

PATCH_SHUF=$(curl -sf --max-time 8 -X PATCH -H 'Content-Type: application/json' \
	-d '{"enabled":true}' "$API/shuffle" 2>/dev/null || echo '{}')
check "PATCH /shuffle" 'echo "$PATCH_SHUF" | grep -q "\"ok\":true"'

PLAY=$(post_json "$API/transport/play" '{}')
check "POST /transport/play" 'echo "$PLAY" | grep -q "\"ok\":true"'

SKIP=$(post_json "$API/transport/skip-next" '{}')
check "POST /transport/skip-next" 'echo "$SKIP" | grep -q "\"ok\":true"'

PREV=$(post_json "$API/transport/skip-prev" '{}')
check "POST /transport/skip-prev" 'echo "$PREV" | grep -q "\"ok\":true"'

PAUSE=$(post_json "$API/transport/pause" '{}')
check "POST /transport/pause" 'echo "$PAUSE" | grep -q "\"ok\":true"'

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
	exit 1
fi
echo "Contract OK"
