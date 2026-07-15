#!/usr/bin/env python3
"""Download 22 new karaoke videos and tag them."""
import subprocess, json, os, sys, time

OUTPUT_DIR = '/Users/macdonk/Documents/GitHub/deskreen/.deskreen/library/karaoke'
ARCHIVE = '/Users/macdonk/Documents/GitHub/deskreen/.deskreen/youtube-download-archive.txt'
TAGS_PATH = '/Users/macdonk/Documents/GitHub/deskreen/.deskreen/tags.json'

# Only the genuinely new karaoke tracks (exclude bad matches/instrumentals)
DOWNLOADS = [
    ("xpA9NlB30HQ", "Macklemore", "Thrift Shop", 1995),
    ("y1ZnaCAb-y8", "Lionel Richie", "All Night Long", 1983),
    ("tPoX2cG3ya0", "Zapp", "More Bounce to the Ounce", 1980),
    ("1OkCUCkdzOI", "M.I.A.", "Bad Girls", 2010),
    ("XIbel6mdsk0", "Kreayshawn", "Left Eye", 2012),
    ("z15wTzk3LCY", "The Chicks", "Wide Open Spaces", 1998),
    ("SHgwp4sjQSM", "Kendrick Lamar", "A.D.H.D", 2011),
    ("M54x-X2rnb0", "Lissie", "Pursuit of Happiness", 2010),
    ("GjDEGzf9hzM", "Dead Moon", "Dead Moon Night", 1990),
    ("zAbT9dr1R30", "Heart", "Alone", 1987),
    ("OJorUj0JA3w", "Britney Spears", "Oops I Did It Again", 2000),
    ("LRJx1QH03sU", "Kylie Minogue", "Cant Get You Out Of My Head", 2001),
    ("peVER22lprk", "Len", "Steal My Sunshine", 1999),
    ("M0EIiU6cX70", "Spice Girls", "Spice Up Your Life", 1997),
    ("uQct-ETJsqk", "Vengaboys", "We Like to Party", 1998),
    ("NxilU56kPu0", "Backstreet Boys", "I Want It That Way", 1999),
    ("FNIhj6DQtgk", "Eiffel 65", "Blue", 1999),
    ("AaDforeoIVA", "Sarah McLachlan", "Fallen", 2003),
    ("-MHQXGFvyS4", "Vicious Pink", "Cccant You See", 1985),
    ("T-gYk_klzY0", "Sister Nancy", "Bam Bam", 1982),
    ("yJ_J4i1EkFY", "The Cardigans", "Fine", 1995),
    ("0Xb2ZZ0sMZE", "Sparks", "Angst In My Pants", 1982),
]

successful = 0
failed = []

for vid, artist, title, year in DOWNLOADS:
    print(f"\nDownloading: {artist} - {title} ({vid})...")
    try:
        cmd = [
            'yt-dlp',
            f'https://www.youtube.com/watch?v={vid}',
            '-o', f'{OUTPUT_DIR}/%(id)s.%(ext)s',
            '--write-info-json',
            '--write-thumbnail',
            '--write-subs',
            '--sub-langs', 'all,-live_chat',
            '--download-archive', ARCHIVE,
            '--cookies-from-browser', 'chrome',
            '--ignore-errors',
            '--no-playlist',
            '--no-mtime',
        ]
        
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120,
                          cwd='/Users/macdonk/Documents/GitHub/deskreen/.deskreen')
        
        if r.returncode == 0 and os.path.exists(f'{OUTPUT_DIR}/{vid}.mp4'):
            print(f'  ✓ Downloaded successfully')
            successful += 1
        else:
            print(f'  ✗ Download failed: {r.stderr[-200:] if r.stderr else "no error output"}')
            failed.append(vid)
        
        # Brief pause between downloads
        time.sleep(2)
    except Exception as e:
        print(f'  ✗ Error: {e}')
        failed.append(vid)

print(f'\n\n=== Download complete ===')
print(f'Successful: {successful}/{len(DOWNLOADS)}')
if failed:
    print(f'Failed: {failed}')

# Now tag them in tags.json
print('\nTagging in tags.json...')
with open(TAGS_PATH) as f:
    tags = json.load(f)

tagged = 0
for vid, artist, title, year in DOWNLOADS:
    if vid in tags:
        tags[vid]['tag'] = 'karaoke'
    else:
        tags[vid] = {'tag': 'karaoke', 'year': str(year), 'artist': artist, 'source': 'manual_karaoke'}
    tagged += 1

with open(TAGS_PATH, 'w') as f:
    json.dump(tags, f, ensure_ascii=False)

print(f'Tagged {tagged} videos as karaoke')
print(f'\nAlso already in library:')
print(f'  Alanis Morissette - You Oughta Know (BBdPnDnmPzc)')
print(f'\nNo karaoke version found:')
print(f'  Moon Duo - Sleepwalker (search returned wrong artist)')
print(f'  Too Short - The Ghetto (only instrumental exists)')
print(f'  Aphex Twin - Avril 14th (no karaoke version)')
print(f'  Moby - Honey (only instrumental exists)')
print(f'  Suede - Stay Together (only instrumental live exists)')
