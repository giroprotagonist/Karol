#!/usr/bin/env bash
# YouTube DJ cast readiness checks (host-side). Run while Deskreen CE is running.
set -euo pipefail

PORT="${DESKREEN_PORT:-3131}"
BASE_URL="http://127.0.0.1:${PORT}"

info() { echo "[verify-youtube-dj] $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

info "Checking Deskreen health at ${BASE_URL}"
if ! curl -sf --max-time 5 "${BASE_URL}/api/health.json" >/dev/null; then
	fail "Deskreen CE not responding on port ${PORT}. Start the app first."
fi

info "Checking YouTube DJ API"
if ! curl -sf --max-time 5 "${BASE_URL}/api/youtube-dj/health" | grep -q '"ok":true'; then
	fail "YouTube DJ API health check failed"
fi

info "Now playing snapshot"
curl -sf --max-time 5 "${BASE_URL}/api/youtube-dj/now-playing" || true
echo

info "Manual checklist:"
echo "  1. Click 'Start DJ Session' in Deskreen — output window should open"
echo "  2. Panel should show: 'Output window is capture source' (green)"
echo "  3. Open receiver on S8 — panel should show: 'Tablet cast connected' (green)"
echo "  4. Click 'Load test playlist' — video must be VISIBLE in output window (not black)"
echo "  5. S8 should show the same video stream (not 'Something went wrong')"
echo
info "If cast fails, check Mac logs for:"
echo "  [auto-connect] youtube-window-not-found | pick-required | stream not ready"
echo "If S8 shows error, check receiver console for:"
echo "  [DESKREEN_RECEIVER_ERROR]"
echo
info "OK — host APIs reachable. Complete manual steps above to verify full cast."
