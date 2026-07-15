#!/usr/bin/env python3
"""Fix karaoke video tags in tags.json by scanning all .info.json metadata files."""

import json
import glob
import os
import re
import sys

LIBRARY = os.path.expanduser('~/.cursor/projects/Users-macdonk-Documents-GitHub-deskreen')
# Override - actual path
LIBRARY = '/Users/macdonk/Documents/GitHub/deskreen/.deskreen/library'
TAGS_PATH = '/Users/macdonk/Documents/GitHub/deskreen/.deskreen/tags.json'

# ── Karaoke detection ──────────────────────────────────────────────────────

TITLE_KEYWORDS = [
    'karaoke', 'karafun', 'instrumental',
    'cc karaoke', '(karaoke)', '[karaoke]',
    'karaoke version', '🎤', 'karaokê',
    'backing track', 'no lead vocal',
]

UPLOADER_KEYWORDS = [
    'karafun', 'karaoke', 'stingray',
]

def is_karaoke(title, uploader, channel):
    t = (title or '').lower()
    u = ((uploader or '') + ' ' + (channel or '')).lower()

    for kw in TITLE_KEYWORDS:
        if kw in t:
            return True

    for kw in UPLOADER_KEYWORDS:
        if kw in u:
            return True

    return False


def extract_artist_from_title(title):
    """
    Try to extract artist from common title formats:
      "Song Title - Artist | Karaoke Version | KaraFun"
      "Artist - Song Title (Karaoke)"
      "Artist - Song Title [Karaoke]"
    Returns the artist name, or None.
    """
    if not title:
        return None

    # KaraFun style: "Song Title - Artist | Karaoke Version | KaraFun"
    m = re.match(r'^(.+?)\s*[-–—]\s*(.+?)\s*\|', title)
    if m:
        # Check which part looks more like an artist vs song name
        # In KaraFun, first group is song, second is artist
        song_part = m.group(1).strip()
        artist_part = m.group(2).strip()
        # If artist_part doesn't contain karaoke-related words, it's likely the artist
        if not any(kw in artist_part.lower() for kw in ('karaoke', 'karafun', 'version', 'instrumental')):
            return artist_part
        return song_part

    # "Artist - Song Title (Karaoke)" or "Artist - Song Title [Karaoke]"
    m = re.match(r'^(.+?)\s*[-–—]\s*(.+?)\s*[(\[]', title)
    if m:
        return m.group(1).strip()

    # Plain "Artist - Song Title"
    m = re.match(r'^(.+?)\s*[-–—]\s*(.+)$', title)
    if m:
        return m.group(1).strip()

    return None


