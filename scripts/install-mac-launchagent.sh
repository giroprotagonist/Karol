#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Deskreen CE GUI ──
DESKREEN_PLIST="$HOME/Library/LaunchAgents/com.deskreen-ce.plist"
APP_PATH="/Applications/Deskreen CE.app"

mkdir -p "$HOME/Library/LaunchAgents"

if [ -d "$APP_PATH" ]; then
	cat > "$DESKREEN_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.deskreen-ce</string>
	<key>ProgramArguments</key>
	<array>
		<string>/usr/bin/open</string>
		<string>-gj</string>
		<string>${APP_PATH}</string>
	</array>
	<key>KeepAlive</key>
	<true/>
	<key>RunAtLoad</key>
	<true/>
	<key>StandardOutPath</key>
	<string>/tmp/deskreen-ce.out</string>
	<key>StandardErrorPath</key>
	<string>/tmp/deskreen-ce.err</string>
</dict>
</plist>
PLIST
	launchctl bootout gui/$(id -u) "$DESKREEN_PLIST" 2>/dev/null || true
	launchctl bootstrap gui/$(id -u) "$DESKREEN_PLIST" 2>/dev/null || launchctl load "$DESKREEN_PLIST" 2>/dev/null
	echo "Deskreen CE LaunchAgent installed."
else
	echo "Skipping Deskreen CE (app not found at $APP_PATH)."
fi

# ── Karol API Server ──
KAROL_PLIST="$HOME/Library/LaunchAgents/com.karol-api.plist"
KAROL_SRC="$SCRIPT_DIR/com.karol-api.plist"

if [ -f "$KAROL_SRC" ]; then
	cp "$KAROL_SRC" "$KAROL_PLIST"
	launchctl bootout gui/$(id -u) "$KAROL_PLIST" 2>/dev/null || true
	launchctl bootstrap gui/$(id -u) "$KAROL_PLIST" 2>/dev/null || launchctl load "$KAROL_PLIST" 2>/dev/null
	echo "Karol API LaunchAgent installed and loaded."
else
	echo "WARNING: $KAROL_SRC not found. Run from the repo root."
fi

echo ""
echo "Both LaunchAgents installed. Verify:"
echo "  tail -f /tmp/karol-api.err"
echo "  curl http://127.0.0.1:3131/api/ableton/health"
