#!/usr/bin/env python3
"""
Rebuild tags.json from all .info.json files in the library directory.
"""
import json
import os
import re
from multiprocessing import Pool, cpu_count
from collections import Counter
import sys

LIBRARY_DIR = os.path.expanduser("~/.deskreen/library")
# Override - use the workspace path
LIBRARY_DIR = "/Users/macdonk/Documents/GitHub/deskreen/.deskreen/library"
TAGS_PATH = "/Users/macdonk/Documents/GitHub/deskreen/.deskreen/tags.json"

# ── Known karaoke channels ──────────────────────────────────────────────
KARAOKE_CHANNELS = {
    "KaraFun", "KaraFun Karaoke", "Sing King", "Stingray Karaoke",
    "Zoom Karaoke", "PMK", "CC Karaoke", "Funbox Karaoke",
    "Basement Karaoke", "NOX Karaoke", "WTF Karaoke",
    "Sunfly Karaoke", "King Of Karaoke", "PunkRockMedia",
    "DevastatorKaraoke", "Jet Set Karaoke", "Swiss Army Karaoke",
    "HDKaraoke",
}

# ── Keywords that indicate karaoke in title/uploader/channel ────────────
KARAOKE_KEYWORDS = [
    "karaoke", "karafun", "instrumental", "cc karaoke", "(karaoke)",
    "[karaoke]", "karaoke version", "backing track", "no lead vocal",
    "🎤", "karaokê", "karaoké", "karaokè", "melody",
    "sing along", "without vocals",
]

# ── Artist names to skip (karaoke channels, not real artists) ───────────
SKIP_ARTISTS = KARAOKE_CHANNELS | {
    "Various Artists", "Unknown", "No Artist", "Karaoke", "Instrumental",
    "Karaoke Version", "Karaoke Instrumental",
}


def is_karaoke(title, uploader, channel):
    """Determine if a video is karaoke based on metadata."""
    text_fields = " | ".join([title, uploader, channel]).lower()

    for kw in KARAOKE_KEYWORDS:
        if kw in text_fields:
            return True

    # Check if uploader/channel is a known karaoke channel
    for field in [uploader, channel]:
        if field in KARAOKE_CHANNELS:
            return True

    return False


def extract_year(release_date):
    """Extract year from release_date (could be string or null)."""
    if not release_date:
        return None
    if isinstance(release_date, (int, float)):
        return str(int(release_date))[:4]
    # Try common date patterns
    for pattern in [r'(\d{4})']:
        m = re.search(pattern, str(release_date))
        if m:
            y = m.group(1)
            if 1900 <= int(y) <= 2030:
                return y
    return None


def clean_artist_name(name):
    """Clean up artist names."""
    if not name:
        return None
    name = name.strip()
    # Remove trailing junk
    name = re.sub(r'\s*-\s*Topic$', '', name, flags=re.IGNORECASE).strip()
    name = re.sub(r'\s*VEVO$', '', name, flags=re.IGNORECASE).strip()
    name = re.sub(r'\s*\(Official\)$', '', name, flags=re.IGNORECASE).strip()
    name = re.sub(r'\s*Official$', '', name, flags=re.IGNORECASE).strip()
    name = re.sub(r'\s*\(Official Video\)$', '', name, flags=re.IGNORECASE).strip()
    name = name.strip()
    if not name or name.lower() in {n.lower() for n in SKIP_ARTISTS}:
        return None
    return name


def _has_karaoke_channel_after(text):
    """Check if text starts with a known karaoke channel or keyword."""
    tl = text.lower()
    for ch in KARAOKE_CHANNELS:
        if tl.startswith(ch.lower()):
            return True
    for kw in ["karaoke version", "karaoke instrumental", "cc karaoke", "karaoke", "instrumental"]:
        if tl.startswith(kw):
            return True
    return False


