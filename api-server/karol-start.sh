#!/bin/bash
# Karol server startup wrapper — kills any stale process on port 3131 first

PORT=3131
NODE_BIN=/opt/homebrew/bin/node
SERVER_SCRIPT=/Users/macdonk/Documents/GitHub/deskreen/scripts/karol-api-server.js
LOG_FILE=/tmp/karol-server.log

# Kill existing process on port 3131
lsof -ti :$PORT | xargs kill -9 2>/dev/null
sleep 1

# Start the server
exec $NODE_BIN $SERVER_SCRIPT > $LOG_FILE 2>&1
