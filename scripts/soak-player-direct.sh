#!/usr/bin/env bash
# Overnight-style soak: poll health, random skips, simulated blips (host unreachable).
set -euo pipefail

HOST="${DESKREEN_HOST:-127.0.0.1}"
PORT="${DESKREEN_PORT:-3131}"
BASE="http://${HOST}:${PORT}"
CYCLES="${SOAK_CYCLES:-60}"
SKIP_EVERY="${SOAK_SKIP_EVERY:-5}"
BLIP_EVERY="${SOAK_BLIP_EVERY:-15}"
BLIP_SEC="${SOAK_BLIP_SEC:-3}"

echo "=== Deskreen Direct Player soak (${CYCLES} cycles on ${BASE}) ==="

health() {
	curl -sf --max-time 2 "${BASE}/api/youtube-dj/health" >/dev/null
}

skip_next() {
	curl -sf --max-time 3 -X POST "${BASE}/api/youtube-dj/transport/skip-next" \
		-H 'Content-Type: application/json' -d '{}' >/dev/null
}

failures=0
for ((i = 1; i <= CYCLES; i++)); do
	if (( i % BLIP_EVERY == 0 )); then
		echo "[cycle $i] simulating WiFi blip (${BLIP_SEC}s pause)"
		sleep "$BLIP_SEC"
	fi

	if health; then
		echo "[cycle $i] health ok"
	else
		echo "[cycle $i] health FAILED"
		failures=$((failures + 1))
	fi

	if (( i % SKIP_EVERY == 0 )); then
		if skip_next; then
			echo "[cycle $i] skip ok"
		else
			echo "[cycle $i] skip FAILED"
			failures=$((failures + 1))
		fi
	fi

	sleep 2
done

echo ""
echo "Soak complete: $failures failure(s) in $CYCLES cycles"
if [ "$failures" -gt 0 ]; then
	exit 1
fi