def parse_title_for_song_and_artist(title, uploader=""):
    """Parse title to extract artist and song name. Returns (artist, song)."""
    if not title:
        return None, None

    t = title.strip()

    # Channels known to use "Song - Artist" order (vs "Artist - Song")
    # Only applies when the title format is ambiguous
    song_first_channels = {"MrEntertainerKaraoke"}

    # ── Specific patterns first (most distinctive) ───────────────────

    # Pattern: [Karaoke] Song – Artist 🎤
    m = re.match(r'\s*\[Karaoke\]\s*(.+?)\s*[–—]\s*(.+?)(?:\s*🎤)?\s*$', t)
    if m:
        song = m.group(1).strip()
        artist = clean_artist_name(m.group(2).strip())
        if artist:
            return artist, song

    # Pattern: Artist || Song [Karaoke + Instrumental]
    m = re.match(r'^(.+?)\s*\|\|\s*(.+?)\s*\[', t)
    if m:
        artist = clean_artist_name(m.group(1).strip())
        song = m.group(2).strip()
        if artist:
            return artist, song

    # Pattern: "Artist ✴ Song ✴ extra"
    m = re.match(r'^(.+?)\s*[✴✶✷✸✹✺]\s*(.+?)\s*[✴✶✷✸✹✺]', t)
    if m:
        artist = clean_artist_name(m.group(1).strip())
        song = m.group(2).strip()
        if artist:
            return artist, song

    # Pattern: "Song - Artist | KaraFun" (pipe BEFORE dash hits)
    # Must run before plain dash patterns
    m = re.match(r'^(.+?)\s*[-–—]\s*(.+?)\s*\|\s*', t)
    if m:
        song = m.group(1).strip()
        artist = clean_artist_name(m.group(2).strip())
        if artist:
            return artist, song

    # Pattern: "Artist • Song | Karaoke • Background Vocals • Lyrics"
    m = re.match(r'^(.+?)\s*[•·]\s*(.+?)\s*\|\s*', t)
    if m:
        artist = clean_artist_name(m.group(1).strip())
        song = m.group(2).strip()
        if artist:
            return artist, song

    # Pattern: "Artist • Song (CC ...)"
    m = re.match(r'^(.+?)\s*[•·]\s*(.+?)\s*\(', t)
    if m:
        artist = clean_artist_name(m.group(1).strip())
        song = m.group(2).strip()
        if artist:
            return artist, song

    # Pattern: "🎤 Artist - Song (Karaoke Version) - King Of Karaoke"
    m = re.match(r'^🎤\s*(.+?)\s*[-–—]\s*(.+?)\s*\(', t)
    if m:
        artist = clean_artist_name(m.group(1).strip())
        song = m.group(2).strip()
        if artist:
            return artist, song

    # Pattern: "Artist | Song Name 🎤" or "Song | Guy karaoke"
    m = re.match(r'^(.+?)\s*\|\s*(.+?)(?:\s*🎤)?\s*$', t)
    if m:
        first = m.group(1).strip()
        second = m.group(2).strip()
        # If second part mentions karaoke, first is song — try to extract artist from song part
        if re.search(r'karaoke|karafun', second, re.IGNORECASE):
            # Try "in the style of" extraction
            sm = re.match(r'^(.+?)\s+in\s+the\s+(?:style|Style)\s+of\s+(.+)$', first)
            if sm:
                artist = clean_artist_name(sm.group(2).strip())
                song = sm.group(1).strip()
                if artist:
                    return artist, song
            # Try "Song: Artist" colon pattern
            cm = re.match(r'^([^:]+):\s*(.+)$', first)
            if cm:
                artist = clean_artist_name(cm.group(2).strip())
                song = cm.group(1).strip()
                if artist:
                    return artist, song
            return None, first
        artist = clean_artist_name(first)
        song = second
        if artist:
            return artist, song

    # ── Dash-separated patterns ─────────────────────────────────────

    # Pattern: "Song - Artist Karaoke Group Version" — artist after dash
    m = re.match(r'^(.+?)\s*[-–—]\s*(.+?)\s+Karaoke\s+Group\s+Version\s*$', t, re.IGNORECASE)
    if m:
        song = m.group(1).strip()
        artist = clean_artist_name(m.group(2).strip())
        if artist:
            return artist, song

    # Multi-dash: "Artist - Song - ChannelName" or "Artist - Song - extra"
    # e.g. "Alien Ant Farm - FLESH AND BONE - Basement Karaoke - Inst..."
    # Check for 3+ dash-separated parts where the 3rd+ part is karaoke-related
    parts = re.split(r'\s*[-–—]\s*', t)
    if len(parts) >= 3 and _has_karaoke_channel_after(parts[2]):
        artist = clean_artist_name(parts[0].strip())
        song = parts[1].strip()
        if artist:
            return artist, song

    # "X - Y (something)"  — the most common pattern
    m = re.match(r'^(.+?)\s*[-–—]\s*(.+?)\s*[\(\[\{]', t)
    if m:
        before_dash = m.group(1).strip()
        after_dash_raw = m.group(2).strip()
        rest = t[m.end(2):]  # everything after the second capture group (after-dash content)

        # MrEntertainerKaraoke pattern: "Song - Artist (KARAOKE)" — all-caps only
        # Case-sensitive: only match literally "(KARAOKE)", not "(karaoke)" or "(Karaoke)"
        if re.search(r'\(KARAOKE\)', rest) and uploader in song_first_channels:
            artist = clean_artist_name(after_dash_raw)
            song = before_dash
            if artist:
                return artist, song

        # "Song - Artist (Originally Performed by ...)" — non-standard
        if re.search(r'Originally Performed by', rest, re.IGNORECASE):
            m2 = re.search(r'Originally Performed by\s+(.+?)(?:\)|$)', rest, re.IGNORECASE)
            if m2:
                artist = clean_artist_name(m2.group(1).strip())
                song = before_dash  # the part before dash is the song title
                if artist:
                    return artist, song
            # Fall through

        # Default: "Artist - Song (Karaoke Version)" — artist is before dash
        artist = clean_artist_name(before_dash)
        song = after_dash_raw
        if artist:
            return artist, song

    # Pattern: "GROUP 'Song Name' MV" or "GROUP 'Song Name' Official"
    m = re.match(r"^(.+?)\s*'([^']+)'\s*(?:MV|M/V|Official)", t)
    if m:
        artist = clean_artist_name(m.group(1).strip())
        song = m.group(2).strip()
        if artist:
            return artist, song

    # Pattern: 'Artist "Song Name" (Karaoke)'
    m = re.match(r'^(.+?)\s*"([^"]+)"\s*\(', t)
    if m:
        artist = clean_artist_name(m.group(1).strip())
        song = m.group(2).strip()
        if artist:
            return artist, song

    # Pattern: "X in the Style of Y" / "X in the style of Y" — Y is artist
    # Examples: "Weird Science in the Style of \"Oingo Boingo\" karaoke..."
    #           "Breathe Again in the style of Toni Braxton karaoke video with lyrics"
    m = re.match(r'^(.+?)\s+in\s+the\s+(?:Style|style)\s+of\s+(.+)$', t, re.IGNORECASE)
    if m:
        song = m.group(1).strip()
        rest = m.group(2).strip()
        # Extract artist — either quoted or followed by karaoke/video keywords
        artist = None
        # Quoted: "Artist Name"
        qm = re.match(r'"([^"]+)"', rest)
        if qm:
            artist = clean_artist_name(qm.group(1))
        else:
            # Until karaoke/video keyword or pipe
            am = re.match(r'(.+?)(?:\s*\||\s+(?:karaoke|video|with\s+lyrics))', rest, re.IGNORECASE)
            if am:
                artist = clean_artist_name(am.group(1))
        if artist:
            return artist, song

    # Pattern: "Song: Artist | Karaoke with lyrics"
    m = re.match(r'^([^:]+):\s*(.+?)(?:\s*\|\s*[Kk]araoke|\s*$)', t)
    if m:
        song = m.group(1).strip()
        artist = clean_artist_name(m.group(2).strip())
        if artist:
            return artist, song

    # Pattern: "//" or "///" separator — "Song Name - Artist // ..." (K-pop style)
    m = re.match(r'^(.+?)\s*/{2,}\s*(.+)$', t)
    if m:
        pre_slash = m.group(1).strip()
        post_slash = m.group(2).strip()
        # pre_slash might be "Song - Artist" or "Artist - Song"
        dash_m = re.match(r'^(.+?)\s*[-–—]\s*(.+)$', pre_slash)
        if dash_m:
            part1 = dash_m.group(1).strip()
            part2 = dash_m.group(2).strip()
            # For K-pop: usually "Song - Artist // Karaoke" format
            # Check if post_slash contains karaoke keywords
            if re.search(r'karaoke|lyrics|instrumental|KARAOKE', post_slash, re.IGNORECASE):
                artist = clean_artist_name(part2)
                song = part1
                if artist:
                    return artist, song
            # Otherwise, assume Artist - Song
            artist = clean_artist_name(part1)
            song = part2
            if artist:
                return artist, song
        else:
            artist = clean_artist_name(pre_slash)
            if artist:
                return artist, pre_slash

    # Pattern: "Artist   Song (...)" — multiple spaces, no dash (rare)
    m = re.match(r'^(.+?)\s{3,}(.+?)(?:\s*\(|$)', t)
    if m:
        artist = clean_artist_name(m.group(1).strip())
        song = m.group(2).strip()
        if artist:
            return artist, song

    # Simple dash: "X - Y" with no parens
    m = re.match(r'^(.+?)\s*[-–—]\s*(.+?)\s*$', t)
    if m:
        part1 = m.group(1).strip()
        part2 = m.group(2).strip()
        # Clean part2 of parentheticals for comparison
        part2_clean = re.sub(r'\s*\([^)]*\)', '', part2).strip()
        artist = clean_artist_name(part1)
        song = part2_clean
        if artist:
            return artist, song

    return None, t


