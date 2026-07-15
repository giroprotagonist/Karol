#!/usr/bin/env python3
"""
Fix incorrect year data in tags.json for the alt_songs_1994_2002.csv campaign.

Problem: All 542 downloaded tracks have YouTube upload_date as the year
instead of the song's actual release year. The CSV has the correct years.

This script:
1. Reads CSV → builds video_id → {year, artist} map
2. Reads tags.json
3. Fixes year + artist for all CSV tracks found in tags.json
4. Writes updated tags.json back
"""

import json
import csv
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CSV_PATH = os.path.join(SCRIPT_DIR, "alt_songs_1994_2002.csv")
TAGS_PATH = os.path.join(SCRIPT_DIR, "tags.json")
BACKUP_PATH = os.path.join(SCRIPT_DIR, "tags.json.bak")


def main():
    # 1. Read CSV and build lookup map (keep first occurrence on duplicates)
    csv_map = {}  # video_id → {year, artist, song}
    duplicates = []
    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            vid = row.get("Karaoke Video ID", "").strip()
            if vid:
                entry = {
                    "year": row["Year"].strip(),
                    "artist": row["Artist"].strip(),
                    "song": row["Song"].strip(),
                }
                if vid in csv_map:
                    duplicates.append((vid, csv_map[vid], entry))
                else:
                    csv_map[vid] = entry

    print(f"CSV entries with video IDs: {len(csv_map)}")
    if duplicates:
        print(f"WARNING: {len(duplicates)} duplicate video ID(s) in CSV (using first occurrence):")
        for vid, first, second in duplicates:
            print(f"  {vid}: kept '{first['artist']} - {first['song']} ({first['year']})'")
            print(f"        skipped '{second['artist']} - {second['song']} ({second['year']})'")

    # 2. Read current tags.json
    with open(TAGS_PATH, encoding="utf-8") as f:
        tags = json.load(f)

    print(f"Total tracks in tags.json: {len(tags)}")

    # 3. Create backup
    with open(BACKUP_PATH, "w", encoding="utf-8") as f:
        json.dump(tags, f, indent=2, ensure_ascii=False)
    print(f"Backup saved to {BACKUP_PATH}")

    # 4. Fix years and artists for CSV tracks
    fixed_years = 0
    fixed_artists = 0

    for vid, csv_data in csv_map.items():
        if vid not in tags:
            continue

        entry = tags[vid]
        old_year = entry.get("year")
        new_year = csv_data["year"]

        # Fix year
        if str(old_year) != new_year:
            entry["year"] = new_year
            fixed_years += 1

        # Fix artist if tags.json artist doesn't match CSV (or is clearly wrong)
        old_artist = entry.get("artist", "")
        csv_artist = csv_data["artist"]
        if old_artist.lower().strip() != csv_artist.lower().strip():
            entry["artist"] = csv_artist
            fixed_artists += 1

    # 5. Write updated tags.json
    with open(TAGS_PATH, "w", encoding="utf-8") as f:
        json.dump(tags, f, indent=2, ensure_ascii=False)

    print(f"\nDone. Fixed {fixed_years} years, {fixed_artists} artists.")
    print(f"Updated tags.json written.")

    # Summary
    csv_vids_found = sum(1 for vid in csv_map if vid in tags)
    csv_vids_missing = sum(1 for vid in csv_map if vid not in tags)
    if csv_vids_missing:
        print(f"\nWARNING: {csv_vids_missing} CSV video IDs not found in tags.json")


if __name__ == "__main__":
    main()
