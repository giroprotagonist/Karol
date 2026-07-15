#!/usr/bin/env python3
"""
Fix years on 281 karaoke tracks from the alt_songs 1994-2002 campaign.

Uses Wikipedia API with strict page title validation to ensure we
only accept years from the correct song page, not from artist or album pages.
"""

import json
import csv
import os
import re
import shutil
import time
import urllib.parse

import requests

BASE = os.path.dirname(os.path.abspath(__file__))
TAGS_FILE = os.path.join(BASE, 'tags.json')
CSV_FILE = os.path.join(BASE, 'alt_songs_1994_2002.csv')
LIBRARY_DIR = os.path.join(BASE, 'library')
CACHE_FILE = os.path.join(BASE, '.fix_campaign_years_cache.json')

STOPWORDS = {
    'a', 'an', 'the', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or',
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its',
    'with', 'from', 'by', 'as', 'but', 'not', 'no', 'so', 'if', 'than',
    'that', 'this', 'these', 'those', 'i', 'me', 'my', 'we', 'our', 'you',
    'your', 'he', 'she', 'him', 'her', 'they', 'them', 'their',
    'feat', 'featuring', 'ft', 'cc',
}


def load_cache():
    if os.path.exists(CACHE_FILE):
        with open(CACHE_FILE) as f:
            return json.load(f)
    return {}


def save_cache(cache):
    with open(CACHE_FILE, 'w') as f:
        json.dump(cache, f, indent=2, sort_keys=True)


def get_title(vid):
    info_path = os.path.join(LIBRARY_DIR, f'{vid}.info.json')
    if not os.path.exists(info_path):
        return None
    try:
        with open(info_path) as f:
            data = json.load(f)
        return data.get('title', '') or ''
    except Exception:
        return None


def parse_song_title(title, artist):
    """Extract song title from a karaoke video title."""
    t = title.strip()

    # Try to remove artist prefix with various separators
    artist_lower = artist.strip().lower()

    # Common separators for karaoke titles: "Artist - Song" or "Artist • Song"
    for sep in [' • ', ' - ', ' – ', ' — ', ' : ', ' | ', ' ~ ', ' · ']:
        if sep in t:
            parts = t.split(sep)
            first = parts[0].strip().lower()
            # Check if first part matches artist name
            if artist_lower in first or first in artist_lower:
                t = sep.join(parts[1:]).strip()
                break

    # Also try regex-based removal for cases without clear separators
    artist_pattern = re.escape(artist.strip())
    t = re.sub(rf'^{artist_pattern}\s*[•\-–—:|\~·]\s*', '', t, flags=re.IGNORECASE).strip()

    # Fallback: if the result still starts with the artist name as whole words,
    # strip it (handles cases like "Linkin Park Waiting For The End")
    if t.lower().startswith(artist_lower) and len(t) > len(artist):
        remainder = t[len(artist):].strip()
        if remainder:
            t = remainder

    # Strip karaoke markers without removing content
    t = re.sub(r'\s*\(.*?(?:karaoke|instrumental|cover|lyrics|version|live|studio|funbox).*?\)', ' ', t, flags=re.IGNORECASE)
    t = re.sub(r'\s*\[.*?(?:karaoke|instrumental|cover|lyrics|version|live|UVR).*?\]', ' ', t, flags=re.IGNORECASE)
    t = re.sub(r'\s*\|\s*KaraFun\s*', ' ', t, flags=re.IGNORECASE)
    t = re.sub(r'\s*\|\s*karaoke\b.*$', '', t, flags=re.IGNORECASE)
    t = re.sub(r'\s*Karaoke\b.*$', '', t, flags=re.IGNORECASE)
    t = re.sub(r'\s*\|\s*PMK\s*', ' ', t, flags=re.IGNORECASE)
    t = re.sub(r'\s*-\s*NOX\s*', ' ', t, flags=re.IGNORECASE)
    t = re.sub(r'\s*-\s*PMK\s*', ' ', t, flags=re.IGNORECASE)
    t = re.sub(r'\s*\[UVR\]\s*', ' ', t, flags=re.IGNORECASE)
    t = re.sub(r'\s*🎤.*$', '', t)
    t = re.sub(r'\s*\[OBSOLETED\]\s*', ' ', t, flags=re.IGNORECASE)
    t = re.sub(r'\s*【.*$', '', t)
    t = re.sub(r'\s*\(CC\)\s*', ' ', t)
    t = re.sub(r'\s*Instrumental\s*-\s*PMK\s*$', '', t, flags=re.IGNORECASE)
    t = re.sub(r'\s*Instrumental\s*-\s*PMK\s*', ' ', t, flags=re.IGNORECASE)
    t = re.sub(r'\s*NOX\s+Karaoke\s*$', '', t, flags=re.IGNORECASE)
    t = re.sub(r'\s*with\s+Lyrics\s+On\s+Screen\s*$', '', t, flags=re.IGNORECASE)
    t = re.sub(r'\s*\(by\s+request\)\s*', ' ', t, flags=re.IGNORECASE)
    t = re.sub(r'\s+Instrumental\s*$', '', t, flags=re.IGNORECASE)
    t = re.sub(r'\s+live\s*$', '', t, flags=re.IGNORECASE)

    # Clean up
    t = re.sub(r'\s+', ' ', t).strip()
    t = t.strip('"\'•|-–—:# ')
    return t


