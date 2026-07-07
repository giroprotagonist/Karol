#!/usr/bin/env bash
# Copy dj-controller web build and YouTube kiosk JS into android-player assets.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/src/dj-controller/dist"
DEST="$ROOT/android-player/app/src/main/assets/dj-controller"
KIOSK_SRC="$ROOT/src/youtube-kiosk/youtubeWatchLayout.js"
KIOSK_DEST="$ROOT/android-player/app/src/main/assets/youtubeWatchLayout.js"

echo "=== Sync dj-controller → android-player ==="
cd "$ROOT"
npm run buildDjController
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SRC/"* "$DEST/"
cp "$KIOSK_SRC" "$KIOSK_DEST"
echo "Copied $(find "$DEST" -type f | wc -l | tr -d ' ') dj-controller files to $DEST"
echo "Synced YouTube kiosk JS to $KIOSK_DEST"
