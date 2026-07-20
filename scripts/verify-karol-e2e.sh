#!/usr/bin/env bash
set -euo pipefail

# Karol E2E verification — auto-advance + playback
# Uses the dedicated test playlist

HOST="${KAROL_HOST:-192.168.68.50}"
PORT="${KAROL_PORT:-3131}"
BASE="http://$HOST:$PORT"
TEST_PLAYLIST="PLGKtSCMf0XtO3YKUexSYy4sG1K1Aul942"

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
echo "=== Karol E2E Test ==="
echo "Player: $BASE"
echo "Test playlist: $TEST_PLAYLIST"
echo ""

# 1. Health check
echo "1. Health check"
HEALTH=$(curl -sf "$BASE/api/youtube-dj/health")
check "ok" "$(echo "$HEALTH" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("ok",""))' 2>/dev/null)"
check "signedIn" "$(echo "$HEALTH" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("youtubeSignedIn",""))' 2>/dev/null)"

# 2. Import test playlist
echo ""
echo "2. Import test playlist"
RESULT=$(curl -sf -X POST "$BASE/api/youtube-dj/import-playlist" \
	-H "Content-Type: application/json" \
	-d "{\"playlistUrl\":\"https://www.youtube.com/playlist?list=$TEST_PLAYLIST\",\"replace\":true,\"playFirst\":true}")
check "imported" "$(echo "$RESULT" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("ok",""))' 2>/dev/null)"

# 3. Verify video playing
echo ""
echo "3. Verify first video playing..."
sleep 8
NP=$(curl -sf "$BASE/api/youtube-dj/now-playing")
VIDEO1=$(echo "$NP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("videoId",""))' 2>/dev/null)
STATE=$(echo "$NP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("state",""))' 2>/dev/null)
TITLE1=$(echo "$NP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("title",""))' 2>/dev/null)
check "first video playing (state=$STATE)" "$([ "$STATE" = "1" ] && echo true || echo false)"
check "first video has title" "$([ -n "$TITLE1" ] && [ "$TITLE1" != "null" ] && echo true || echo false)"
echo "  Playing: $TITLE1 ($VIDEO1)"

# 4. Skip next — verify queue advance
echo ""
echo "4. Skip to next video..."
curl -sf -X POST "$BASE/api/youtube-dj/transport/skip-next" -H "Content-Type: application/json" > /dev/null
sleep 8
NP=$(curl -sf "$BASE/api/youtube-dj/now-playing")
VIDEO2=$(echo "$NP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("videoId",""))' 2>/dev/null)
STATE2=$(echo "$NP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("state",""))' 2>/dev/null)
TITLE2=$(echo "$NP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("title",""))' 2>/dev/null)
check "video changed" "$([ "$VIDEO2" != "$VIDEO1" ] && echo true || echo false)"
check "second video playing (state=$STATE2)" "$([ "$STATE2" = "1" ] && echo true || echo false)"
echo "  Now playing: $TITLE2 ($VIDEO2)"

# 5. Save session
echo ""
echo "5. Save YouTube session..."
curl -sf "$BASE/api/youtube-dj/dev/youtube-session" > .karol/youtube-session.json 2>/dev/null
check "session saved" "$([ -s .karol/youtube-session.json ] && echo true || echo false)"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] || exit 1
