#!/usr/bin/env bash
set -euo pipefail

# Karol Controller sync verification
# Tests S24 controller ↔ S8 player sync

S8_HOST="${KAROL_HOST:-192.168.68.50}"
S8_PORT="${KAROL_PORT:-3131}"
BASE="http://$S8_HOST:$S8_PORT"
S24_SERIAL="adb-R5CWC3XF0DP-zLubmK._adb-tls-connect._tcp"

green() { echo -e "\033[32m$1\033[0m"; }
red()   { echo -e "\033[31m$1\033[0m"; }
check() {
	local msg="$1" condition="$2"
	condition=$(echo "$condition" | tr '[:upper:]' '[:lower:]')
	if [ "$condition" = "true" ]; then
		green "  PASS: $msg"
		PASS=$((PASS + 1))
	else
		red "  FAIL: $msg"
		FAIL=$((FAIL + 1))
	fi
}

PASS=0 FAIL=0
echo "=== Karol Controller Sync Test ==="
echo "Player: $BASE"
echo ""

# 1. S8 health
HEALTH=$(curl -sf "$BASE/api/youtube-dj/health")
check "S8 health ok" "$(echo "$HEALTH" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("ok",""))' 2>/dev/null)"
check "S8 show active" "$(echo "$HEALTH" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("showActive",""))' 2>/dev/null)"

# 2. Launch controller
echo ""
echo "2. Launch controller..."
adb -s "$S24_SERIAL" shell am force-stop com.karol.controller 2>/dev/null || true
sleep 1
adb -s "$S24_SERIAL" shell am start -n com.karol.controller/.MainActivity \
	-d "$BASE/dj-controller/" 2>/dev/null || true
sleep 8

# 3. Verify controller has loaded
ACTIVITY=$(adb -s "$S24_SERIAL" shell dumpsys activity activities 2>/dev/null | grep -c "com.karol.controller" || echo "0")
check "controller launched" "$([ "$ACTIVITY" -gt 0 ] && echo true || echo false)"

# 4. Verify Now Bar notification
NP_TITLE=$(echo "$HEALTH" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("currentTitle","")[:40])' 2>/dev/null)
NOTIF=$(adb -s "$S24_SERIAL" shell dumpsys notification 2>/dev/null | grep -c "com.karol.controller" || echo "0")
check "media notification visible" "$([ "$NOTIF" -gt 0 ] && echo true || echo false)"

# 5. Volume test
echo ""
echo "3. Volume sync test..."
OLD_VOL=$(echo "$HEALTH" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("volumeLevel",""))' 2>/dev/null)
curl -sf -X POST "$BASE/api/youtube-dj/transport/volume" \
	-H "Content-Type: application/json" \
	-d '{"level":0.75}' > /dev/null
sleep 1
NEW_HEALTH=$(curl -sf "$BASE/api/youtube-dj/health")
NEW_VOL=$(echo "$NEW_HEALTH" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("volumeLevel",""))' 2>/dev/null)
check "volume changed ($OLD_VOL -> $NEW_VOL)" "$([ "$NEW_VOL" != "$OLD_VOL" ] && echo true || echo false)"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] || exit 1
