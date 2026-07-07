#!/usr/bin/env bash
# Verify tablet volume API round-trip (used by S24 hardware volume proxy).
set -euo pipefail

HOST="${DESKREEN_HOST:-192.168.68.57}"
PORT="${DESKREEN_PORT:-3131}"
BASE="http://${HOST}:${PORT}/api/youtube-dj"

echo "=== S24 volume proxy API smoke test ==="
echo "Host: $BASE"

read_level() {
	curl -sf -m 5 "$BASE/health" | python3 -c "import sys,json; print(json.load(sys.stdin).get('volumeLevel', 'missing'))"
}

before=$(read_level)
echo "Initial volumeLevel: $before"

for level in 0.25 0.5 0.75 1.0; do
	curl -sf -m 5 -X POST "$BASE/transport/volume" \
		-H "Content-Type: application/json" \
		-d "{\"level\": $level}" >/dev/null
	got=$(read_level)
	echo "Set $level -> read $got"
	if ! python3 -c "import sys; exit(0 if abs(float(sys.argv[1]) - float(sys.argv[2])) < 0.02 else 1)" "$level" "$got" 2>/dev/null; then
		echo "FAIL: expected ~$level got $got"
		exit 1
	fi
done

echo "=== Volume API OK ==="
