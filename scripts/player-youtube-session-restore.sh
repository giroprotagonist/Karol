#!/usr/bin/env bash
# Restore YouTube WebView session to the tablet player (release builds use adb path).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${KAROL_HOST:-192.168.68.57}"
PORT="${KAROL_PORT:-3131}"
SRC="$ROOT/.karol/youtube-session.json"
ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
S8_SERIAL="${S8_SERIAL:-}"

if [[ ! -f "$SRC" ]]; then
	echo "No saved session at $SRC"
	echo "Sign in on the tablet once, then run: npm run player:save-youtube-session"
	exit 1
fi

echo "Restoring YouTube session to http://${HOST}:${PORT}"
for i in 1 2 3 4 5 6; do
	if curl -sf -m 10 -X PUT "http://${HOST}:${PORT}/api/youtube-dj/dev/youtube-session" \
		-H "Content-Type: application/json" \
		--data-binary @"$SRC" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('ok') else 1)"; then
		curl -sf -m 5 "http://${HOST}:${PORT}/api/youtube-dj/health" \
			| python3 -c "import sys,json; d=json.load(sys.stdin); print('youtubeSignedIn:', d.get('youtubeSignedIn'))" \
			|| true
		echo "Session restored via API."
		exit 0
	fi
	sleep 2
done

echo "API restore failed — pushing on-device backup file..."
DEVICE_BACKUP="$ROOT/.karol/.yt-device-backup"
python3 << PY
import base64, pathlib
plain = pathlib.Path("$SRC").read_text()
pathlib.Path("$DEVICE_BACKUP").write_text(
    base64.b64encode(plain.encode()).decode()
)
PY

if [[ -z "$S8_SERIAL" ]]; then
	S8_SERIAL=$("$ADB" devices -l | grep 'gts8wifi' | grep -v '(2)' | head -1 | awk '{print $1}')
fi
if [[ -n "$S8_SERIAL" ]]; then
	"$ADB" -s "$S8_SERIAL" push "$DEVICE_BACKUP" /data/local/tmp/karol-youtube-session.json
	"$ADB" -s "$S8_SERIAL" shell run-as com.karol.player cp /data/local/tmp/karol-youtube-session.json /data/data/com.karol.player/files/karol-youtube-session.json
	echo "Pushed device backup — restart Karol Player to auto-restore."
	exit 0
fi

echo "FAIL: could not restore (tablet API unreachable and no S8 adb)"
exit 1