def main():
    print('Loading tags.json ...')
    with open(TAGS_PATH) as f:
        tags = json.load(f)

    print(f'  {len(tags)} entries loaded')

    info_files = sorted(glob.glob(os.path.join(LIBRARY, '*.info.json')))
    print(f'  {len(info_files)} info.json files found')
    print()

    # Track changes
    fixed_type = 0       # type changed from song/Music → karaoke
    fixed_tag = 0        # tag set/changed to karaoke
    added_title = 0      # title added from info.json
    added_artist = 0     # artist added from title parsing
    new_entries = 0      # new entry created for vid not in tags.json

    examples_fixed = []

    for i, fpath in enumerate(info_files):
        vid = os.path.basename(fpath).replace('.info.json', '')
        if (i + 1) % 500 == 0:
            print(f'  Processed {i + 1}/{len(info_files)} ...', flush=True)

        try:
            with open(fpath, errors='replace') as f:
                info = json.load(f)
        except Exception:
            continue

        title = info.get('title', '') or ''
        uploader = info.get('uploader', '') or ''
        channel = info.get('channel', '') or ''

        karaoke = is_karaoke(title, uploader, channel)

        # Create entry if missing
        if vid not in tags:
            tags[vid] = {}
            new_entries += 1

        entry = tags[vid]
        modified_this = False

        # ── Fix type and tag ───────────────────────────────────────────────
        if karaoke:
            old_type = entry.get('type', '')
            old_tag = entry.get('tag', '')

            if entry.get('type') not in ('karaoke',):
                entry['type'] = 'karaoke'
                fixed_type += 1
                modified_this = True
            if entry.get('tag') != 'karaoke':
                entry['tag'] = 'karaoke'
                fixed_tag += 1
                modified_this = True

            if modified_this and len(examples_fixed) < 15:
                examples_fixed.append({
                    'vid': vid,
                    'title': title[:100],
                    'uploader': uploader,
                    'old_type': old_type,
                    'old_tag': old_tag,
                })

        # ── Add title from info.json if missing ────────────────────────────
        if title and not entry.get('title'):
            entry['title'] = title
            added_title += 1
            modified_this = True

        # ── Add artist from title parsing if missing ───────────────────────
        if not entry.get('artist') and title:
            artist = extract_artist_from_title(title)
            if artist:
                entry['artist'] = artist
                added_artist += 1
                modified_this = True

    print(f'\nWriting updated tags.json ({len(tags)} entries) ...')
    with open(TAGS_PATH, 'w') as f:
        json.dump(tags, f, indent=2)
    print('Done.\n')

    # ── Summary ────────────────────────────────────────────────────────────
    type_counts = {}
    tag_counts = {}
    for v in tags.values():
        t = v.get('type', 'none')
        type_counts[t] = type_counts.get(t, 0) + 1
        tg = v.get('tag', 'none')
        tag_counts[tg] = tag_counts.get(tg, 0) + 1

    print('=' * 60)
    print('SUMMARY')
    print('=' * 60)
    print(f'Total videos in tags.json:      {len(tags)}')
    print(f'Total info.json files scanned:  {len(info_files)}')
    print()
    print('Changes applied:')
    print(f'  type → karaoke:               {fixed_type}')
    print(f'  tag  → karaoke:               {fixed_tag}')
    print(f'  title added from info.json:   {added_title}')
    print(f'  artist parsed from title:      {added_artist}')
    print(f'  new entries created:           {new_entries}')
    print()
    print('Final type distribution:')
    for t, count in sorted(type_counts.items()):
        print(f'  {t}: {count}')
    print()
    print('Final tag distribution:')
    for tg, count in sorted(tag_counts.items()):
        print(f'  {tg}: {count}')
    print()

    if examples_fixed:
        print('Examples of fixed entries:')
        for ex in examples_fixed:
            print(f'  {ex["vid"]}: "{ex["title"]}"')
            print(f'    uploader: {ex["uploader"]}')
            print(f'    old_type={ex["old_type"]!r} → type=karaoke')
            print(f'    old_tag={ex["old_tag"]!r}  → tag=karaoke')
            print()

    # Verify: check if any karaoke-titled videos still have wrong type
    print('=' * 60)
    print('VERIFICATION')
    print('=' * 60)
    missed = 0
    for vid, entry in tags.items():
        if entry.get('type') != 'karaoke':
            # Check if there's an info.json with karaoke title
            ipath = os.path.join(LIBRARY, f'{vid}.info.json')
            if os.path.exists(ipath):
                try:
                    with open(ipath, errors='replace') as f:
                        info = json.load(f)
                    if is_karaoke(info.get('title',''), info.get('uploader',''), info.get('channel','')):
                        missed += 1
                        if missed <= 5:
                            print(f'  MISSED: {vid} type={entry.get("type")} title="{info.get("title","")[:80]}"')
                except Exception:
                    pass

    if missed == 0:
        print('  All karaoke videos correctly tagged as type=karaoke ✅')
    else:
        print(f'  {missed} karaoke videos still have wrong type ⚠️')

    return 0


if __name__ == '__main__':
    sys.exit(main())