def significant_words(s):
    """Extract non-stopword words from a string."""
    return set(w.lower().strip('.,;:!?()[]{}"\'-') for w in s.split()
               if w.lower() not in STOPWORDS and len(w.strip('.,;:!?()[]{}"\'-')) > 1)


def page_matches_song(page_title, song_title):
    """
    Check if a Wikipedia page title likely refers to the song we're looking for.
    Requires significant word overlap and/or the song title is contained in page.
    """
    song_words = significant_words(song_title)
    page_words = significant_words(page_title)

    if not song_words:
        return False

    overlap = song_words & page_words
    # At least 50% of song's significant words must appear in page title
    ratio = len(overlap) / len(song_words)
    if ratio >= 0.5:
        return True

    # Also check if the full song title is a substring of the page title (case-insensitive)
    if song_title.lower() in page_title.lower():
        return True

    return False


def search_wikipedia(artist, song_title):
    """Search Wikipedia. Returns list of (title, is_song_page) tuples."""
    # Try multiple search queries
    queries = [
        f'"{song_title}" {artist} song',
        f"{artist} {song_title}",
        f'"{song_title}" song',
    ]

    seen = set()
    results = []

    for query in queries:
        url = "https://en.wikipedia.org/w/api.php"
        params = {
            "action": "query",
            "list": "search",
            "srsearch": query,
            "format": "json",
            "srlimit": 5,
        }
        try:
            r = requests.get(
                url, params=params,
                headers={"User-Agent": "DeskreenFixYears/2.0 (https://github.com/deskreen)"},
                timeout=10,
            )
            r.raise_for_status()
            data = r.json()
            for item in data.get("query", {}).get("search", []):
                title = item["title"]
                if title not in seen:
                    seen.add(title)
                    is_match = page_matches_song(title, song_title)
                    results.append((title, is_match))
        except Exception:
            pass

    # Sort: matching pages first, then others
    results.sort(key=lambda x: (0 if x[1] else 1, x[0]))
    return results


def get_page_summary(page_title):
    """Get Wikipedia page summary."""
    encoded = urllib.parse.quote(page_title.replace(" ", "_"))
    summary_url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{encoded}"
    try:
        r = requests.get(
            summary_url,
            headers={"User-Agent": "DeskreenFixYears/2.0 (https://github.com/deskreen)"},
            timeout=10,
        )
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return None


MUSIC_DESCRIPTORS = {'song', 'single', 'album', 'track', 'recording', 'EP', 'LP',
                     'hit', 'ballad', 'anthem', 'instrumental', 'composition'}


