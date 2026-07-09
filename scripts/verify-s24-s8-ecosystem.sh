#!/usr/bin/env bash
# Full S24 + Tab S8 ecosystem audit: API, volume, skip, play/pause, UI assets.
# Optional: pull S24 volume debug logs via adb when S24_SERIAL is set.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${DESKREEN_HOST:-192.168.68.57}"
PORT="${DESKREEN_PORT:-3131}"
S24_SERIAL="${S24_SERIAL:-}"

export DESKREEN_HOST="$HOST"
export DESKREEN_PORT="$PORT"

echo "=== Deskreen S24 + Tab S8 ecosystem audit ==="
echo "Tablet: http://${HOST}:${PORT}"

python3 "$ROOT/scripts/verify-s24-s8-ecosystem.py"
PY_EXIT=$?

if [ -n "$S24_SERIAL" ]; then
	echo ""
	echo "=== S24 adb volume log tail (KarolVolDbg) ==="
	adb -s "$S24_SERIAL" logcat -d -t 30 -s KarolVolDbg:I 2>/dev/null | tail -15 || true
fi

# Also run focused sub-checks
echo ""
bash "$ROOT/scripts/verify-s24-volume-proxy.sh"
bash "$ROOT/scripts/verify-s24-s8-connection.sh"

exit "$PY_EXIT"
