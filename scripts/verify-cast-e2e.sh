#!/usr/bin/env bash
# End-to-end cast soak test: Mac host + Chrome on Android tablet via ADB.
# Exit 0 only when the soak completes without failure signals.
set -euo pipefail

SOAK_SECONDS="${SOAK_SECONDS:-600}"
QUICK="${QUICK:-0}"
if [[ "$QUICK" == "1" ]]; then
	SOAK_SECONDS=60
fi

APP_PATH="/Applications/Deskreen CE.app"
APP_NAME="Deskreen CE"
LOG_FILE="${HOME}/Library/Logs/deskreen-ce/main.log"
PORT="${DESKREEN_PORT:-3131}"
BACKUP_PORT=3132
ADB="${ADB:-${HOME}/Library/Android/sdk/platform-tools/adb}"
CHROME_PKG="com.android.chrome"
RECEIVER_PKG="com.deskreen.receiver"

fail() {
	echo "FAIL: $*" >&2
	exit 1
}

info() {
	echo "[verify-cast] $*"
}

find_host_ip() {
	local ip
	ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
	if [[ -z "$ip" ]]; then
		ip="$(ipconfig getifaddr en1 2>/dev/null || true)"
	fi
	if [[ -z "$ip" ]]; then
		fail "Could not detect Mac LAN IP (en0/en1)"
	fi
	echo "$ip"
}

curl_json() {
	local url="$1"
	curl -sf --max-time 5 "$url"
}

wait_for_http() {
	local base="$1"
	local attempts="${2:-60}"
	for ((i = 1; i <= attempts; i++)); do
		if curl_json "${base}/api/discover.json" >/dev/null 2>&1; then
			return 0
		fi
		sleep 2
	done
	return 1
}

restart_deskreen() {
	info "Quitting ${APP_NAME} if running"
	osascript -e "tell application \"${APP_NAME}\" to quit" 2>/dev/null || true
	pkill -f "Deskreen CE" 2>/dev/null || true
	sleep 2
	if [[ ! -d "$APP_PATH" ]]; then
		fail "App not found at ${APP_PATH}. Run: npm run build:mac:arm64 && cp -R dist/mac-arm64/*.app /Applications/"
	fi
	info "Launching ${APP_NAME}"
	open -a "$APP_PATH"
}

check_screen_permission() {
	local health permission
	health="$(curl_json "${BASE_URL}/api/health.json" 2>/dev/null || echo '{}')"
	permission="$(echo "$health" | python3 -c "import json,sys; print(json.load(sys.stdin).get('permission','unknown'))" 2>/dev/null || echo unknown)"
	if [[ "$permission" != "granted" ]]; then
		# Fallback: probe via bundled Electron helper if present
		if [[ -x "${APP_PATH}/Contents/MacOS/Deskreen CE" ]]; then
			local probe_out
			probe_out="$("${APP_PATH}/Contents/MacOS/Deskreen CE" --probe-screen-capture 2>&1 || true)"
			if echo "$probe_out" | grep -q "screen-permission: granted"; then
				info "Screen permission granted (probe)"
				return 0
			fi
			if echo "$probe_out" | grep -q "sources-count: [1-9]"; then
				info "Screen capture sources available (probe)"
				return 0
			fi
		fi
		fail "Screen Recording permission not granted for Deskreen CE. Enable in System Settings → Privacy & Security → Screen Recording, then restart the app."
	fi
	info "Screen permission: granted"
}

check_adb() {
	if [[ ! -x "$ADB" ]]; then
		fail "adb not found at ${ADB}. Set ADB= path or install Android platform-tools."
	fi
	local devices
	devices="$("$ADB" devices | awk 'NR>1 && $2=="device" {print $1}' | wc -l | tr -d ' ')"
	if [[ "$devices" -lt 1 ]]; then
		fail "No ADB device connected. Pair/connect your tablet first."
	fi
	info "ADB device(s) connected: $("$ADB" devices -l | tail -n +2)"
}

open_share_on_tablet() {
	local url="$1"
	local mode="${CLIENT_MODE:-chrome}"
	info "Opening share URL on tablet (${mode}): ${url}"
	if [[ "$mode" == "webview" ]]; then
		"$ADB" shell am force-stop "$RECEIVER_PKG" >/dev/null 2>&1 || true
		"$ADB" shell am start -n "${RECEIVER_PKG}/.MainActivity" -d "$url" >/dev/null
	else
		"$ADB" shell am force-stop "$CHROME_PKG" >/dev/null 2>&1 || true
		"$ADB" shell am start -a android.intent.action.VIEW \
			-d "$url" \
			-n "${CHROME_PKG}/com.google.android.apps.chrome.Main" >/dev/null
	fi
}

