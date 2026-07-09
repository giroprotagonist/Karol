#!/usr/bin/env bash
# Full local DJ verification: unit tests + API matrix + UI e2e (Mac only, no GitHub CI).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Android unit tests ==="
cd android-player && ./gradlew testDebugUnitTest --no-daemon -q
cd "$ROOT/android-controller" && ./gradlew testDebugUnitTest --no-daemon -q
cd "$ROOT"

echo ""
echo "=== dj-controller unit tests ==="
cd src/dj-controller && npm run test:unit
cd "$ROOT"

echo ""
echo "=== API contract (requires tablet) ==="
bash scripts/verify-queue-contract.sh
bash scripts/verify-playback-matrix.sh

echo ""
echo "=== UI e2e (requires tablet) ==="
bash scripts/verify-ui-e2e.sh

if command -v adb >/dev/null 2>&1 && adb devices -l | grep -qE 'SM_S928|e3q'; then
	echo ""
	echo "=== S24 notification unity (requires S24 + tablet) ==="
	bash scripts/verify-s24-notification-unity.sh
fi

echo ""
echo "All DJ verification passed"
