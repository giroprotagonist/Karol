#!/bin/bash
# Install the Karol LaunchAgent so the server auto-starts on login/reboot
# Run this once after cloning the repo or changing the plist.

LA_PLIST="$HOME/Library/LaunchAgents/com.karol.api.plist"
SOURCE="/Users/macdonk/Documents/GitHub/Karol/scripts/com.karol.api.plist"

# Copy the plist to the LaunchAgents directory
cp "$SOURCE" "$LA_PLIST"

# Unload any existing instance, then load fresh
launchctl unload "$LA_PLIST" 2>/dev/null
launchctl load "$LA_PLIST"

echo "LaunchAgent installed and loaded."
echo ""
echo "Check status:  launchctl list | grep karol"
echo "Logs:          ~/Documents/GitHub/Karol/.karol/launchagent-*.log"
echo "Server log:    /tmp/karol-server.log"
echo ""
echo "To stop:       launchctl unload ~/Library/LaunchAgents/com.karol.api.plist"
echo "To start:      launchctl load ~/Library/LaunchAgents/com.karol.api.plist"
