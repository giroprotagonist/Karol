#!/usr/bin/env bash
# Verify S24 controller can reach Tab S8 player API and dj-controller SPA.
set -euo pipefail

HOST="${KAROL_HOST:-192.168.68.57}"
PORT="${KAROL_PORT:-3131}"
BASE="http://${HOST}:${PORT}"

echo "=== Karol S24 ↔ Tab S8 connectivity ==="
echo "Host: $BASE"

health=$(curl -sf -m 5 "$BASE/api/youtube-dj/health") || {
	echo "FAIL: health unreachable at $BASE"
	exit 1
}
echo "OK: health $(echo "$health" | python3 -c "import sys,json; d=json.load(sys.stdin); print('showActive=', d.get('showActive'), 'host=', d.get('host'))")"

code=$(curl -sf -m 5 -o /dev/null -w "%{http_code}" "$BASE/dj-controller/")
echo "OK: dj-controller HTTP $code"

play=$(curl -sf -m 10 -X POST "$BASE/api/youtube-dj/transport/play" -H "Content-Type: application/json" -d '{}')
echo "OK: transport/play $(echo "$play" | python3 -c "import sys,json; d=json.load(sys.stdin); print('state=', d.get('nowPlaying',{}).get('state'))")"

skip=$(curl -sf -m 15 -X POST "$BASE/api/youtube-dj/transport/skip-next" -H "Content-Type: application/json" -d '{}')
echo "OK: transport/skip-next $(echo "$skip" | python3 -c "import sys,json; d=json.load(sys.stdin); np=d.get('nowPlaying',{}); print((np.get('title') or '')[:50])")"

echo "=== All checks passed ==="