def determine_artist(info):
    """Determine artist from info.json fields using priority rules."""
    artist_raw = info.get("artist")
    uploader = info.get("uploader", "")
    channel = info.get("channel", "")
    creator = info.get("creator")
    title = info.get("title", "")

    # 1. artist field from info.json
    if artist_raw:
        cleaned = clean_artist_name(artist_raw)
        if cleaned:
            return cleaned, "artist_field"

    # 2. Parse from title patterns (pass uploader for context)
    title_artist, song = parse_title_for_song_and_artist(title, uploader)
    if title_artist:
        return title_artist, "title_parse"

    # 3. creator field
    if creator:
        cleaned = clean_artist_name(creator)
        if cleaned:
            return cleaned, "creator_field"

    # 4. uploader (cleaned)
    if uploader:
        cleaned = clean_artist_name(uploader)
        if cleaned and cleaned.lower() not in {c.lower() for c in KARAOKE_CHANNELS}:
            return cleaned, "uploader"

    # 5. channel as last resort
    if channel:
        cleaned = clean_artist_name(channel)
        if cleaned and cleaned.lower() not in {c.lower() for c in KARAOKE_CHANNELS}:
            return cleaned, "channel"

    return None, "none"


def extract_song_name(title, artist, uploader=""):
    """Extract clean song name from title after removing artist."""
    if not title:
        return None
    # Try parsing again specifically for song
    _, song = parse_title_for_song_and_artist(title, uploader)
    if song:
        # Clean up karaoke annotations from song name
        song = re.sub(r'\s*\(karaoke[^)]*\)', '', song, flags=re.IGNORECASE)
        song = re.sub(r'\s*\[karaoke[^\]]*\]', '', song, flags=re.IGNORECASE)
        song = re.sub(r'\s*\(CC\s*Karaoke[^)]*\)', '', song, flags=re.IGNORECASE)
        song = re.sub(r'\s*\(Instrumental[^)]*\)', '', song, flags=re.IGNORECASE)
        song = re.sub(r'\s*\(Official[^)]*\)', '', song, flags=re.IGNORECASE)
        song = re.sub(r'\s*\[Official[^\]]*\]', '', song, flags=re.IGNORECASE)
        song = re.sub(r'\s*\|\s*KaraFun.*$', '', song, flags=re.IGNORECASE)
        song = re.sub(r'\s*\|\s*.*Karaoke.*$', '', song, flags=re.IGNORECASE)
        song = re.sub(r'\s*🎤.*$', '', song)
        song = song.strip().strip('"').strip("'").strip()
        if song:
            return song
    return None


