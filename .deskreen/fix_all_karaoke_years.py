#!/usr/bin/env python3
"""
Fix years on karaoke tracks with year 2024-2026 in tags.json.

Targets ALL karaoke-tagged tracks with suspiciously recent years,
using Wikipedia API to find correct release years for classic songs.

Uses cached results from previous runs of fix_campaign_years.py.
"""

import json
import os
import re
import shutil
import time
import urllib.parse

import requests

BASE = os.path.dirname(os.path.abspath(__file__))
TAGS_FILE = os.path.join(BASE, 'tags.json')
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
    artist_lower = artist.strip().lower()

    # Common separators for karaoke titles: "Artist - Song" or "Artist • Song"
    for sep in [' • ', ' - ', ' – ', ' — ', ' : ', ' | ', ' ~ ', ' · ']:
        if sep in t:
            parts = t.split(sep)
            first = parts[0].strip().lower()
            if artist_lower in first or first in artist_lower:
                t = sep.join(parts[1:]).strip()
                break

    # Also try regex-based removal for cases without clear separators
    artist_pattern = re.escape(artist.strip())
    t = re.sub(rf'^{artist_pattern}\s*[•\-–—:|\~·]\s*', '', t, flags=re.IGNORECASE).strip()

    # Fallback: if the result still starts with the artist name as whole words
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
    return set(w.lower().strip(".,;:!?()[]{}\"'-") for w in s.split()
               if w.lower() not in STOPWORDS and len(w.strip(".,;:!?()[]{}\"'-")) > 1)


def page_matches_song(page_title, song_title):
    song_words = significant_words(song_title)
    page_words = significant_words(page_title)
    if not song_words:
        return False
    overlap = song_words & page_words
    ratio = len(overlap) / len(song_words)
    if ratio >= 0.5:
        return True
    if song_title.lower() in page_title.lower():
        return True
    return False


def search_wikipedia(artist, song_title):
    """Search Wikipedia. Returns list of (title, is_song_page) tuples."""
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
                headers={"User-Agent": "DeskreenFixYears/3.0 (https://github.com/deskreen)"},
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
    results.sort(key=lambda x: (0 if x[1] else 1, x[0]))
    return results


