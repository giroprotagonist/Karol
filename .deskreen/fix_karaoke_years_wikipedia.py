#!/usr/bin/env python3
"""
Fix incorrect years on karaoke tracks by looking up release years via Wikipedia API.

Identifies karaoke tracks with years >= 2020 (YouTube upload dates, not release years)
and uses the Wikipedia API to find the correct release year.

Also checks 2012-2019 tracks which are likely wrong for pre-2010s artists.

Usage:
    python3 fix_karaoke_years_wikipedia.py          # Fix years >= 2020
    python3 fix_karaoke_years_wikipedia.py --all     # Fix years >= 2012
    python3 fix_karaoke_years_wikipedia.py --dry-run # Show what would change
"""

import json
import os
import re
import sys
import time
import urllib.parse
from collections import Counter

import requests

# --- Configuration ---
TAGS_PATH = os.path.join(os.path.dirname(__file__), "tags.json")
LIBRARY_DIR = os.path.join(os.path.dirname(__file__), "library")
CACHE_PATH = os.path.join(os.path.dirname(__file__), "fix_karaoke_years_cache.json")
BACKUP_PATH = os.path.join(os.path.dirname(__file__), "tags.json.bak")

MIN_YEAR_TO_FIX = 2020  # Default: fix years >= 2020
REQUEST_DELAY = 1.0  # Seconds between Wikipedia API calls
MAX_RETRIES = 2
USER_AGENT = "KarolDJ/1.0 (https://github.com; deskreen@example.com)"

# Common karaoke suffixes/prefixes to strip from titles
KARAOKE_CLEANUP_PATTERNS = [
    r'\s*\(Karaoke\s*Version\)',
    r'\s*\(Karaoke\)',
    r'\s*\[Karaoke\]',
    r'\s*\[CC\]',
    r'\s*\[Instrumental\s*(?:Lyrics)?\]',
    r'\s*\|\s*Karaoke\s*Version',
    r'\s*\|\s*KaraFun',
    r'\s*-\s*Karaoke\s*Version(?:\s*from\s*.*)?$',
    r'\s*-\s*Karaoke$',
    r'\s*\(Official\s*(?:Music\s*)?Video\)',
    r'\s*\(Official\s*(?:Lyric\s*)?Video\)',
    r'\s*\(Lyrics?\)',
    r'\s*\[Official\s*(?:Music\s*)?Video\]',
    r'\s*\[Lyrics?\]',
]


def load_json(path):
    with open(path) as f:
        return json.load(f)


def save_json(path, data):
    with open(path, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def wikipedia_search(artist, song):
    """Search Wikipedia for a song article. Returns list of search results."""
    query = f"{artist} {song}"
    url = "https://en.wikipedia.org/w/api.php"
    params = {
        "action": "query",
        "list": "search",
        "srsearch": query,
        "format": "json",
        "srlimit": 5,
    }
    for attempt in range(MAX_RETRIES + 1):
        try:
            r = requests.get(
                url, params=params, headers={"User-Agent": USER_AGENT}, timeout=20
            )
            if r.status_code == 200:
                return r.json().get("query", {}).get("search", [])
            elif r.status_code == 429:
                wait = 5 * (attempt + 1)
                print(f"    Rate limited (429), waiting {wait}s...")
                time.sleep(wait)
                continue
            else:
                if attempt < MAX_RETRIES:
                    time.sleep(2)
        except Exception as e:
            if attempt < MAX_RETRIES:
                print(f"    Search error: {e}, retrying...")
                time.sleep(2)
            else:
                print(f"    Search failed: {e}")
    return []


def get_page_summary(title):
    """Get Wikipedia page summary via REST API."""
    encoded = urllib.parse.quote(title.replace(" ", "_"))
    url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{encoded}"
    for attempt in range(MAX_RETRIES + 1):
        try:
            r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=20)
            if r.status_code == 200:
                return r.json()
            elif r.status_code == 429:
                wait = 5 * (attempt + 1)
                print(f"    Rate limited (429), waiting {wait}s...")
                time.sleep(wait)
                continue
            elif r.status_code == 404:
                return None
            else:
                if attempt < MAX_RETRIES:
                    time.sleep(2)
        except Exception as e:
            if attempt < MAX_RETRIES:
                time.sleep(2)
    return None


