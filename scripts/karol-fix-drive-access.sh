#!/bin/bash
# Fix / verify Karol access to /Volumes/maxone (Removable Volumes TCC).
set -euo pipefail

DRIVE="${KAROL_EXTERNAL_DRIVE:-/Volumes/maxone}"
echo "═══ Karol ↔ maxone access ═══"
echo ""

if [[ ! -d "$DRIVE" ]]; then
  echo "✗ $DRIVE not mounted — plug in the drive"
  exit 1
fi

DRIVE_DEV=$(stat -f '%d' "$DRIVE")
VOL_DEV=$(stat -f '%d' /Volumes)
if [[ "$DRIVE_DEV" == "$VOL_DEV" ]]; then
  echo "✗ Ghost folder at $DRIVE — delete it and remount:"
  echo "    rm -rf /Volumes/maxone && diskutil mountDisk diskN"
  exit 1
fi

if ! ls "$DRIVE/Deskreen" >/dev/null 2>&1; then
  echo "✗ Terminal cannot read Deskreen either"
  exit 1
fi
echo "✓ Drive mounted: $DRIVE"

if [[ -f /tmp/karol-library-cache.json ]]; then
  COUNT=$(python3 -c "import json;print(json.load(open('/tmp/karol-library-cache.json')).get('count',0))")
  echo "✓ Library cache: $COUNT videos"
else
  echo "! No library cache yet"
fi

echo ""
echo "Opening System Settings → Removable Volumes…"
echo "  → Find Karol and turn it ON"
echo "  → Then in Karol click Rescan"
echo ""
open "x-apple.systempreferences:com.apple.preference.security?Privacy_RemovableVolumes" 2>/dev/null || true

# Soft-reset so macOS may re-prompt next access
tccutil reset SystemPolicyRemovableVolumes com.karol.dj 2>/dev/null || true

if ! pgrep -x Karol >/dev/null; then
  open -a /Applications/Karol.app
  echo "Launched Karol"
else
  echo "Karol is running — click Rescan after enabling Removable Volumes"
fi
