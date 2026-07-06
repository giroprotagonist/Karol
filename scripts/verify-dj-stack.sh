#!/usr/bin/env bash
set -euo pipefail

PORT="${DESKREEN_PORT:-3131}"
HOST="${DESKREEN_HOST:-127.0.0.1}"
BASE="http://${HOST}:${PORT}"

echo "=== DJ stack health check (${BASE}) ==="

check() {
	local path="$1"
	local code
	code="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}${path}" || echo "000")"
	if [[ "$code" != "200" ]]; then
		echo "FAIL ${path} (HTTP ${code})"
		exit 1
	fi
	echo "OK   ${path}"
}

sleep 2
check "/api/health.json"
check "/api/youtube-dj/health"
check "/dj-controller/"

QUEUE_JSON="$(curl -sf "${BASE}/api/youtube-dj/queue")"
UPDATED_AT="$(echo "$QUEUE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('updatedAt',''))" 2>/dev/null || echo "")"
if [[ -z "$UPDATED_AT" ]]; then
	echo "WARN /api/youtube-dj/queue missing updatedAt (renderer may be idle)"
else
	echo "OK   /api/youtube-dj/queue updatedAt=$UPDATED_AT"
fi

echo "=== DJ stack health check passed ==="