def get_page_html(title):
    """Get Wikipedia page parsed HTML (infobox) via action=parse API."""
    url = "https://en.wikipedia.org/w/api.php"
    params = {
        "action": "parse",
        "page": title,
        "prop": "text",
        "section": 0,
        "format": "json",
    }
    for attempt in range(MAX_RETRIES + 1):
        try:
            r = requests.get(
                url, params=params, headers={"User-Agent": USER_AGENT}, timeout=20
            )
            if r.status_code == 200:
                data = r.json()
                return data.get("parse", {}).get("text", {}).get("*", "")
            elif r.status_code == 429:
                wait = 5 * (attempt + 1)
                print(f"    Rate limited (429), waiting {wait}s...")
                time.sleep(wait)
                continue
            else:
                if attempt < MAX_RETRIES:
                    time.sleep(2)
        except Exception as e:
            if attempt < MAX_RETRIES:
                time.sleep(2)
    return None


def extract_year_from_summary(summary):
    """Extract release year from Wikipedia page summary."""
    description = summary.get("description", "")
    extract_text = summary.get("extract", "")

    # 1. Check description field first (most reliable: "1995 single by Green Day")
    match = re.search(r"\b(19\d{2}|20[0-2]\d)\b", description)
    if match:
        return int(match.group(1))

    # 2. Check extract for release patterns
    match = re.search(
        r"(?:released|published)\s+(?:in\s+)?(19\d{2}|20[0-2]\d)",
        extract_text,
        re.IGNORECASE,
    )
    if match:
        return int(match.group(1))

    # 3. Find year patterns near "single" or "song" in extract
    match = re.search(
        r"(?:was|is)\s+(?:a|an|the)\s+.*?(?:single|song).*?(19\d{2}|20[0-2]\d)",
        extract_text,
        re.IGNORECASE,
    )
    if match:
        return int(match.group(1))

    # 4. Last resort: first 19xx year in extract
    match = re.search(r"\b(19\d{2})\b", extract_text)
    if match:
        return int(match.group(1))

    return None


def extract_year_from_infobox(html):
    """Extract release year from Wikipedia infobox HTML."""
    if not html:
        return None

    # Pattern: <th ...>Released</th><td ...>Month DD, YYYY</td>
    released_match = re.search(
        r"Released</th>\s*<td[^>]*>(.*?)</td>", html, re.IGNORECASE | re.DOTALL
    )
    if released_match:
        text = re.sub(r"<[^>]+>", "", released_match.group(1))
        text = re.sub(r"&nbsp;", " ", text)
        text = re.sub(r"&#?\w+;", " ", text)
        yr = re.search(r"\b(19\d{2}|20[0-2]\d)\b", text)
        if yr:
            return int(yr.group(1))

    # Look for B-side field (also has release info)
    bside_match = re.search(
        r'(?:B-side|B-side)</th>\s*<td[^>]*>(.*?)</td>',
        html,
        re.IGNORECASE | re.DOTALL,
    )
    if bside_match:
        text = re.sub(r"<[^>]+>", "", bside_match.group(1))
        yr = re.search(r"\b(19\d{2}|20[0-2]\d)\b", text)
        if yr:
            return int(yr.group(1))

    return None


