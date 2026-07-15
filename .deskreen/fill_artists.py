#!/usr/bin/env python3
"""
Fill blank artist fields in tags.json using info.json metadata and title parsing.
"""
import json
import os
import re

LIBRARY_DIR = os.path.dirname(os.path.abspath(__file__))
LIBRARY_SUBDIR = os.path.join(LIBRARY_DIR, "library")
TAGS_PATH = os.path.join(LIBRARY_DIR, "tags.json")

NOISE_UPLOADERS = {
    "karafun", "sing king", "stingray karaoke", "zoom karaoke", "pmk",
    "cc karaoke", "funbox karaoke", "basement karaoke", "nox karaoke",
    "wtf karaoke", "sunfly karaoke",
}

NON_ARTIST_PATTERNS = [
    r'\blabels?\b', r'\brecords?\b', r'\bchannel\b',
    r'\bstudio\b', r'\bmusic\s*:', r'\bradio\b',
    r'\bproduction\b', r'\bentertainment\b', r'\bnetwork\b',
    r'\btonight\s+show\b',
    r'^jawed$',
]


def is_noise(s):
    lower = s.lower().strip()
    if lower in NOISE_UPLOADERS:
        return True
    for pat in NON_ARTIST_PATTERNS:
        if re.search(pat, lower):
            return True
    for n in NOISE_UPLOADERS:
        if n in lower:
            return True
    return False


def looks_like_artist(name):
    if not name or len(name) < 2 or len(name) > 60:
        return False
    if re.match(r'^https?://', name):
        return False
    if name.islower() and ' ' not in name:
        return False
    return True


def strip_parens(s):
    return re.sub(r'\s*\([^)]*\)\s*$', '', s).strip()


def first_artist(value):
    if not value:
        return ""
    for p in value.split(','):
        p = p.strip()
        if p and not is_noise(p):
            return p
    return value.split(',')[0].strip() if value else ""


def extract_artist_from_title(title):
    t = title.strip()

    # ── Karaoke patterns ──
    m = re.match(r'^(.+?)\s*[-–—]\s*[^|]+?\s*\|\s*Karaoke\s+Version', t, re.I)
    if m and looks_like_artist(m.group(1).strip()):
        return m.group(1).strip()

    m = re.match(r'^(.+?)\s*[-–—]\s*.+?\(Karaoke', t, re.I)
    if m and looks_like_artist(m.group(1).strip()):
        return m.group(1).strip()

    m = re.match(r'^(.+?)\s*[•·]\s*.+?\(.*Karaoke', t, re.I)
    if m and looks_like_artist(m.group(1).strip()):
        return m.group(1).strip()

    m = re.match(r'^(.+?)\s*\|\s*.+?Karaoke', t, re.I)
    if m and looks_like_artist(m.group(1).strip()):
        return m.group(1).strip()

    m = re.search(r'\s*[-–—]\s*(.+?)\s*\(.*Karaoke', t, re.I)
    if m and looks_like_artist(m.group(1).strip()):
        return m.group(1).strip()

    # ── Colon patterns ──
    m = re.match(r'\[Official\s*MV\]\s*(.+?)\s*:\s*(.+?)(?:\s*\|.*)?$', t, re.I)
    if m and looks_like_artist(m.group(2).strip()):
        return m.group(2).strip()

    m = re.match(r'^([^:]+?)\s*:\s*.+?\s*\[Official\s*(?:MV|Visuali)', t, re.I)
    if m and looks_like_artist(m.group(1).strip()):
        return m.group(1).strip()

    m = re.match(r'\[MV\]\s+([A-Za-z0-9\s&]+?)(?:\s*\([^)]+\))?\s*_\s*', t)
    if m and looks_like_artist(m.group(1).strip()):
        return m.group(1).strip()

    # ── Pipe patterns ──
    m = re.match(r'^(.+?)\s*\|\s*(.+?)\s*\(Official\s+(?:Music\s+)?Video\)', t, re.I)
    if m and looks_like_artist(m.group(1).strip()):
        return m.group(1).strip()

    # General pipe: "Artist | Song" — left shorter => left is artist
    m = re.match(r'^(.+?)\s*\|\s*(.+?)$', t)
    if m:
        left = m.group(1).strip()
        right = m.group(2).strip()
        if len(left) > 2 and len(left) <= len(right) and looks_like_artist(left):
            return left

    # ── Slash pattern ──
    m = re.match(r'^(.+?)\s*/\s*(.+)$', t)
    if m:
        left = m.group(1).strip()
        right = m.group(2).strip()
        if re.match(r'^[A-Za-z]$', right[:1]) and len(right.split()) == 1:
            pass  # Skip M/V etc.
        else:
            words = left.split()
            if 1 <= len(words) <= 3 and looks_like_artist(left):
                if not (len(words) == 1 and words[0].islower()):
                    return left

    # ── Multiple spaces ──
    m = re.match(r'^(.+?)\s{2,}(.+)$', t)
    if m:
        artist = m.group(1).strip()
        if looks_like_artist(artist) and len(artist) < 50:
            return artist

    # ── Chinese 《》 ──
    m = re.match(r'^(.+?)[《](.+?)[》]\s*(?:Official\s*)?Music\s*Video', t)
    if m and looks_like_artist(m.group(1).strip()):
        return m.group(1).strip()

    # ── Parenthetical artist at end: "Song Name (ARTIST)" ──
    m = re.match(r'^(.+?)\s*\(([^)]+)\)$', t)
    if m:
        inside = m.group(2).strip()
        noise_re = re.compile(
            r'(?ix)(official|karaoke|remix|version|music\s*video|mv|live|'
            r'performance|cover|instrumental|audio|visualizer|'
            r'prod\.?\s*by|directed|feat\.?)'
        )
        if not noise_re.search(inside):
            if looks_like_artist(inside) and len(inside.split()) <= 4:
                return inside

    # ── OFFICIAL M/V at end ──
    m = re.match(r'^(.+?)\s+OFFICIAL\s+M/\s*V$', t, re.I)
    if m:
        before = m.group(1).strip()
        words = before.split()
        artist_words = []
        for w in words:
            if re.match(r'^[A-Z0-9&]+$', w):
                artist_words.append(w)
            else:
                break
        if artist_words and 1 <= len(artist_words) <= 2:
            artist = ' '.join(artist_words)
            if looks_like_artist(artist):
                return artist

    return None


