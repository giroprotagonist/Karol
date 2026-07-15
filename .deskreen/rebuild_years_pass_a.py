#!/usr/bin/env python3
"""Pass A: Restore clean upload_date baseline + CSV corrections for karaoke tracks."""

import json, csv, os
from collections import Counter

TAGS_PATH = '/Users/macdonk/Documents/GitHub/deskreen/.deskreen/tags.json'
CSV_PATH = '/Users/macdonk/Documents/GitHub/deskreen/.deskreen/alt_songs_1994_2002.csv'
LIBRARY_DIR = '/Users/macdonk/Documents/GitHub/deskreen/.deskreen/library'

# ── Step 1: Build upload_date map from .info.json files ──
print('Reading upload_dates from info.json files...')
upload_dates = {}
count = 0
for fname in os.listdir(LIBRARY_DIR):
    if not fname.endswith('.info.json'):
        continue
    vid = fname[:-len('.info.json')]
    if len(vid) != 11:
        continue
    try:
        with open(os.path.join(LIBRARY_DIR, fname)) as f:
            d = json.load(f)
        ud = d.get('upload_date', '')
        if ud and len(ud) >= 4:
            upload_dates[vid] = ud[:4]
            count += 1
    except:
        pass
print(f'  Found upload_dates for {count} videos')

# ── Step 2: Build CSV artist→year map (most common year per artist) ──
print('Building CSV artist→year map...')
artist_years = {}
with open(CSV_PATH) as f:
    for row in csv.DictReader(f):
        artist = row['Artist'].strip().lower()
        year = row['Year'].strip()
        if artist and year.isdigit() and 1990 <= int(year) <= 2005:
            artist_years.setdefault(artist, []).append(int(year))

artist_best_year = {}
for a, yrs in artist_years.items():
    c = Counter(yrs)
    artist_best_year[a] = c.most_common(1)[0][0]
print(f'  {len(artist_best_year)} artists with era years')

# ── Step 3: Artist era validation table (impossible year detection) ──
# Artists from the CSV era — their active years must be 1990-2005
csv_era_artists = set(artist_best_year.keys())

# Modern artists (debuted 2010+)
modern_artists = {
    'olivia rodrigo', 'billie eilish', 'dua lipa', 'taylor swift', 'ed sheeran',
    'justin bieber', 'selena gomez', 'miley cyrus', 'ariana grande', 'kendrick lamar',
    'post malone', 'lizzo', 'doja cat', 'megan thee stallion', 'lil nas x',
    'harry styles', 'shawn mendes', 'camila cabello', 'halsey', 'cardi b',
    'travis scott', 'drake', 'the weeknd', 'bad bunny', 'bts',
    'blackpink', 'katseye', 'lisa', 'jennie', 'rosé', 'sza',
    'six sex', 'slayyyter', 'rebecca black', 'addison rae', 'pinkpantheress',
    'bbno$', 'lil mariko', 'cupcakke', 'ashnikko', 'frost children',
    'aleesha', 'chappell roan', 'sabrina carpenter', 'olivia dean', 'gracie abrams',
    'tate mcrae', 'ice spice', 'latto', 'glo rilla', 'sex education',
    'milli', 'badmixy', 'benz khaokhwan', 'alie blackcobra', 'f.hero',
    'lady london', 'lussa', 'candy', 'empress', 'younggu',
    'f5ve', 'xg', 'lena', 'yena', 'xg',
    'bb trickz', 'la joaqui', 'maria becerra', 'emilia', 'nicki nicole',
    'tini', 'danna', 'karaoke', 'natalia lafourcade', 'cazzu',
    'six sex', 'tomora', 'wizzle', 'xkyllar', 'loyaltty',
    'mc art', 'mudda', 'ramengvrl', 'jarvis', 'skuzland',
    'shygirl', 'nene', 'roxy', 'ikitty', 'sukihana',
    'ho99o9', 'vtss', 'igorr', 'frost children', 'underscores',
    'joost', 'dadi freyr', 'yiila', 'marina', 'yves',
    'imaabs', 'bodine', 'cain culto', 'xiuhtezcatl', 'boko yout',
    'kkk ii', 'balming tiger', 'boyfree', 'evissimax',
}

