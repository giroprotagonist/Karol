#!/bin/bash
# Build Karol from repo and install to /Applications/Karol.app
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON="$ROOT/electron-app"
DIST="$ELECTRON/dist/mac-arm64/Karol.app"
TARGET="/Applications/Karol.app"

echo "═══ Karol install ═══"

if pgrep -x Karol >/dev/null 2>&1; then
  echo "Quitting Karol…"
  osascript -e 'quit app "Karol"' 2>/dev/null || true
  sleep 2
fi

cd "$ELECTRON"
echo "→ npm run build:full"
npm run build:full

if [[ ! -d "$DIST" ]]; then
  echo "ERROR: Build failed — $DIST not found" >&2
  exit 1
fi

if [[ -d "$TARGET" ]]; then
  BAK="${TARGET}.bak-$(date +%Y%m%d-%H%M%S)"
  echo "→ Backing up $TARGET → $BAK"
  mv "$TARGET" "$BAK"
  # Drop stale install backups — only /Applications/Karol.app should remain after install.
  while IFS= read -r old; do
    [[ -z "$old" || "$old" == "$BAK" ]] && continue
    echo "→ Removing old backup $old"
    rm -rf "$old"
  done < <(ls -dt /Applications/Karol.app.bak-* 2>/dev/null || true)
fi

echo "→ Installing to $TARGET"
cp -R "$DIST" "$TARGET"

# Ad-hoc sign for local launch (Gatekeeper)
xattr -cr "$TARGET" 2>/dev/null || true
codesign --force --deep --sign - "$TARGET" 2>/dev/null || true

if [[ -n "${BAK:-}" && -d "$BAK" ]]; then
  echo "→ Removing install backup $BAK"
  rm -rf "$BAK"
fi

echo "✓ Installed $(defaults read "$TARGET/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo 1.0.0) → $TARGET"
echo "  Open Karol from Applications or: open -a Karol"
