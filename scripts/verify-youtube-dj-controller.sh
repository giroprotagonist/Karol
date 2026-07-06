#!/usr/bin/env bash
set -euo pipefail

HOST="${1:-127.0.0.1:3131}"
BASE="http://${HOST}"

echo "=== YouTube DJ Controller API smoke test ==="
echo "Host: $BASE"

curl -sf "$BASE/api/youtube-dj/health" | head -c 200
echo ""
curl -sf "$BASE/api/discover.json" | head -c 400
echo ""
curl -sf "$BASE/api/youtube-dj/status" | head -c 400
echo ""
curl -sf "$BASE/api/youtube-dj/queue" | head -c 400
echo ""
curl -sf "$BASE/api/youtube-dj/playlist" | head -c 400
echo ""
curl -sf "$BASE/api/youtube-dj/now-playing" | head -c 400
echo ""

CODE="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/dj-controller/")"
if [ "$CODE" != "200" ]; then
  echo "FAIL: /dj-controller/ returned HTTP $CODE"
  exit 1
fi
echo "OK: /dj-controller/ served (HTTP $CODE)"
echo "=== Done ==="