def description_mentions_artist(desc, artist):
    """Check if Wikipedia description mentions the artist."""
    if not desc or not artist:
        return False
    desc_lower = desc.lower()
    artist_lower = artist.lower()

    # Check if the full artist name appears
    if artist_lower in desc_lower:
        return True

    # Check without "the" prefix (e.g., "Chemical Brothers" vs "The Chemical Brothers")
    if artist_lower.startswith('the '):
        if artist_lower[4:] in desc_lower:
            return True
    else:
        # Check with "the" added (e.g., description says "the White Stripes")
        if f'the {artist_lower}' in desc_lower:
            return True

    # Check first word of multi-word artist names
    artist_parts = artist_lower.split()
    if len(artist_parts) > 1 and artist_parts[-1] in desc_lower:
        return True

    return False


def description_is_music(desc):
    """Check if description is about music."""
    desc_lower = desc.lower()
    return any(d in desc_lower for d in MUSIC_DESCRIPTORS)


def extract_year_from_description(desc, artist=None):
    """Extract year from Wikipedia description. Requires artist match if provided."""
    if not desc:
        return None

    # If artist is provided, require the description to mention the artist
    if artist and not description_mentions_artist(desc, artist):
        return None

    # Require a music-related description
    if not description_is_music(desc):
        return None

    m = re.search(r'\b(19\d{2}|20[0-2]\d)\b', desc)
    if m:
        year = int(m.group(1))
        if 1950 <= year <= 2026:
            return year
    return None


def extract_year_from_extract(extract, artist=None):
    """Extract year from page extract with specific patterns. Requires artist nearby."""
    if not extract:
        return None

    # "released in 1995", "published in 1995", etc.
    patterns = [
        r'(?:released|published|issued|debuted)\s+(?:in\s+|on\s+)?(19\d{2}|20[0-2]\d)',
        r'(?:single|album|track)\s+(?:released|published)\s+(?:in\s+)?(19\d{2}|20[0-2]\d)',
        r'was\s+released\s+(?:in\s+)?(19\d{2}|20[0-2]\d)',
    ]
    for pat in patterns:
        for m in re.finditer(pat, extract, re.IGNORECASE):
            year = int(m.group(1))
            if not (1950 <= year <= 2026):
                continue
            # If artist provided, check artist appears within 200 chars of the match
            if artist:
                start = max(0, m.start() - 200)
                end = min(len(extract), m.end() + 200)
                context = extract[start:end].lower()
                artist_lower = artist.lower()
                if artist_lower in context:
                    return year
                # Handle "The" prefix differences
                if artist_lower.startswith('the ') and artist_lower[4:] in context:
                    return year
                if f'the {artist_lower}' in context:
                    return year
                # Check last word for multi-word artist names (more distinctive)
                artist_parts = artist_lower.split()
                if len(artist_parts) > 1 and artist_parts[-1] in context:
                    if any(p in context for p in artist_parts[:-1]):
                        return year
            else:
                return year

    return None


def lookup_song_year(artist, song_title):
    """Look up song release year via Wikipedia. Returns (year, source_label)."""

    results = search_wikipedia(artist, song_title)
    if not results:
        return None, "no_search_results"

    # First pass: only look at pages that match the song title
    for page_title, is_match in results:
        if not is_match:
            continue

        summary = get_page_summary(page_title)
        if not summary:
            continue

        desc = summary.get("description", "")

        # Try description first (most reliable) — requires artist match
        year = extract_year_from_description(desc, artist=artist)
        if year:
            return year, f"desc:{page_title}"

        # Then try specific patterns from extract — requires artist nearby
        year = extract_year_from_extract(summary.get("extract", ""), artist=artist)
        if year:
            return year, f"extract:{page_title}"

    # Second pass: try matching pages without artist requirement as fallback
    # (only for descriptions that look like music)
    for page_title, is_match in results:
        if not is_match:
            continue

        summary = get_page_summary(page_title)
        if not summary:
            continue

        desc = summary.get("description", "")
        year = extract_year_from_description(desc, artist=None)
        if year:
            return year, f"desc-fb:{page_title}"

    # Third pass: try non-matching pages that clearly mention the artist
    for page_title, is_match in results:
        if is_match:
            continue

        summary = get_page_summary(page_title)
        if not summary:
            continue

        desc = summary.get("description", "")
        year = extract_year_from_description(desc, artist=artist)
        if year:
            return year, f"desc-nm:{page_title}"

    return None, "no_year_found"


