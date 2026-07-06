#!/usr/bin/env bash
# Copy dj-controller web build into android-player assets.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/src/dj-controller/dist"
DEST="$ROOT/android-player/app/src/main/assets/dj-controller"

echo "=== Sync dj-controller → android-player ==="
cd "$ROOT"
npm run buildDjController
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SRC/"* "$DEST/"
echo "Copied $(find "$DEST" -type f | wc -l | tr -d ' ') files to $DEST"
