#!/usr/bin/env bash
# Install Karol player (S8) and controller (S24) via wireless adb (mDNS discovery).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
PLAYER_APK="$ROOT/android-player/app/build/outputs/apk/debug/app-debug.apk"
CTRL_APK="$ROOT/android-controller/app/build/outputs/apk/debug/app-debug.apk"

S8_SERIAL="${S8_SERIAL:-}"
S24_SERIAL="${S24_SERIAL:-}"

discover_serial() {
	local _model="${1:-}"
	"$ADB" mdns services 2>/dev/null | while read -r serial _ _ hostport; do
		[[ -z "$serial" || "$serial" == "List"* ]] && continue
		"$ADB" connect "$hostport" 2>/dev/null || true
	done || true
	sleep 1
}

echo "=== Karol device install ==="

if [[ ! -f "$PLAYER_APK" ]]; then
	echo "Building player APK..."
	(cd "$ROOT" && npm run build:android-player) >/dev/null
fi
if [[ ! -f "$CTRL_APK" ]]; then
	echo "Building controller APK..."
	(cd "$ROOT/android-controller" && ./gradlew assembleDebug) >/dev/null
fi

echo "Discovering wireless adb devices..."
discover_serial || true
DEVICES=()
while IFS= read -r line; do
	DEVICES+=("$line")
done < <("$ADB" devices -l | awk '/device product:/{print $1}')

for serial in "${DEVICES[@]}"; do
	info=$("$ADB" -s "$serial" shell getprop ro.product.model 2>/dev/null | tr -d '\r')
	if [[ "$info" == *"SM-X"* || "$info" == *"Tab"* || "$info" == *"X700"* ]]; then
		S8_SERIAL="$serial"
	elif [[ "$info" == *"SM-S"* || "$info" == *"Galaxy S"* || "$info" == *"S928"* ]]; then
		S24_SERIAL="$serial"
	fi
done

if [[ -z "$S8_SERIAL" ]]; then
	S8_SERIAL=$("$ADB" devices -l | grep 'gts8wifi' | grep -v '(2)' | head -1 | awk '{print $1}')
fi
if [[ -z "$S24_SERIAL" ]]; then
	S24_SERIAL=$("$ADB" devices -l | grep 'SM_S928\|e3quew' | grep -v '(2)' | head -1 | awk '{print $1}')
fi

if [[ -n "$S8_SERIAL" ]]; then
	echo "Installing player on $S8_SERIAL (upgrade only — keeps app data) ..."
	"$ADB" -s "$S8_SERIAL" install -r "$PLAYER_APK"
	if [[ -f "$ROOT/.karol/youtube-session.json" ]]; then
		echo "Restoring saved YouTube session..."
		KAROL_HOST="${KAROL_HOST:-192.168.68.57}" bash "$ROOT/scripts/player-youtube-session-restore.sh" || true
	fi
	"$ADB" -s "$S8_SERIAL" shell am start -n com.karol.player/.MainActivity 2>/dev/null || true
	echo "Player installed."
else
	echo "WARN: Tab S8 not on adb — enable Wireless debugging on tablet, then re-run."
	echo "  Pair: adb pair <ip>:<pairing-port>"
	echo "  Or set S8_SERIAL=... after adb devices shows the tablet."
fi

if [[ -n "$S24_SERIAL" ]]; then
	echo "Installing controller on $S24_SERIAL ..."
	"$ADB" -s "$S24_SERIAL" install -r "$CTRL_APK"
	TABLET_URL="http://${KAROL_HOST:-192.168.68.57}:${KAROL_PORT:-3131}/dj-controller/"
	echo "Launching controller → $TABLET_URL"
	"$ADB" -s "$S24_SERIAL" shell am force-stop com.karol.controller 2>/dev/null || true
	"$ADB" -s "$S24_SERIAL" shell am start -a android.intent.action.VIEW -d "$TABLET_URL" -n com.karol.controller/.MainActivity 2>/dev/null || true
	echo "Controller installed."
else
	echo "WARN: S24 not on adb."
fi
