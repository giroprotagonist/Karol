#!/usr/bin/env bash
# Verify S24 controller app ↔ Tab S8 player pairing (API + dj-controller bundle).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export KAROL_HOST="${KAROL_HOST:-192.168.68.57}"
export KAROL_PORT="${KAROL_PORT:-3131}"

echo "=== S24 ↔ S8 pairing verification ==="
python3 "$ROOT/scripts/verify-s24-s8-pairing.py"
PY=$?

echo ""
bash "$ROOT/scripts/verify-s24-s8-connection.sh"

exit "$PY"
