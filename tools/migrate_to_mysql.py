#!/usr/bin/env python3
"""
Migrate .deskreen/tags.json → MySQL library_tags via PHP proxy.
Also migrate .deskreen/youtube-download-archive.txt → download_archive.
Run: python3 .deskreen/migrate_to_mysql.py
"""
import json, requests, sys

PROXY = "https://karol.rideyrbike.com/db.php"
HEADERS = {
    "X-Karol-Auth": "kar0l_my5ql_pr0xy_2026",
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
}
BATCH = 100

def proxy_get(table, action, params=None):
    p = params or {}
    p["table"] = table
    p["action"] = action
    r = requests.get(PROXY, headers=HEADERS, params=p, timeout=30)
    return r.json()

def proxy_post(table, action, data):
    r = requests.post(PROXY, headers=HEADERS, params={"table": table, "action": action}, json=data, timeout=30)
    return r.json()

# ── 1. Migrate tags.json ──
print("Loading tags.json...")
with open(".deskreen/tags.json") as f:
    tags = json.load(f)

entries = []
for video_id, meta in tags.items():
    if isinstance(meta, dict):
        entries.append({
            "video_id": video_id,
            "tag": meta.get("tag", "song"),
            "artist": meta.get("artist", ""),
            "year": meta.get("year", 0),
            "source": meta.get("source", ""),
        })
    elif isinstance(meta, str):
        entries.append({"video_id": video_id, "tag": meta, "artist": "", "year": 0, "source": ""})

print(f"Migrating {len(entries)} tags in batches of {BATCH}...")
ok = 0
errs = 0
for i in range(0, len(entries), BATCH):
    batch = entries[i:i+BATCH]
    for e in batch:
        try:
            resp = proxy_post("library_tags", "set", e)
            if resp.get("ok"):
                ok += 1
            else:
                errs += 1
                if errs <= 3:
                    print(f"  Error: {resp.get('error')} for {e['video_id']}")
        except Exception as ex:
            errs += 1
            if errs <= 3:
                print(f"  Exception: {ex} for {e['video_id']}")
    sys.stdout.write(f"\r  {ok + errs}/{len(entries)} ({ok} ok, {errs} errors)")
    sys.stdout.flush()

print(f"\nTags migration complete: {ok} ok, {errs} errors")

# ── 2. Verify ──
resp = proxy_get("library_tags", "count_by_tag")
if resp.get("ok"):
    print(f"\nTag counts: {resp.get('counts', {})}")

# ── 3. Migrate download archive ──
print("\nLoading youtube-download-archive.txt...")
with open(".deskreen/youtube-download-archive.txt") as f:
    lines = f.readlines()

video_ids = []
for line in lines:
    line = line.strip()
    if line.startswith("youtube "):
        vid = line.split("youtube ")[1].strip()
        if vid:
            video_ids.append(vid)

print(f"Migrating {len(video_ids)} download archive entries...")
ok_dl = 0
errs_dl = 0
for i in range(0, len(video_ids), BATCH):
    batch = video_ids[i:i+BATCH]
    for vid in batch:
        try:
            resp = proxy_post("download_archive", "add", {"video_id": vid})
            if resp.get("ok"):
                ok_dl += 1
            else:
                errs_dl += 1
        except Exception as ex:
            errs_dl += 1
    sys.stdout.write(f"\r  {ok_dl + errs_dl}/{len(video_ids)} ({ok_dl} ok, {errs_dl} errors)")
    sys.stdout.flush()

print(f"\nDownload archive migration complete: {ok_dl} ok, {errs_dl} errors")

# ── 4. Verify download count ──
resp = proxy_get("download_archive", "count")
if resp.get("ok"):
    print(f"Download archive count: {resp.get('count')}")

print("\n✓ Migration complete!")
