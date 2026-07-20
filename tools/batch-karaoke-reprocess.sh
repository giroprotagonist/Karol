#!/usr/bin/env bash
# batch-karaoke-reprocess.sh
# Re-process existing karaoke videos with faster Demucs + Whisper AI fallback.
#
# Usage:
#   ./tools/batch-karaoke-reprocess.sh              # Process problem songs only
#   ./tools/batch-karaoke-reprocess.sh --all        # Reprocess all 31 songs (fast LRCLIB re-check)
#   ./tools/batch-karaoke-reprocess.sh --all --whisper  # Full Whisper on all 31 (slow!)
#   ./tools/batch-karaoke-reprocess.sh --parallel 3     # Run 3 songs in parallel
#
# Video IDs grouped by issue:
#   - NO lyrics: 7Ja4ogRswHA, NtN2Ni4J44o
#   - Very few (10-17): VUFr92i5jkA, S29ECoVRuUo, rFTKDs-FtVE, J1NHGypezNw

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PYTHON_BIN="/opt/homebrew/bin/python3"
MAKE_SCRIPT="$SCRIPT_DIR/make-karaoke-video.py"
LIBRARY_DIR="/Volumes/maxone/Deskreen/karaoke"

# ── Config ──
ALL_IDS=(
    -TOXwru_UX4 6IxJwcBVb38 6Zbi0XmGtMw 7Ja4ogRswHA 7ddPvWjHjXE
    BnroMugU9qk DTZo-7FwgEA FWKoOiQ1NVM J1NHGypezNw K5aF9hmnTxs
    KbfW5ZwCtVM MTfpK7dYcdQ N5osh-khlX4 NtN2Ni4J44o P_SlAzsXa7E
    Q2Dh2B_M98U S29ECoVRuUo TC1oTT-ZNcQ VUFr92i5jkA W2VtWFoUDJk
    WZzcY7ASQno beJsQSBda5g esKBQd02n4Y hfwRjf675Ak iXqcPvUIzRQ
    j58V2vC9EPc lLBPrAJf52E ltOipiXH_6Y oAHoEWgPL00 rFTKDs-FtVE
    tJoQGQQ2bMw
)

# Problem songs: need Whisper
PROBLEM_IDS=(
    7Ja4ogRswHA    # NO LRC
    NtN2Ni4J44o    # NO LRC
    VUFr92i5jkA    # 10 lines
    S29ECoVRuUo    # 13 lines
    rFTKDs-FtVE    # 16 lines
    J1NHGypezNw    # 17 lines
)

DO_ALL=false
DO_WHISPER=false
PARALLEL=1

# ── Parse args ──
while [[ $# -gt 0 ]]; do
    case "$1" in
        --all) DO_ALL=true; shift ;;
        --whisper) DO_WHISPER=true; shift ;;
        --parallel) PARALLEL="$2"; shift 2 ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

# ── Determine target IDs ──
if $DO_ALL; then
    IDS=("${ALL_IDS[@]}")
else
    IDS=("${PROBLEM_IDS[@]}")
fi

# ── Build args for each ID ──
PROCESS_ARGS=()
for id in "${IDS[@]}"; do
    args="--reprocess"
    if $DO_WHISPER || [[ "$id" == "7Ja4ogRswHA" || "$id" == "NtN2Ni4J44o" ]]; then
        # Always Whisper for songs with no lyrics at all
        args="$args --force-whisper"
    fi
    PROCESS_ARGS+=("$id $args")
done

echo "============================================"
echo "Karaoke Batch Reprocess"
echo "============================================"
echo "Target:   ${#IDS[@]} songs"
echo "Whisper:  $DO_WHISPER"
echo "Parallel: $PARALLEL"
echo ""

# ── Show plan ──
for id in "${IDS[@]}"; do
    existing="$LIBRARY_DIR/${id}-karaoke.mp4"
    if [ -f "$existing" ]; then
        size=$(du -h "$existing" | cut -f1)
        echo "  $id  (exists, $size)"
    else
        echo "  $id  (MISSING — will be skipped)"
    fi
done

echo ""
read -p "Proceed? [y/N] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
fi

echo ""
echo "Starting batch process..."
echo ""

START_TIME=$(date +%s)
SUCCESS=0
FAILED=0

# ── Run processing ──
if [ "$PARALLEL" -le 1 ]; then
    # Sequential
    for entry in "${PROCESS_ARGS[@]}"; do
        id="${entry%% *}"
        extra="${entry#* }"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "▶ Processing: $id"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        if $PYTHON_BIN "$MAKE_SCRIPT" "$id" $extra; then
            SUCCESS=$((SUCCESS + 1))
            echo "✅ $id DONE"
        else
            FAILED=$((FAILED + 1))
            echo "❌ $id FAILED"
        fi
        echo ""
    done
else
    # Parallel mode — use xargs to run N at a time
    echo "Running $PARALLEL songs in parallel..."
    tmpfile=$(mktemp)
    for entry in "${PROCESS_ARGS[@]}"; do
        echo "$entry"
    done > "$tmpfile"

    while read -r entry; do
        id="${entry%% *}"
        extra="${entry#* }"
        sem -j "$PARALLEL" "$PYTHON_BIN" "$MAKE_SCRIPT" "$id" $extra
    done < "$tmpfile"
    sem --wait
    rm "$tmpfile"
    echo "Parallel batch complete. Check logs above for results."
    SUCCESS=$(grep -c "DONE" /dev/stdin 2>/dev/null || echo "N/A")
    FAILED="N/A"
fi

ELAPSED=$(( $(date +%s) - START_TIME ))
MIN=$(( ELAPSED / 60 ))
SEC=$(( ELAPSED % 60 ))

echo "============================================"
echo "Batch Complete!"
echo "⏱   Time:   ${MIN}m ${SEC}s"
echo "✅ Success:  $SUCCESS"
echo "❌ Failed:   $FAILED"
echo "============================================"

# ── After processing: quickly rescan with node so the controller picks up new lyrics ──
echo ""
echo "Rescanning library cache..."
node -e "
const lib = require('$SCRIPT_DIR/../electron-app/library.js');
lib.init().then(() => lib.scan(false)).then(() => {
    console.log('Library cache updated');
    process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });
" 2>/dev/null || echo "(library rescan skipped — not running from Electron context)"
