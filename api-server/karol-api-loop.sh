#!/bin/bash
# Karol API Server launcher — auto-restarts on crash
cd /Users/macdonk/Documents/GitHub/Karol
while true; do
  echo "[$(date)] Starting karol-api-server..."
  node scripts/karol-api-server.js 2>&1
  echo "[$(date)] Server exited (code $?). Restarting in 5s..."
  sleep 5
done