def process_file(filepath):
    """Process a single .info.json file and return (video_id, entry_dict)."""
    try:
        with open(filepath, "r") as f:
            info = json.load(f)
    except (json.JSONDecodeError, IOError):
        return None

    # Extract video ID from filename
    basename = os.path.basename(filepath)
    video_id = basename.replace(".info.json", "")

    title = info.get("title", "")
    uploader = info.get("uploader", "")
    channel = info.get("channel", "")
    duration = info.get("duration")

    # Determine type
    tag = "karaoke" if is_karaoke(title, uploader, channel) else "song"

    # Determine artist
    artist, source = determine_artist(info)

    # Extract year
    year = extract_year(info.get("release_date"))

    # Extract song name
    song = extract_song_name(title, artist, uploader)

    return video_id, {
        "tag": tag,
        "year": year,
        "artist": artist,
        "source": source,
        "song": song,
        "title": title,
    }


def main():
    # Find all .info.json files
    files = []
    for fname in sorted(os.listdir(LIBRARY_DIR)):
        if fname.endswith(".info.json"):
            files.append(os.path.join(LIBRARY_DIR, fname))

    # Also check the nested directory
    nested_lib = os.path.join(LIBRARY_DIR, ".deskreen", "library")
    if os.path.isdir(nested_lib):
        for fname in sorted(os.listdir(nested_lib)):
            if fname.endswith(".info.json"):
                files.append(os.path.join(nested_lib, fname))

    total_files = len(files)
    print(f"Found {total_files} .info.json files to process...")

    # Process using multiprocessing
    num_workers = min(cpu_count(), 8)
    print(f"Using {num_workers} worker processes...")

    results = {}
    with Pool(num_workers) as pool:
        for i, result in enumerate(pool.imap_unordered(process_file, files, chunksize=50)):
            if result:
                vid, entry = result
                results[vid] = entry
            if (i + 1) % 500 == 0:
                print(f"  Processed {i + 1}/{total_files} files...")

    print(f"\nProcessed {len(results)} entries.")

    # ── Statistics ──────────────────────────────────────────────────────
    karaoke_count = sum(1 for v in results.values() if v["tag"] == "karaoke")
    song_count = sum(1 for v in results.values() if v["tag"] == "song")
    with_artist = sum(1 for v in results.values() if v.get("artist"))
    without_artist = len(results) - with_artist

    print(f"\n=== Results ===")
    print(f"Total entries:   {len(results)}")
    print(f"Karaoke count:   {karaoke_count}")
    print(f"Song count:      {song_count}")
    print(f"With artist:     {with_artist}")
    print(f"Missing artist:  {without_artist}")

    # Source breakdown
    source_counts = Counter(v["source"] for v in results.values())
    print(f"\nSource breakdown:")
    for src, cnt in source_counts.most_common():
        print(f"  {src}: {cnt}")

    # ── Examples ────────────────────────────────────────────────────────
    print(f"\n=== Karaoke examples (first 5) ===")
    for vid, entry in list(results.items()):
        if entry["tag"] == "karaoke":
            print(f"  {vid}: artist={entry.get('artist')}, song={entry.get('song')}, title={entry.get('title','')[:80]}")
            if len([k for k in results if results[k]["tag"] == "karaoke"][:5]) == 5:
                break

    print(f"\n=== Song examples (first 5) ===")
    for vid, entry in list(results.items()):
        if entry["tag"] == "song":
            print(f"  {vid}: artist={entry.get('artist')}, song={entry.get('song')}, title={entry.get('title','')[:80]}")
            if len([k for k in results if results[k]["tag"] == "song"][:5]) == 5:
                break

    # ── Write output ────────────────────────────────────────────────────
    with open(TAGS_PATH, "w") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print(f"\nWritten {len(results)} entries to {TAGS_PATH}")


if __name__ == "__main__":
    main()
