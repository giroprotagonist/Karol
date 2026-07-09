#!/usr/bin/env bash
# Export YouTube cookies from Mac Deskreen CE Electron partition for tablet restore.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/.deskreen/youtube-session.json}"

find_cookies_db() {
	local candidates=()
	local app_names=(
		"deskreen-ce"
		"Deskreen CE"
		"deskreen"
		"Karol"
	)
	for app in "${app_names[@]}"; do
		local base="$HOME/Library/Application Support/$app"
		[[ -d "$base" ]] || continue
		# Prefer dedicated YouTube partition
		if [[ -f "$base/Partitions/deskreen-youtube/Cookies" ]]; then
			echo "$base/Partitions/deskreen-youtube/Cookies"
			return 0
		fi
		if [[ -f "$base/Partitions/persist:deskreen-youtube/Cookies" ]]; then
			echo "$base/Partitions/persist:deskreen-youtube/Cookies"
			return 0
		fi
		while IFS= read -r db; do
			[[ -f "$db" ]] && candidates+=("$db")
		done < <(find "$base" -name Cookies -type f 2>/dev/null)
	done
	if [[ ${#candidates[@]} -gt 0 ]]; then
		# Prefer partition whose path mentions youtube
		for db in "${candidates[@]}"; do
			if [[ "$db" == *youtube* ]]; then
				echo "$db"
				return 0
			fi
		done
		echo "${candidates[0]}"
		return 0
	fi
	return 1
}

COOKIES_DB="$(find_cookies_db || true)"
if [[ -z "$COOKIES_DB" ]]; then
	echo "Could not find Electron Cookies DB." >&2
	echo "Sign in to YouTube in Deskreen CE on this Mac first, then retry." >&2
	echo "Looked under ~/Library/Application Support/{deskreen-ce,Deskreen CE,deskreen}/Partitions/" >&2
	exit 1
fi

echo "Reading cookies from: $COOKIES_DB"
mkdir -p "$(dirname "$OUT")"

python3 << PY
import json, sqlite3, sys, time

db = """$COOKIES_DB"""
out = """$OUT"""

AUTH_NAMES = {
    "SAPISID", "SID", "__Secure-1PSID", "__Secure-3PSID",
    "LOGIN_INFO", "HSID", "SSID", "APISID",
    "__Secure-1PAPISID", "__Secure-3PAPISID",
    "__Secure-1PSIDTS", "__Secure-3PSIDTS", "SIDCC",
    "__Secure-1PSIDCC", "__Secure-3PSIDCC",
    # Additional cookies that YouTube uses for Premium/session integrity
    "PREF", "VISITOR_INFO1_LIVE", "VISITOR_PRIVACY_METADATA",
    "__Secure-YNID", "__Secure-ROLLOUT_TOKEN",
    # Account linking
    "LSID", "ACCOUNT_CHOOSER", "SMSV",
    "__Host-1PLSID", "__Host-3PLSID", "__Host-GAPS",
    "NID",
}

def urls_for_host(host: str):
    h = host.lstrip(".")
    if "youtube" in h:
        return ["https://www.youtube.com", "https://youtube.com"]
    if h in ("google.com", "accounts.google.com"):
        return [f"https://{h}", f"https://www.{h}" if not h.startswith("www.") else f"https://{h}"]
    return [f"https://{h}"]

conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
cur = conn.cursor()
try:
    rows = cur.execute(
        "SELECT host_key, name, value, encrypted_value FROM cookies"
    ).fetchall()
except sqlite3.OperationalError:
    rows = cur.execute(
        "SELECT host_key, name, value FROM cookies"
    ).fetchall()

by_url = {}
for row in rows:
    host, name = row[0], row[1]
    value = row[2] if len(row) > 2 else ""
    if name not in AUTH_NAMES:
        continue
    if not value:
        continue
    for url in urls_for_host(host):
        by_url.setdefault(url, []).append(f"{name}={value}")

entries = [{"url": url, "value": ";".join(parts)} for url, parts in by_url.items() if parts]

if not entries:
    print("No YouTube/Google auth cookies found — sign in to YouTube in Deskreen CE first.", file=sys.stderr)
    sys.exit(1)

payload = {
    "version": 1,
    "exportedAt": int(time.time() * 1000),
    "cookies": entries,
}
with open(out, "w") as f:
    json.dump(payload, f, indent=2)

yt_login = any("LOGIN_INFO=" in e["value"] for e in entries if "youtube" in e["url"])
print(f"Wrote {len(entries)} cookie entries → {out}")
print(f"youtubeLoginInfo: {yt_login}")
if not yt_login:
    print("WARNING: LOGIN_INFO missing — sign in to YouTube in Deskreen CE and re-export.", file=sys.stderr)
    sys.exit(2)
PY

echo ""
echo "Restore to tablet (run from repo root):"
echo "  cd $ROOT"
echo "  DESKREEN_HOST=192.168.68.50 npm run player:restore-youtube-session"
