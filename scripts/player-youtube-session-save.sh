#!/usr/bin/env bash
# Save YouTube WebView session from the tablet player (after signing in once).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${DESKREEN_HOST:-192.168.68.57}"
PORT="${DESKREEN_PORT:-3131}"
OUT="$ROOT/.deskreen/youtube-session.json"
mkdir -p "$(dirname "$OUT")"

echo "Saving YouTube session from http://${HOST}:${PORT} → $OUT"
SIGNED=$(curl -sf -m 8 "http://${HOST}:${PORT}/api/youtube-dj/health" \
	| python3 -c "import sys,json; print(json.load(sys.stdin).get('youtubeSignedIn', False))" 2>/dev/null || echo "unknown")
if [[ "$SIGNED" != "True" && "$SIGNED" != "true" ]]; then
	echo "WARN: tablet is not signed in yet — open Deskreen Player → Sign in to YouTube, then re-run this."
fi
curl -sf -m 10 "http://${HOST}:${PORT}/api/youtube-dj/dev/youtube-session" -o "$OUT"
python3 -c "import json; d=json.load(open('$OUT')); assert d.get('cookies') and len(d['cookies'])>0, 'no cookies — sign in on tablet first'"
echo "Saved $(python3 -c "import json; print(len(json.load(open('$OUT'))['cookies']))") cookie entries."