def get_page_summary(page_title):
    encoded = urllib.parse.quote(page_title.replace(" ", "_"))
    summary_url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{encoded}"
    try:
        r = requests.get(
            summary_url,
            headers={"User-Agent": "DeskreenFixYears/3.0 (https://github.com/deskreen)"},
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
    if not desc or not artist:
        return False
    desc_lower = desc.lower()
    artist_lower = artist.lower()
    if artist_lower in desc_lower:
        return True
    if artist_lower.startswith('the '):
        if artist_lower[4:] in desc_lower:
            return True
    else:
        if f'the {artist_lower}' in desc_lower:
            return True
    artist_parts = artist_lower.split()
    if len(artist_parts) > 1 and artist_parts[-1] in desc_lower:
        return True
    return False


def description_is_music(desc):
    desc_lower = desc.lower()
    return any(d in desc_lower for d in MUSIC_DESCRIPTORS)


def extract_year_from_description(desc, artist=None):
    if not desc:
        return None
    if artist and not description_mentions_artist(desc, artist):
        return None
    if not description_is_music(desc):
        return None
    m = re.search(r'\b(19\d{2}|20[0-2]\d)\b', desc)
    if m:
        year = int(m.group(1))
        if 1950 <= year <= 2026:
            return year
    return None


def extract_year_from_extract(extract, artist=None):
    if not extract:
        return None
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
            if artist:
                start = max(0, m.start() - 200)
                end = min(len(extract), m.end() + 200)
                context = extract[start:end].lower()
                artist_lower = artist.lower()
                if artist_lower in context:
                    return year
                if artist_lower.startswith('the ') and artist_lower[4:] in context:
                    return year
                if f'the {artist_lower}' in context:
                    return year
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

    # First pass: matching pages with artist
    for page_title, is_match in results:
        if not is_match:
            continue
        summary = get_page_summary(page_title)
        if not summary:
            continue
        desc = summary.get("description", "")
        year = extract_year_from_description(desc, artist=artist)
        if year:
            return year, f"desc:{page_title}"
        year = extract_year_from_extract(summary.get("extract", ""), artist=artist)
        if year:
            return year, f"extract:{page_title}"

    # Second pass: matching pages without artist
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

    # Third pass: non-matching pages with artist
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
    """Get ALL karaoke tracks with year in 2024-2026."""
    with open(TAGS_FILE) as f:
        tags = json.load(f)

    targets = []
    for vid, t in tags.items():
        if t.get('tag') != 'karaoke':
            continue
        year_str = str(t.get('year', ''))
        if year_str not in ('2024', '2025', '2026'):
            continue
        targets.append({
            'vid': vid,
            'artist': t.get('artist', ''),
            'current_year': year_str,
        })

    return targets


def main():
    print("=" * 60)
    print("fix_all_karaoke_years.py — Fix ALL karaoke track years")
    print("=" * 60)

    # 1. Get targets
    print("\n[1/5] Identifying targets...")
    targets = get_targets()
    print(f"  Found {len(targets)} tracks to fix (year 2024-2026)")

    if not targets:
        print("  Nothing to fix. Exiting.")
        return

    # 2. Backup tags.json
    print("\n[2/5] Backing up tags.json...")
    bak3_path = TAGS_FILE + '.bak3'
    if os.path.exists(bak3_path):
        print(f"  Backup already exists: {bak3_path} (skipping)")
    else:
        shutil.copy2(TAGS_FILE, bak3_path)
        print(f"  Created backup: {bak3_path}")

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
    skipped_no_title = 0
    skipped_no_parse = 0

    for i, t in enumerate(targets):
        vid = t['vid']
        artist = t['artist']
        current_year = int(t['current_year'])
        prefix = f"  [{i+1}/{len(targets)}]"

        # Get video title
        title = get_title(vid)
        if not title:
            not_found += 1
            skipped_no_title += 1
            if (i + 1) % 50 == 0:
                print(f"{prefix} Progress: {i+1}/{len(targets)} (fixed: {fixed}, cached: {skipped_cache}, not found: {not_found})")
            continue

        # Parse song title
        song_title = parse_song_title(title, artist)
        if not song_title or len(song_title) < 2:
            not_found += 1
            skipped_no_parse += 1
            if (i + 1) % 50 == 0:
                print(f"{prefix} Progress: {i+1}/{len(targets)} (fixed: {fixed}, cached: {skipped_cache}, not found: {not_found})")
            continue

        # Check cache
        cache_key = f"{artist.lower()}|{song_title.lower()}"
        if cache_key in cache:
            cached = cache[cache_key]
            if isinstance(cached, int):
                if cached != current_year:
                    results[vid] = (cached, "cache")
                    skipped_cache += 1
                else:
                    # Cache says same year = no fix needed
                    not_found += 1
                if (i + 1) % 50 == 0:
                    print(f"{prefix} Progress: {i+1}/{len(targets)} (fixed: {fixed}, cached: {skipped_cache}, not found: {not_found})")
                continue
            else:
                not_found += 1
                if (i + 1) % 50 == 0:
                    print(f"{prefix} Progress: {i+1}/{len(targets)} (fixed: {fixed}, cached: {skipped_cache}, not found: {not_found})")
                continue

        # Look up
        year, source = lookup_song_year(artist, song_title)
        if year:
            if year != current_year:
                results[vid] = (year, source)
                cache[cache_key] = year
                fixed += 1
                print(f"{prefix} {artist} — \"{song_title[:50]}\" {current_year} → {year}  [{source}]")
            else:
                # Wikipedia agrees with current year — keep it
                cache[cache_key] = year
                not_found += 1
        else:
            cache[cache_key] = "not_found"
            not_found += 1
            if (i + 1) % 20 == 0:
                print(f"{prefix} {artist} — \"{song_title[:50]}\" → NOT FOUND")

        # Rate limit
        time.sleep(0.35)

        # Progress update every 50
        if (i + 1) % 50 == 0:
            print(f"{prefix} Progress: {i+1}/{len(targets)} (fixed: {fixed}, cached: {skipped_cache}, not found: {not_found})")
            save_cache(cache)

    # Save cache
    print(f"\n  Saving cache ({len(cache)} entries)...")
    save_cache(cache)

    # 5. Update tags.json
    print(f"\n[5/5] Updating tags.json ({len(results)} tracks to fix)...")
    with open(TAGS_FILE) as f:
        tags = json.load(f)

    updated = 0
    for vid, (year, source) in results.items():
        if vid in tags:
            old_year = tags[vid].get('year', '')
            tags[vid]['year'] = str(year)
            tags[vid]['source'] = 'wikipedia'
            print(f"  Updated: {vid} ({tags[vid].get('artist','')}) {old_year} → {year}")
            updated += 1

    with open(TAGS_FILE, 'w') as f:
        json.dump(tags, f, indent=2)

    # Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"  Total targets:           {len(targets)}")
    print(f"  Fixed (Wikipedia):       {fixed}")
    print(f"  Fixed (from cache):      {skipped_cache}")
    print(f"  Total fixed:             {fixed + skipped_cache}")
    print(f"  Not found / no change:   {not_found}")
    print(f"  No .info.json:           {skipped_no_title}")
    print(f"  Could not parse title:   {skipped_no_parse}")
    print(f"  Backup:                  {bak3_path}")
    print(f"  Cache:                   {CACHE_FILE} ({len(cache)} entries)")


if __name__ == '__main__':
    main()