def extract_feat_from_title(title):
    m = re.search(
        r'(?:Feat\.|Ft\.|ft\.|feat\.)\s*([^,|()]+?)(?:\s*$|\s*MV|\s*\)|\s*\||\s*\[)',
        title, re.I
    )
    if m:
        feat = m.group(1).strip().rstrip(')').strip()
        if feat and len(feat) > 1 and not is_noise(feat):
            return feat
    return None


def clean_uploader_as_artist(uploader):
    up = uploader.strip()
    if not up or is_noise(up):
        return None

    for suffix in [' - Topic', ' Official', ' Official YouTube Channel', 'VEVO', 'vevo']:
        if up.lower().endswith(suffix.lower()):
            up = up[:-(len(suffix))].strip()
            break

    up = re.sub(r'\s*\([^)]*\)\s*$', '', up).strip()

    if not up or len(up) < 2:
        return None

    lower = up.lower()
    if any(w in lower for w in ['records', 'label', 'studio', 'radio',
                                 'production', 'channel', 'live', 'network']):
        return None
    if ' : ' in up:
        return None
    if len(up) > 50:
        return None

    return up


def main():
    with open(TAGS_PATH) as f:
        tags = json.load(f)

    total = len(tags)
    blank_before = sum(1 for v in tags.values() if not v.get('artist', '').strip())
    print(f"Total entries: {total}")
    print(f"Entries with artist filled (before): {total - blank_before}")
    print(f"Entries with blank artist: {blank_before}")
    print()

    filled = 0
    examples = []

    for key, entry in tags.items():
        if entry.get('artist', '').strip():
            continue

        info_path = os.path.join(LIBRARY_SUBDIR, f"{key}.info.json")
        if not os.path.exists(info_path):
            continue

        with open(info_path) as f:
            info = json.load(f)

        title = info.get('title', '')
        uploader = info.get('uploader', '').strip()
        channel = info.get('channel', '').strip()
        info_artist = info.get('artist', '')
        creator = info.get('creator', '')

        artist = None
        source = 'unknown'

        # Strategy 1: info.json artist/creator fields (most reliable)
        if info_artist:
            a = first_artist(str(info_artist))
            if a and not is_noise(a) and looks_like_artist(a):
                artist = a
                source = 'info_json.artist'

        if not artist and creator:
            a = first_artist(str(creator))
            if a and not is_noise(a) and looks_like_artist(a):
                artist = a
                source = 'info_json.creator'

        # Strategy 2: Parse from title
        if not artist:
            artist = extract_artist_from_title(title)
            if artist:
                source = 'title_parse'

        # Strategy 3: info.json uploader/channel
        if not artist:
            a = clean_uploader_as_artist(uploader)
            if a and looks_like_artist(a):
                artist = a
                source = 'info_json.uploader'

        if not artist and channel != uploader:
            a = clean_uploader_as_artist(channel)
            if a and looks_like_artist(a):
                artist = a
                source = 'info_json.channel'

        # Append featured artist from title
        feat = extract_feat_from_title(title)
        if artist and feat and 'ft.' not in artist.lower() and 'feat.' not in artist.lower():
            artist = f"{artist} ft. {feat}"

        if artist:
            entry['artist'] = artist
            entry['source'] = source
            filled += 1
            examples.append((key, title[:80], artist, source))

    with open(TAGS_PATH, 'w') as f:
        json.dump(tags, f, indent=2, ensure_ascii=False)

    blank_after = sum(1 for v in tags.values() if not v.get('artist', '').strip())

    print(f"Entries with artist filled (after): {total - blank_after}")
    print(f"Filled this run: {filled}")
    print(f"Still blank: {blank_after}")
    print()

    if examples:
        print("Examples of filled entries:")
        for key, title, artist, source in examples:
            print(f'  * {key}: "{title}"')
            print(f'    -> {artist}  [{source}]')

    if blank_after > 0:
        print()
        print("Still blank (could not determine artist):")
        for key, entry in tags.items():
            if not entry.get('artist', '').strip():
                ip = os.path.join(LIBRARY_SUBDIR, f"{key}.info.json")
                if os.path.exists(ip):
                    with open(ip) as f:
                        ti = json.load(f).get('title', '')
                    print(f'  * {key}: "{ti[:100]}"')


if __name__ == '__main__':
    main()
