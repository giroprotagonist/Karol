#!/usr/bin/env bash
# Local Mac verification — replaces GitHub Actions (no cloud CI).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Typecheck ==="
npm run typecheck

echo ""
echo "=== Build dj-controller ==="
npm run buildDjController

echo ""
echo "=== Sync dj-controller → player assets ==="
bash ./scripts/sync-dj-controller-to-player.sh

echo ""
echo "=== Android unit tests + debug APKs ==="
cd android-player && ./gradlew testDebugUnitTest assembleDebug --no-daemon
cd "$ROOT/android-controller" && ./gradlew testDebugUnitTest assembleDebug --no-daemon

echo ""
echo "Local verification OK (run verify:player-direct / verify:queue-contract with tablet on LAN)"
