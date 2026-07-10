#!/usr/bin/env bash
set -euo pipefail

PLIST_PATH="$HOME/Library/LaunchAgents/com.deskreen-ce.plist"
APP_PATH="/Applications/Deskreen CE.app"

if [ ! -d "$APP_PATH" ]; then
	echo "ERROR: $APP_PATH not found. Install Deskreen CE first."
	exit 1
fi

mkdir -p "$(dirname "$PLIST_PATH")"

cat > "$PLIST_PATH" <<PLIST
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

launchctl bootout gui/$(id -u) "$PLIST_PATH" 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$PLIST_PATH" 2>/dev/null || launchctl load "$PLIST_PATH" 2>/dev/null
echo "LaunchAgent installed and loaded (open -gj = launch hidden, no focus)."
echo "Deskreen runs in the background. Click the dock icon to show the window."
