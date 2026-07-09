#!/usr/bin/env bash
# Serves dj-controller assets from the tablet and runs Playwright UI e2e (S24-class viewport).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${DESKREEN_HOST:-}"

if [[ -z "$HOST" ]]; then
	# Try S8 tablet IP via adb
	if command -v adb >/dev/null 2>&1; then
		TABLET=$(adb devices -l | awk '/gts8|tablet|SM_X700/ {print $1; exit}')
		if [[ -n "$TABLET" ]]; then
			IP=$(adb -s "$TABLET" shell ip route 2>/dev/null | awk '/src/ {for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)
			if [[ -n "$IP" ]] && curl -sf --max-time 3 "http://${IP}:3131/api/health.json" >/dev/null 2>&1; then
				HOST="http://${IP}:3131"
			fi
		fi
	fi
fi

if [[ -z "$HOST" ]]; then
	echo "Set DESKREEN_HOST=http://<tablet-ip>:3131 or connect S8 via adb"
	exit 1
fi

export DESKREEN_HOST="$HOST"
echo "=== UI E2E (Galaxy S8 + S24 viewports) → ${DESKREEN_HOST}/dj-controller/ ==="

echo "Checking bundled assets on tablet..."
for path in "/dj-controller/" "/dj-controller/index.html"; do
	code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "${DESKREEN_HOST}${path}")
	echo "  ${path} → HTTP ${code}"
	if [[ "$code" != "200" ]]; then
		echo "FAIL: dj-controller assets missing on tablet — run npm run sync:dj-controller-player"
		exit 1
	fi
done

cd "$ROOT/src/dj-controller"
if [[ ! -d node_modules/@playwright/test ]]; then
	echo "Installing dj-controller dev dependencies..."
	npm ci
	npx playwright install chromium
fi

npm run test:unit
npx playwright test

echo "UI E2E OK"