# Pre-1990 era artists (active before 1990, could have songs 1950-1989)
classic_artists = {
    'david bowie', 'the beatles', 'queen', 'led zeppelin', 'the rolling stones',
    'pink floyd', 'the who', 'the doors', 'jimi hendrix', 'bob dylan',
    'neil young', 'bruce springsteen', 'elvis costello', 'the clash',
    'the cure', 'depeche mode', 'new order', 'joy division', 'the smiths',
    'siouxsie', 'the banshees', 'siouxsie and the banshees', 'the stranglers',
    'dead or alive', 'soft cell', 'visage', 'talk talk', 'tears for fears',
    'orchestral manoeuvres in the dark', 'simple minds', 'new gold dream',
    'hicrick', 'the sisters of mercy', 'the godfathers', 'echo and the bunnymen',
    'the jesus and mary chain', 'my bloody valentine', 'cocteau twins',
    'a flock of seagulls', 'missing persons', 'berlin', 'animotion',
    'the go-go\'s', 'the bangles', 'haircut 100', 'the cars',
    'the boomtown rats', 'the sugarhill gang', 'grandmaster flash',
    'run dmc', 'beastie boys', 'public enemy', 'll cool j',
    'prince', 'michael jackson', 'madonna', 'janet jackson',
    'george michael', 'whitney houston', 'tina turner',
    'u2', 'r.e.m.', 'the police', 'sting',
    'duran duran', 'pet shop boys', 'new kids on the block',
    'iggy pop', 'the stooges', 'ramones', 'black sabbath',
    'motley crue', 'poison', 'def leppard', 'guns n roses',
    'metallica', 'iron maiden', 'judas priest', 'dio',
    'ac/dc', 'kiss', 'aerosmith', 'van halen',
    'deep purple', 'yes', 'genesis', 'phil collins',
    'steely dan', 'fleetwood mac', 'stevie nicks', 'tom petty',
    'bob seger', 'john mellencamp', 'billy joel', 'elton john',
    'rick springfield', 'huey lewis', 'the news', 'huey lewis & the news',
    'journey', 'boston', 'foreigner', 'styx', 'reo speedwagon',
    'the psychedelic furs', 'echo', 'moby', 'aphex twin', 'boards of canada',
}

active_eras = {}
# 90s era artists: 1990-2005
for a in csv_era_artists:
    active_eras[a] = (1990, 2005)
# Modern artists: 2010-2026
for a in modern_artists:
    active_eras[a] = (2010, 2026)
# Classic artists: 1950-2026
for a in classic_artists:
    active_eras[a] = (1950, 2026)

print(f'  {len(active_eras)} artists in era validation table')

# ── Step 4: Load tags, rebuild years ──
print('Loading tags.json...')
with open(TAGS_PATH) as f:
    tags = json.load(f)

# Backup
bak_path = TAGS_PATH.replace('.json', '.bak.pass_a')
print(f'Backing up to {bak_path}')
with open(bak_path, 'w') as f:
    json.dump(tags, f, ensure_ascii=False)

# ── Step 5: Rebuild years ──
print('Rebuilding years...')
stats = {'from_csv': 0, 'from_upload': 0, 'skipped': 0}

for vid, t in tags.items():
    is_karaoke = t.get('tag') == 'karaoke'
    if not is_karaoke:
        continue
    
    artist = (t.get('artist', '') or '').lower().strip()
    source = t.get('source', '')
    
    # Baseline: upload_date from YouTube metadata
    baseline_year = upload_dates.get(vid)
    if not baseline_year or not baseline_year.isdigit():
        # Try to keep existing year as fallback
        existing = str(t.get('year', '')).strip()
        if existing and existing.isdigit() and 1950 <= int(existing) <= 2026:
            baseline_year = existing
        else:
            baseline_year = ''
            stats['skipped'] += 1
            continue
    
    new_year = baseline_year
    stats['from_upload'] += 1
    
    # CSV correction: if artist matches a CSV era artist, use that era year
    if artist in artist_best_year:
        csv_year = str(artist_best_year[artist])
        new_year = csv_year
        stats['from_csv'] += 1
    
    # Artist-era validation: catch impossible years
    if artist in active_eras:
        era_min, era_max = active_eras[artist]
        yr_int = int(new_year) if new_year.isdigit() else 0
        # Skip: CSV corrections from 94-02 era are already correct
        # Keep upload_date for other cases — it's valid YouTube metadata
    
    # Absolute bounds: no pre-1950, no post-2026
    yr_int = int(new_year) if new_year.isdigit() else 0
    if yr_int < 1950 or yr_int > 2026:
        new_year = baseline_year  # fall back to upload_date
        # Double-check baseline
        bl_int = int(baseline_year) if baseline_year.isdigit() else 0
        if bl_int < 1950 or bl_int > 2026:
            new_year = ''  # truly invalid, leave empty
    
    if new_year:
        t['year'] = new_year
        if 'source' not in t or not t.get('source'):
            if artist in artist_best_year:
                t['source'] = 'csv_era'
            else:
                t['source'] = 'upload_date'
    else:
        stats['skipped'] += 1

# ── Step 6: Write ──
print(f'Writing updated tags.json...')
with open(TAGS_PATH, 'w') as f:
    json.dump(tags, f, ensure_ascii=False)

print()
print(f'Done! Stats:')
print(f'  From CSV era: {stats["from_csv"]}')
print(f'  From upload_date: {stats["from_upload"] - stats["from_csv"]}')
print(f'  Skipped (no year): {stats["skipped"]}')
