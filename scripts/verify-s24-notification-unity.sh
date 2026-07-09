#!/usr/bin/env bash
# S24 notification/MediaSession ↔ tablet API ↔ WebView relay unity audit.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -z "${DESKREEN_HOST:-}" ]]; then
	if command -v adb >/dev/null 2>&1; then
		TABLET=$(adb devices -l | awk '/gts8|tablet|SM_X700/ {print $1; exit}')
		if [[ -n "$TABLET" ]]; then
			IP=$(adb -s "$TABLET" shell ip route 2>/dev/null | awk '/src/ {for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)
			if [[ -n "$IP" ]] && curl -sf --max-time 3 "http://${IP}:3131/api/health.json" >/dev/null 2>&1; then
				export DESKREEN_HOST="http://${IP}:3131"
			fi
		fi
	fi
fi

python3 scripts/verify-s24-notification-unity.py

if [[ -n "${S24_SERIAL:-}" ]] || adb devices -l | grep -qE 'SM_S928|e3q'; then
	echo ""
	echo "=== S24 instrumented notification transport ==="
	S24="${S24_SERIAL:-$(adb devices -l | awk '/SM_S928|e3q/ {print $1; exit}')}"
	if [[ -n "$S24" && -n "${DESKREEN_HOST:-}" ]]; then
		cd "$ROOT/android-controller"
		ANDROID_SERIAL="$S24" ./gradlew connectedDebugAndroidTest --no-daemon -q \
			-Pandroid.testInstrumentationRunnerArguments.deskreenHost="${DESKREEN_HOST}"
		cd "$ROOT"
	fi
fi