def clean_song_title(info_title, artist):
    """Extract clean song title from info.json title, given the known artist."""
    title = info_title.strip()

    # Remove common karaoke suffixes
    for pattern in KARAOKE_CLEANUP_PATTERNS:
        title = re.sub(pattern, "", title, flags=re.IGNORECASE)

    # Remove common separators and extra whitespace
    title = title.strip().strip("-•|")

    # If title starts with artist name and a separator, remove that prefix
    # e.g., "Coldplay - Adventure Of A Lifetime" -> "Adventure Of A Lifetime"
    escaped_artist = re.escape(artist)
    sep_pattern = r"^" + escaped_artist + r"\s*[-•|]\s*"
    match = re.match(sep_pattern, title, re.IGNORECASE)
    if match:
        title = title[match.end() :].strip()

    # Also try artist name anywhere with separators around it
    # e.g., "Shoulder to the Wheel - Saves the Day" where artist=Saves the Day
    # In this case the title format is SONG - ARTIST, so we need the reverse
    # Look for " - ARTIST" at the end
    trailing_artist = re.search(
        r"\s*[-•|]\s*" + escaped_artist + r"\s*$", title, re.IGNORECASE
    )
    if trailing_artist:
        title = title[: trailing_artist.start()].strip()

    title = title.strip().strip("-•|/").strip()

    return title


def lookup_song_year(artist, song, cache):
    """Look up the release year for a song using Wikipedia."""
    cache_key = f"{artist.lower().strip()}|||{song.lower().strip()}"

    if cache_key in cache:
        return cache[cache_key]

    # Search Wikipedia
    results = wikipedia_search(artist, song)
    time.sleep(REQUEST_DELAY)

    if not results:
        cache[cache_key] = None
        return None

    # Try each search result until we find a year
    for result in results:
        page_title = result.get("title", "")
        snippet = result.get("snippet", "").lower()

        # Skip album articles (unless the song name is in an album title)
        if "(album)" in page_title.lower() and "song" not in snippet:
            continue

        # Skip disambiguation pages
        if "may refer to" in snippet or "(disambiguation)" in page_title.lower():
            continue

        # Try page summary first (faster)
        summary = get_page_summary(page_title)
        time.sleep(REQUEST_DELAY)

        if summary:
            year = extract_year_from_summary(summary)
            if year and 1900 <= year <= 2026:
                cache[cache_key] = year
                return year

        # Fall back to full HTML infobox parse
        html = get_page_html(page_title)
        time.sleep(REQUEST_DELAY)

        if html:
            year = extract_year_from_infobox(html)
            if year and 1900 <= year <= 2026:
                cache[cache_key] = year
                return year

    # No year found
    cache[cache_key] = None
    return None


