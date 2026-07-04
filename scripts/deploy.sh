#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------------------
# Fast Mac build + deploy for Deskreen CE
# Signs with Apple Development cert for stable code identity
# so macOS remembers permissions across deploys.
# ------------------------------------------------------------------

APP_NAME="Deskreen CE"
APP_PATH="/Applications/${APP_NAME}.app"
BUNDLE_ID="com.deskreen-ce.app"

echo "=== Step 0: Kill any running instances ==="
pkill -9 -f "${APP_NAME}" 2>/dev/null || true
pkill -9 -f "Deskreen" 2>/dev/null || true
sleep 1

echo ""
echo "=== Step 1: Clean previous build artifacts ==="
rm -rf dist/mac dist/mac-arm64 dist/mac-unpacked 2>/dev/null || true

echo ""
echo "=== Step 2: Build client viewer ==="
cd src/client-viewer && npm run build && cd ../..

echo ""
echo "=== Step 3: Build Electron (vite) ==="
npx electron-vite build

echo ""
echo "=== Step 4: Package (signed with Apple Dev cert) ==="
# Uses your Apple Development cert for a permanent code identity.
# No notarization — fine for local development.
npx electron-builder --dir --mac

# Find the .app bundle wherever electron-builder put it
SRC_APP=$(find dist -name "*.app" -maxdepth 3 -type d 2>/dev/null | head -1)

if [ -z "$SRC_APP" ] || [ ! -d "$SRC_APP" ]; then
	echo "ERROR: Could not find built .app bundle."
	exit 1
fi

echo "Found app bundle at: $SRC_APP"

# Show code identity for confirmation
echo ""
echo "--- Code signature ---"
codesign -dvv "$SRC_APP" 2>&1 | grep -E "Authority|Identifier|TeamIdentifier" || echo "(ad-hoc signed)"

echo ""
echo "=== Step 5: Remove old app ==="
if [ -d "$APP_PATH" ]; then
	rm -rf "$APP_PATH"
	echo "Removed old $APP_PATH"
fi

echo ""
echo "=== Step 6: Copy and un-quarantine ==="
cp -R "$SRC_APP" "$APP_PATH"
xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true
echo "Copied $SRC_APP → $APP_PATH"

echo ""
echo "=== Step 7: Clean dist to save space ==="
rm -rf dist/mac-arm64 dist/mac-unpacked 2>/dev/null || true

echo ""
echo "=== Step 8: Launch ==="
open "$APP_PATH"

echo ""
echo "=== Done ==="
echo "Deskreen CE deployed to $APP_PATH"
echo ""
echo "If macOS asks for Screen Recording permission:"
echo "  1. Click 'Open System Settings'"
echo "  2. Enable the toggle for Deskreen CE"
echo "  3. Quit and restart Deskreen CE once"
echo "After granting once, it will NOT ask again (same code identity)."
