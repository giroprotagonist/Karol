#!/usr/bin/env bash
# Full playback + queue matrix against Android Direct player API.
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

post_json() {
	local url="$1"
	local body="${2:-{}}"
	curl -sf --max-time 15 -X POST -H 'Content-Type: application/json' \
		-H 'X-Karol-Client: KarolPlaybackMatrix/1.0' \
		-d "$body" "$url" 2>/dev/null || echo '{"ok":false}'
}

get_json() {
	curl -sf --max-time 10 "$1" 2>/dev/null || echo ""
}

echo "=== Playback matrix → $API ==="

HEALTH=$(get_json "$API/health")
check "health" 'echo "$HEALTH" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get(\"ok\") is True"'

post_json "$API/queue/clear" '{}' >/dev/null

V1="jNQXAC9IVRw"
V2="dQw4w9WgXcQ"
V3="9bZkp7q19f0"

ADD1=$(post_json "$API/queue" "{\"url\":\"https://www.youtube.com/watch?v=$V1\",\"action\":\"queue\"}")
check "add track 1" 'echo "$ADD1" | grep -q "\"ok\":true"'

ADD2=$(post_json "$API/queue" "{\"url\":\"https://www.youtube.com/watch?v=$V2\",\"action\":\"queue\"}")
check "add track 2" 'echo "$ADD2" | grep -q "\"ok\":true"'

ADD3=$(post_json "$API/queue" "{\"url\":\"https://www.youtube.com/watch?v=$V3\",\"action\":\"queue\"}")
check "add track 3" 'echo "$ADD3" | grep -q "\"ok\":true"'

QUEUE=$(get_json "$API/queue")
check "queue length 3" 'echo "$QUEUE" | python3 -c "import json,sys; d=json.load(sys.stdin); assert len(d.get(\"queue\",[]))==3"'

IDS=$(echo "$QUEUE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(' '.join(x['id'] for x in d['queue']))")
ID1=$(echo "$IDS" | awk '{print $1}')

PLAY_ITEM=$(post_json "$API/queue/$ID1/play" '{}')
check "play queue item" 'echo "$PLAY_ITEM" | grep -q "\"ok\":true"'

NP=$(get_json "$API/now-playing")
check "now-playing has videoId" 'echo "$NP" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get(\"videoId\")"'

PLAY=$(post_json "$API/transport/play" '{}')
check "transport play" 'echo "$PLAY" | grep -q "\"ok\":true"'

PAUSE=$(post_json "$API/transport/pause" '{}')
check "transport pause" 'echo "$PAUSE" | grep -q "\"ok\":true"'

SEEK=$(post_json "$API/transport/seek" '{"seconds":30}')
check "transport seek" 'echo "$SEEK" | grep -q "\"ok\":true"'

SKIP=$(post_json "$API/transport/skip-next" '{}')
check "skip next" 'echo "$SKIP" | grep -q "\"ok\":true"'
IDX_AFTER_SKIP=$(echo "$SKIP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('state',{}).get('currentIndex',-9))" 2>/dev/null || echo "-9")
check "skip advanced index" '[[ "$IDX_AFTER_SKIP" == "1" ]]'

PREV=$(post_json "$API/transport/skip-prev" '{}')
check "skip prev" 'echo "$PREV" | grep -q "\"ok\":true"'
IDX_AFTER_PREV=$(echo "$PREV" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('state',{}).get('currentIndex',-9))" 2>/dev/null || echo "-9")
check "prev restored index" '[[ "$IDX_AFTER_PREV" == "0" ]]'

REORDER=$(post_json "$API/queue/reorder" '{"fromIndex":0,"toIndex":2}')
check "reorder" 'echo "$REORDER" | grep -q "\"ok\":true"'

VOL=$(post_json "$API/transport/volume" '{"level":0.75}')
check "volume" 'echo "$VOL" | grep -q "\"ok\":true"'
STATUS=$(get_json "$API/status")
check "status volume 0.75" 'echo "$STATUS" | python3 -c "import json,sys; d=json.load(sys.stdin); v=d.get(\"volumeLevel\",0); assert abs(v-0.75)<0.01"'

MODE=$(post_json "$API/mode" '{"mode":"manual"}')
check "mode manual" 'echo "$MODE" | grep -q "\"ok\":true"'

SSE_LINE=$(curl -sf --max-time 4 -N "$API/events" 2>/dev/null | head -n 3 || true)
check "SSE session event" 'echo "$SSE_LINE" | grep -q "event: session"'

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
	exit 1
fi
echo "Playback matrix OK"
