#!/usr/bin/env bash
# ── Cloudflare Tunnel Setup for Karol Song Requests ──
# This exposes the Mac's karol-api-server (port 3131) at request.rideyrbike.com
# so that karol.rideyrbike.com visitors can submit song requests.

set -e

TUNNEL_NAME="karol-requests"
CRED_FILE="$HOME/.cloudflared/${TUNNEL_NAME}.json"
CONFIG_FILE="$HOME/.cloudflared/karol-request-tunnel.yml"
PLIST="$HOME/Library/LaunchAgents/com.karol.cloudflared-request.plist"

echo "=== Cloudflare Tunnel Setup for Karol Song Requests ==="
echo

# Step 1: Authenticate (opens browser)
echo "Step 1: Authenticating with Cloudflare..."
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  echo "  A browser window will open — log in to Cloudflare."
  cloudflared tunnel login
  echo "  Authenticated."
else
  echo "  Already authenticated (cert.pem exists)."
fi
echo

# Step 2: Create tunnel (if not exists)
if [ -f "$CRED_FILE" ]; then
  echo "Step 2: Tunnel credentials already exist at $CRED_FILE"
else
  echo "Step 2: Creating tunnel '$TUNNEL_NAME'..."
  cloudflared tunnel create "$TUNNEL_NAME"
  echo "  Tunnel created — credentials saved to $CRED_FILE."
fi
echo

# Step 3: Route DNS
echo "Step 3: Routing DNS for request.rideyrbike.com..."
TUNNEL_ID=$(cloudflared tunnel list --output json 2>/dev/null | python3 -c "import sys,json; tunnels=json.load(sys.stdin); print(next((t['id'] for t in tunnels if t.get('name')=='$TUNNEL_NAME'),''))" 2>/dev/null || echo "")
if [ -n "$TUNNEL_ID" ]; then
  cloudflared tunnel route dns "$TUNNEL_NAME" request.rideyrbike.com
  echo "  DNS routed: request.rideyrbike.com → tunnel $TUNNEL_NAME"
else
  echo "  WARNING: Could not determine tunnel ID. Run: cloudflared tunnel list"
fi
echo

# Step 4: Verify config
echo "Step 4: Verifying config at $CONFIG_FILE..."
if [ -f "$CONFIG_FILE" ]; then
  echo "  Config exists."
else
  echo "  ERROR: Config file not found. Something went wrong."
  exit 1
fi
echo

# Step 5: Load LaunchAgent
echo "Step 5: Loading LaunchAgent..."
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "  LaunchAgent loaded. Tunnel will start automatically on boot."
echo

# Step 6: Test
echo "Step 6: Testing connection..."
sleep 3
curl -s -o /dev/null -w "%{http_code}" "https://request.rideyrbike.com/api/youtube-dj/status" 2>&1 || echo "  (Will work once DNS propagates — can take a few minutes)"
echo

echo "=== Setup complete ==="
echo "  The tunnel runs as a LaunchAgent at:"
echo "    $PLIST"
echo "  Logs: ~/Library/Logs/karol-cloudflared-request.log"
echo "  Public URL: https://request.rideyrbike.com"
echo "  Library page: https://karol.rideyrbike.com"
echo
echo "  Test with: curl https://request.rideyrbike.com/api/youtube-dj/status"
