#!/usr/bin/env bash
# Export YouTube cookies from Mac Electron → push to tablet player → verify.
# Usage: bash scripts/refresh-youtube-session.sh [tablet-ip]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TABLET_IP="${1:-192.168.68.50}"
TABLET_PORT="${KAROL_PORT:-3131}"
ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
# Find the S8 tablet serial
TABLET_SERIAL="${TABLET_SERIAL:-$("$ADB" devices -l 2>/dev/null | grep -i 'sm-x700\|gts8wifi' | grep -v '(2)' | head -1 | awk '{print $1}')}"

echo "=== Refreshing YouTube session ==="

# Step 1: Export from Mac Electron
echo "1/3 Exporting cookies from Mac Electron..."
bash "$ROOT/scripts/mac-youtube-session-export.sh" "$ROOT/.karol/youtube-session.json"

# Step 2: Push to tablet via adb (HTTP API is debug-gated on release builds)
echo "2/3 Pushing session to tablet..."
if [[ -n "$TABLET_SERIAL" ]]; then
	DEVICE_BACKUP="$ROOT/.karol/.yt-device-backup"
	python3 << PY
import base64, pathlib
plain = pathlib.Path("$ROOT/.karol/youtube-session.json").read_text()
pathlib.Path("$DEVICE_BACKUP").write_text(
	base64.b64encode(plain.encode()).decode()
)
PY
	"$ADB" -s "$TABLET_SERIAL" push "$DEVICE_BACKUP" /data/local/tmp/karol-youtube-session.json
	"$ADB" -s "$TABLET_SERIAL" shell run-as com.karol.player cp /data/local/tmp/karol-youtube-session.json /data/data/com.karol.player/files/karol-youtube-session.json
	echo "  Pushed to device — restart Karol Player to auto-restore."
else
	echo "  WARNING: No tablet adb device found. Session exported to $ROOT/.karol/youtube-session.json"
	echo "  Push manually or connect a device."
fi

# Step 3: Verify (API-based check)
echo "3/3 Verifying sign-in status..."
HEALTH=$(curl -sf -m 5 "http://${TABLET_IP}:${TABLET_PORT}/api/youtube-dj/health" 2>/dev/null || echo "{}")
SIGNED_IN=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('youtubeSignedIn', False))" 2>/dev/null || echo "False")
PREMIUM=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('youtubePremiumActive', False))" 2>/dev/null || echo "False")

echo "  youtubeSignedIn: $SIGNED_IN"
echo "  youtubePremiumActive: $PREMIUM"

if [[ "$SIGNED_IN" != "True" ]]; then
	echo "WARNING: Tablet reports not signed in. Restart Karol Player to auto-restore session." >&2
fi

echo "=== Session refresh complete ==="