monitor_soak() {
	local start_ts end_ts
	start_ts="$(date +%s)"
	end_ts=$((start_ts + SOAK_SECONDS))
	info "Soaking for ${SOAK_SECONDS}s (until $(date -r "$end_ts" '+%H:%M:%S'))"

	local log_offset=0
	if [[ -f "$LOG_FILE" ]]; then
		log_offset="$(wc -c < "$LOG_FILE" | tr -d ' ')"
	fi

	"$ADB" logcat -c >/dev/null 2>&1 || true

	local capture_seen=0
	local capture_lost=0
	local sustained_checks=0
	local failures=()

	while [[ "$(date +%s)" -lt "$end_ts" ]]; do
		sleep 5

		if ! pgrep -f "Deskreen CE" >/dev/null 2>&1; then
			failures+=("Deskreen CE process exited during soak")
			break
		fi

		local health capture permission active
		health="$(curl_json "${BASE_URL}/api/health.json" 2>/dev/null || echo '{}')"
		capture="$(echo "$health" | python3 -c "import json,sys; print('true' if json.load(sys.stdin).get('captureActive') else 'false')" 2>/dev/null || echo false)"
		permission="$(echo "$health" | python3 -c "import json,sys; print(json.load(sys.stdin).get('permission',''))" 2>/dev/null || echo '')"
		active="$(echo "$health" | python3 -c "import json,sys; print(json.load(sys.stdin).get('activeSharingCount',0))" 2>/dev/null || echo 0)"

		if [[ "$capture" == "true" && "$active" -ge 1 ]]; then
			capture_seen=1
			sustained_checks=$((sustained_checks + 1))
		elif [[ "$capture_seen" -eq 1 ]]; then
			capture_lost=$((capture_lost + 1))
			if [[ "$capture_lost" -ge 3 ]]; then
				failures+=("Capture/sharing dropped and stayed off for 15+ seconds")
				break
			fi
		fi

		if [[ -f "$LOG_FILE" ]]; then
			local new_chunk
			new_chunk="$(tail -c +"$((log_offset + 1))" "$LOG_FILE" 2>/dev/null || true)"
			log_offset="$(wc -c < "$LOG_FILE" | tr -d ' ')"

			if [[ "$capture_seen" -eq 1 ]]; then
				if echo "$new_chunk" | grep -q "desktop capture track ended"; then
					failures+=("Mac log: desktop capture track ended")
				fi
				if echo "$new_chunk" | grep -q "Failed to get sources"; then
					failures+=("Mac log: Failed to get sources during active capture")
				fi
				if echo "$new_chunk" | grep -q "host capture session ended"; then
					failures+=("Mac log: host capture session ended during soak")
				fi
			fi
		fi

		local logcat_chunk
		logcat_chunk="$("$ADB" logcat -d -t 200 2>/dev/null || true)"
		if echo "$logcat_chunk" | grep -qi "remote video track ended"; then
			failures+=("Tablet logcat: remote video track ended")
		fi
		if echo "$logcat_chunk" | grep -qi "error in simple peer"; then
			failures+=("Tablet logcat: error in simple peer")
		fi
		if [[ "${CLIENT_MODE:-chrome}" == "webview" ]]; then
			if echo "$logcat_chunk" | grep -qi "renderer process gone"; then
				failures+=("Tablet logcat: WebView renderer process gone")
			fi
		fi

		if [[ "${#failures[@]}" -gt 0 ]]; then
			break
		fi
	done

	if [[ "$capture_seen" -ne 1 ]]; then
		failures+=("Never observed active capture/sharing during soak (captureActive and activeSharingCount)")
	elif [[ "$sustained_checks" -lt 6 ]]; then
		failures+=("Capture/sharing was not sustained for at least 30 seconds")
	fi

	if [[ "${#failures[@]}" -gt 0 ]]; then
		printf 'FAILURES:\n' >&2
		printf ' - %s\n' "${failures[@]}" >&2
		fail "Soak test failed after $(( $(date +%s) - start_ts ))s"
	fi

	info "Soak passed (${SOAK_SECONDS}s, capture was active)"
}

HOST_IP="$(find_host_ip)"
BASE_URL="http://${HOST_IP}:${PORT}"

info "Host: ${BASE_URL} | soak=${SOAK_SECONDS}s | client=${CLIENT_MODE:-chrome}"

check_adb
restart_deskreen

if ! wait_for_http "$BASE_URL" 90; then
	if wait_for_http "http://${HOST_IP}:${BACKUP_PORT}" 15; then
		PORT="$BACKUP_PORT"
		BASE_URL="http://${HOST_IP}:${PORT}"
		info "Using backup port ${PORT}"
	else
		fail "Deskreen HTTP server did not become ready"
	fi
fi

check_screen_permission

DISCOVER="$(curl_json "${BASE_URL}/api/discover.json")"
READY="$(echo "$DISCOVER" | python3 -c "import json,sys; print('true' if json.load(sys.stdin).get('ready') else 'false')")"
SHARE_URL="$(echo "$DISCOVER" | python3 -c "import json,sys; print(json.load(sys.stdin).get('shareUrl') or '')")"

if [[ "$READY" != "true" || -z "$SHARE_URL" ]]; then
	fail "discover.json not ready or missing shareUrl: ${DISCOVER}"
fi
info "shareUrl=${SHARE_URL}"

open_share_on_tablet "$SHARE_URL"

info "Waiting 15s for auto-connect and capture to start"
sleep 15

monitor_soak
info "PASS: verify-cast completed successfully"
exit 0