def get_targets():
    csv_vids = set()
    csv_artists = set()
    with open(CSV_FILE) as f:
        for row in csv.DictReader(f):
            vid = row.get('Karaoke Video ID', '').strip()
            if vid:
                csv_vids.add(vid)
            artist = row.get('Artist', '').strip().lower()
            if artist:
                csv_artists.add(artist)

    with open(TAGS_FILE) as f:
        tags = json.load(f)

    targets = []
    for vid, t in tags.items():
        t_year = str(t.get('year', ''))
        artist = (t.get('artist', '') or '').lower()
        is_karaoke = t.get('tag') == 'karaoke'
        if is_karaoke and vid not in csv_vids and t_year in ('2024', '2025', '2026') and artist in csv_artists:
            targets.append({
                'vid': vid,
                'artist': t.get('artist', ''),
                'current_year': t.get('year', ''),
            })

    return targets


def main():
    print("=" * 60)
    print("fix_campaign_years.py — Fix karaoke track years (v2)")
    print("=" * 60)

    # 1. Get targets
    print("\n[1/5] Identifying targets...")
    targets = get_targets()
    print(f"  Found {len(targets)} tracks to fix")

    if not targets:
        print("  Nothing to fix. Exiting.")
        return

    # 2. Backup tags.json
    print("\n[2/5] Backing up tags.json...")
    bak_path = TAGS_FILE + '.bak.2022'
    if not os.path.exists(bak_path):
        shutil.copy2(TAGS_FILE, bak_path)
        print(f"  Created backup: {bak_path}")
    else:
        print(f"  Backup already exists: {bak_path} (skipping)")

    # 3. Load cache
    print("\n[3/5] Loading cache...")
    cache = load_cache()
    print(f"  Cache has {len(cache)} entries")

    # 4. Look up years
    print("\n[4/5] Looking up song release years via Wikipedia...")
    fixed = 0
    not_found = 0
    skipped_cache = 0
    results = {}

    for i, t in enumerate(targets):
        vid = t['vid']
        artist = t['artist']
        prefix = f"  [{i+1}/{len(targets)}]"

        # Get video title
        title = get_title(vid)
        if not title:
            not_found += 1
            continue

        # Parse song title
        song_title = parse_song_title(title, artist)
        if not song_title or len(song_title) < 2:
            print(f"{prefix} {vid}: {artist} — couldn't parse title from '{title[:60]}...'")
            not_found += 1
            continue

        # Check cache
        cache_key = f"{artist.lower()}|{song_title.lower()}"
        if cache_key in cache:
            cached = cache[cache_key]
            if isinstance(cached, int):
                results[vid] = (cached, f"cache")
                skipped_cache += 1
                continue
            else:
                not_found += 1
                continue

        # Look up
        year, source = lookup_song_year(artist, song_title)
        if year:
            results[vid] = (year, source)
            cache[cache_key] = year
            fixed += 1
            print(f"{prefix} {artist} — \"{song_title[:50]}\" → {year}")
        else:
            cache[cache_key] = "not_found"
            not_found += 1
            print(f"{prefix} {artist} — \"{song_title[:50]}\" → NOT FOUND")

        # Rate limit
        time.sleep(0.35)

    # Save cache
    save_cache(cache)
    print(f"\n  Cache saved: {len(cache)} entries")

    # 5. Update tags.json
    print(f"\n[5/5] Updating tags.json ({len(results)} tracks)...")
    with open(TAGS_FILE) as f:
        tags = json.load(f)

    updated = 0
    for vid, (year, source) in results.items():
        if vid in tags:
            tags[vid]['year'] = str(year)
            tags[vid]['source'] = 'wikipedia'
            updated += 1

    with open(TAGS_FILE, 'w') as f:
        json.dump(tags, f, indent=2)

    print(f"  Updated {updated} tracks in tags.json")

    # Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"  Total targets:           {len(targets)}")
    print(f"  Fixed (Wikipedia):       {fixed}")
    print(f"  Fixed (from cache):      {skipped_cache}")
    print(f"  Total fixed:             {fixed + skipped_cache}")
    print(f"  Not found / skipped:     {not_found}")
    print(f"  Backup:                  {bak_path}")


if __name__ == '__main__':
    main()