def main():
    start_time = time.time()
    dry_run = "--dry-run" in sys.argv
    fix_all = "--all" in sys.argv
    min_year = 2012 if fix_all else MIN_YEAR_TO_FIX

    print(f"Fixing karaoke years (min year: {min_year}, dry run: {dry_run})")
    print(f"Tags: {TAGS_PATH}")
    print(f"Library: {LIBRARY_DIR}")

    # Load tags
    print("\nLoading tags.json...")
    tags = load_json(TAGS_PATH)
    print(f"Total tracks: {len(tags)}")

    # Filter karaoke tracks with year >= min_year
    to_fix = {}
    for vid, data in tags.items():
        if data.get("tag") != "karaoke":
            continue
        year_str = data.get("year", "")
        if not year_str.isdigit():
            continue
        year = int(year_str)
        if year >= min_year:
            to_fix[vid] = data

    print(f"Tracks to fix (year >= {min_year}): {len(to_fix)}")

    if not to_fix:
        print("No tracks to fix!")
        return

    # Load or create cache
    cache = {}
    if os.path.exists(CACHE_PATH):
        print(f"Loading cache from {CACHE_PATH}...")
        cache = load_json(CACHE_PATH)
        print(f"Cache entries: {len(cache)}")

    # Read info.json for each track and extract artist/song
    print("\nReading info.json files...")
    tracks_to_lookup = []
    missing_info = 0

    for vid, data in to_fix.items():
        artist = data.get("artist", "")
        if not artist:
            missing_info += 1
            continue

        info_path = os.path.join(LIBRARY_DIR, f"{vid}.info.json")
        if not os.path.exists(info_path):
            missing_info += 1
            continue

        try:
            info = load_json(info_path)
        except (json.JSONDecodeError, Exception):
            missing_info += 1
            continue

        info_title = info.get("title", "")
        if not info_title:
            missing_info += 1
            continue

        song = clean_song_title(info_title, artist)
        if not song:
            missing_info += 1
            continue

        tracks_to_lookup.append((vid, artist, song, data))

    print(f"Tracks ready for lookup: {len(tracks_to_lookup)}")
    print(f"Skipped (missing artist/title): {missing_info}")

    # Look up years via Wikipedia
    print("\n--- Looking up years via Wikipedia ---")
    print(f"Rate limit: {REQUEST_DELAY}s delay between API calls")
    print(f"Estimated time: ~{len(tracks_to_lookup) * 2.5 * REQUEST_DELAY / 60:.1f} minutes")
    print()

    changes = []
    not_found = []
    found = 0
    total = len(tracks_to_lookup)

    try:
        for i, (vid, artist, song, data) in enumerate(tracks_to_lookup):
            current_year = int(data.get("year", 0))

            # Estimate ETA
            if i > 0 and i % 10 == 0:
                elapsed = time.time() - start_time
                eta = (elapsed / i) * (total - i)
                print(f"  Progress: {i}/{total} ({(i/total)*100:.1f}%) | "
                      f"Found: {found} | Not found: {len(not_found)} | "
                      f"ETA: {eta/60:.1f} min")

            year = lookup_song_year(artist, song, cache)

            if year and year != current_year:
                changes.append((vid, artist, song, current_year, year))
                found += 1
            elif year is None:
                not_found.append((vid, artist, song))
            else:
                # Year found but matches current year - no change needed
                found += 1

            # Save cache periodically (every 50 tracks)
            if i > 0 and i % 50 == 0:
                save_json(CACHE_PATH, cache)
                print(f"    Cache saved ({len(cache)} entries)")

    except KeyboardInterrupt:
        print("\n\nInterrupted! Saving progress...")
        save_json(CACHE_PATH, cache)
        print(f"Cache saved to {CACHE_PATH}")

        # Still show partial results
        if changes:
            print(f"\nChanges found so far ({len(changes)}):")
            for vid, artist, song, old, new in sorted(changes, key=lambda x: x[0]):
                print(f"  {artist} - {song}: {old} -> {new}")
        print(f"\nSkipped (not found): {len(not_found)}")
        return

    # Save final cache
    save_json(CACHE_PATH, cache)
    print(f"\nCache saved ({len(cache)} entries)")

    print(f"\n--- Results ---")
    print(f"Total looked up: {total}")
    print(f"Years found: {found}")
    print(f"Not found: {len(not_found)}")
    print(f"Changes to make: {len(changes)}")

    if changes:
        print(f"\nExample changes:")
        for vid, artist, song, old, new in sorted(changes, key=lambda x: x[0])[:20]:
            print(f"  {artist} - {song}: {old} -> {new}")
        if len(changes) > 20:
            print(f"  ... and {len(changes) - 20} more")

    if dry_run:
        print("\nDRY RUN - no changes written.")
        return

    if not changes:
        print("\nNo changes to make.")
        return

    # Backup original tags.json
    if not os.path.exists(BACKUP_PATH):
        print(f"\nCreating backup: {BACKUP_PATH}")
        save_json(BACKUP_PATH, tags)
    else:
        print(f"\nBackup already exists: {BACKUP_PATH} (not overwriting)")

    # Apply changes
    print(f"Applying {len(changes)} changes to tags.json...")
    for vid, artist, song, old_year, new_year in changes:
        tags[vid]["year"] = str(new_year)

    save_json(TAGS_PATH, tags)
    print(f"Tags.json updated!")

    # Print not found for manual review
    if not_found:
        not_found_path = os.path.join(
            os.path.dirname(__file__), "fix_karaoke_years_not_found.json"
        )
        not_found_data = [
            {"vid": vid, "artist": artist, "song": song}
            for vid, artist, song in not_found
        ]
        save_json(not_found_path, not_found_data)
        print(f"\n{len(not_found)} tracks not found - saved to {not_found_path}")
        print("These may need manual review.")

    elapsed = time.time() - start_time
    print(f"\nTotal time: {elapsed/60:.1f} minutes")


if __name__ == "__main__":
    main()
