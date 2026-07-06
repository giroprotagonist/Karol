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

echo "=== DJ stack health check passed ==="
