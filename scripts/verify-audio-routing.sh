#!/usr/bin/env bash
set -euo pipefail

# ── Karol Audio Verification ──
# Run this after setup-uphoria-audio.sh to confirm everything is wired correctly.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0
WARN=0

check() {
    local label="$1"; shift
    if "$@" &>/dev/null; then
        echo -e "  ${GREEN}[PASS]${NC} $label"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}[FAIL]${NC} $label"
        FAIL=$((FAIL + 1))
    fi
}

info() {
    echo -e "  ${YELLOW}[INFO]${NC} $1"
}

echo "=== Karol Audio Verification ==="
echo ""

# ── Hardware ──
echo "Hardware:"
check "UMC404HD detected" system_profiler SPAudioDataType 2>/dev/null | grep -q "UMC404HD"
check "BlackHole 16ch installed" system_profiler SPAudioDataType 2>/dev/null | grep -q "BlackHole 16ch"

# ── Multi-Output Device ──
echo ""
echo "Multi-Output Device:"
KAROL_EXISTS=$(system_profiler SPAudioDataType -json 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
for item in data.get('SPAudioDataType', []):
    for d in item.get('_items', []):
        if d.get('_name', '') == 'Karol':
            print('yes')
            break
" 2>/dev/null || echo "no")

if [ "$KAROL_EXISTS" = "yes" ]; then
    echo -e "  ${GREEN}[PASS]${NC} 'Karol' Multi-Output Device exists"
    PASS=$((PASS + 1))

    # Check if it's the default
    IS_DEFAULT=$(system_profiler SPAudioDataType -json 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
for item in data.get('SPAudioDataType', []):
    for d in item.get('_items', []):
        if d.get('_name') == 'Karol' and d.get('coreaudio_default_audio_output_device') == 'spaudio_yes':
            print('yes')
" 2>/dev/null || echo "no")

    if [ "$IS_DEFAULT" = "yes" ]; then
        echo -e "  ${GREEN}[PASS]${NC} 'Karol' is the default output device"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}[FAIL]${NC} 'Karol' is NOT the default output device"
        FAIL=$((FAIL + 1))
        info "Current default: $(system_profiler SPAudioDataType 2>/dev/null | grep -B 1 'Default System Output Device: Yes' | head -1 | awk '{print $2}')"
    fi
else
    echo -e "  ${RED}[FAIL]${NC} 'Karol' Multi-Output Device does NOT exist"
    FAIL=$((FAIL + 1))
    info "Run: bash scripts/setup-uphoria-audio.sh"
fi

# ── Ableton ──
echo ""
echo "Ableton Live:"
ABLETON_HEALTH=$(curl -s http://127.0.0.1:3131/api/ableton/health 2>/dev/null || echo '{"connected":false}')
ABLETON_CONNECTED=$(echo "$ABLETON_HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('connected',False))" 2>/dev/null || echo "False")

if [ "$ABLETON_CONNECTED" = "True" ]; then
    echo -e "  ${GREEN}[PASS]${NC} Ableton Live running + AbletonOSC connected (port 11000)"
    PASS=$((PASS + 1))
else
    OSC_PORT=$(lsof -i :11000 2>/dev/null | grep LISTEN || true)
    if [ -n "$OSC_PORT" ]; then
        echo -e "  ${YELLOW}[WARN]${NC} AbletonOSC on port 11000 but health check says not connected"
        WARN=$((WARN + 1))
    else
        echo -e "  ${RED}[FAIL]${NC} Ableton Live not detected (port 11000 not listening)"
        FAIL=$((FAIL + 1))
    fi
fi

# ── Karol API Server ──
echo ""
echo "Karol API Server:"
API_HEALTH=$(curl -s http://127.0.0.1:3131/api/ableton/health 2>/dev/null || echo "{}")
if echo "$API_HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if d.get('ok') else 1)" 2>/dev/null; then
    echo -e "  ${GREEN}[PASS]${NC} Karol API server running on port 3131"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}[FAIL]${NC} Karol API server NOT running on port 3131"
    FAIL=$((FAIL + 1))
    info "Start: launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.karol-api.plist"
fi

# ── VLC ──
echo ""
echo "VLC:"
VLC_RUNNING=$(pgrep -x VLC 2>/dev/null && echo "yes" || echo "no")
if [ "$VLC_RUNNING" = "yes" ]; then
    echo -e "  ${GREEN}[PASS]${NC} VLC is running"
    PASS=$((PASS + 1))
else
    echo -e "  ${YELLOW}[WARN]${NC} VLC is not running (needed for playback)"
    WARN=$((WARN + 1))
fi

VLC_HEALTH=$(curl -s http://127.0.0.1:3131/api/vlc-dj/health 2>/dev/null || echo '{}')
VLC_AVAILABLE=$(echo "$VLC_HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('vlcAvailable',False))" 2>/dev/null || echo "False")
if [ "$VLC_AVAILABLE" = "True" ]; then
    echo -e "  ${GREEN}[PASS]${NC} VLC HTTP API reachable"
    PASS=$((PASS + 1))
else
    echo -e "  ${YELLOW}[WARN]${NC} VLC HTTP API not reachable (ensure web interface is enabled)"
    WARN=$((WARN + 1))
fi

# ── Network devices ──
echo ""
echo "Network:"
TAB_S8=$(curl -s --connect-timeout 3 http://192.168.68.57:3131/api/youtube-dj/health 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('youtubeSignedIn',False))" 2>/dev/null || echo "False")
if [ "$TAB_S8" = "True" ]; then
    echo -e "  ${GREEN}[PASS]${NC} Tab S8 player reachable + YouTube signed in"
    PASS=$((PASS + 1))
else
    echo -e "  ${YELLOW}[WARN]${NC} Tab S8 player not reachable or YouTube not signed in"
    WARN=$((WARN + 1))
fi

# ── Audio routing guide ──
echo ""
echo "Ableton Track Layout (Expected):"
ABLETON_MIXER=$(curl -s http://127.0.0.1:3131/api/ableton/mixer-state 2>/dev/null || echo '{"tracks":[]}')
TRACK_COUNT=$(echo "$ABLETON_MIXER" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('tracks',[])))" 2>/dev/null || echo "0")
echo -e "  ${YELLOW}[INFO]${NC} Ableton reports $TRACK_COUNT track(s)"
echo "$ABLETON_MIXER" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for t in d.get('tracks', []):
    print(f'    Track {t[\"index\"]}: {t[\"name\"]} (vol={t.get(\"volume\",0):.0%})')
" 2>/dev/null

# ── Summary ──
echo ""
echo "============================================"
echo -e "  Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}, ${YELLOW}$WARN warnings${NC}"
echo "============================================"

if [ $FAIL -gt 0 ]; then
    echo ""
    echo "Fix failures before proceeding. Run:"
    echo "  bash scripts/setup-uphoria-audio.sh"
    exit 1
fi

if [ $WARN -gt 0 ]; then
    echo ""
    echo "Some warnings — the system should work but may need attention."
fi

echo ""
echo "Audio routing should now work end to end:"
echo "  VLC → BlackHole ch 3-4 → Ableton Track 1 → UMC404HD → PA speakers"
echo "  Mic → UMC404HD input → Ableton Track 0 → UMC404HD → PA speakers"
echo ""
echo "Test with the S24 controller Ableton tab, or:"
echo "  curl http://127.0.0.1:3131/api/ableton/transport/play -X POST"
