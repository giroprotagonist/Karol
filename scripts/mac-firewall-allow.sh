#!/usr/bin/env bash
set -euo pipefail

BUNDLE_PATH="/Applications/Deskreen CE.app"
SOCKETFILTER="/usr/libexec/ApplicationFirewall/socketfilterfw"

echo "Opening macOS firewall for Deskreen CE..."

if ! command -v "$SOCKETFILTER" &>/dev/null; then
	echo "socketfilterfw not found - cannot configure firewall."
	exit 1
fi

if [ ! -d "$BUNDLE_PATH" ]; then
	echo "$BUNDLE_PATH not found - is Deskreen CE installed?"
	exit 1
fi

echo "  Adding $BUNDLE_PATH to firewall allowed list..."
sudo "$SOCKETFILTER" --add "$BUNDLE_PATH" 2>/dev/null || true

echo "  Unblocking incoming connections..."
sudo "$SOCKETFILTER" --unblockapp "$BUNDLE_PATH" 2>/dev/null || true

echo "  Enabling firewall (if off)..."
sudo "$SOCKETFILTER" --setglobalstate on 2>/dev/null || true

echo "Done. Deskreen CE should now accept incoming LAN connections."
echo ""
echo "Verify from another device:"
echo "  curl http://\$(ipconfig getifaddr en0 2>/dev/null):3131/api/vlc-dj/health"
