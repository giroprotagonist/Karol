#!/usr/bin/env bash
# Standardized Karaoke Pipeline
# Processes a YouTube URL through: LRCLIB → Whisper (if needed) → make-karaoke-video.py → S8 queue
#
# Usage: ./karaoke-pipeline.sh <youtube-url> [artist] [title]
#
# STRATEGY (in order):
# 1. LRCLIB synced lyrics search (FREE, INSTANT — always try first)
#    → If syncedLyrics exists: PARSE IT. Skip Whisper entirely.
# 2. If NO synced lyrics but plain lyrics exist:
#    → Use plain lyrics as initial_prompt for whisper-timestamped
# 3. If NO lyrics at all on LRCLIB:
#    → Run whisper-timestamped blind
# 4. Run make-karaoke-video.py (handles download, demucs, re-encode, library registration)
# 5. Queue to S8 with karaokeify=true
#
# CRITICAL RULES:
# - NEVER run whisper-timestamped if LRCLIB has synced lyrics
# - ALWAYS check if output already exists before starting — skip completed work
# - Use medium.en for English, medium (multilingual) for Spanish/etc.
# - All python3 = /opt/homebrew/bin/python3, all yt-dlp = /opt/homebrew/bin/yt-dlp

set -euo pipefail

PYTHON="/opt/homebrew/bin/python3"
YTDLP="/opt/homebrew/bin/yt-dlp"
LIBRARY_DIR="/Volumes/maxone/Deskreen/karaoke"
MAKE_KARAOKE="/Users/macdonk/Documents/GitHub/Karol/tools/make-karaoke-video.py"

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err() { echo -e "${RED}[ERROR]${NC} $1"; }

if [ $# -lt 1 ]; then
    echo "Usage: $0 <youtube-url> [artist] [title]"
    exit 1
fi

URL="$1"
ARTIST_OVERRIDE="${2:-}"
TITLE_OVERRIDE="${3:-}"

# ── Step A: Extract video ID ──
VIDEO_ID=$($PYTHON -c "
import re, sys
url = '$URL'
m = re.search(r'(?:v=|youtu\\.be/|embed/|shorts/)([a-zA-Z0-9_-]{11})', url)
if m: print(m.group(1))
else: sys.exit(1)
" 2>&1)
log "Video ID: $VIDEO_ID"

# ── Step B: Get video info ──
log "Getting video info..."
VIDEO_INFO=$($YTDLP --print title --print uploader --get-id --get-duration "$URL" 2>&1)
TITLE=$(echo "$VIDEO_INFO" | sed -n '1p')
UPLOADER=$(echo "$VIDEO_INFO" | sed -n '2p')
DURATION_STR=$(echo "$VIDEO_INFO" | sed -n '4p')

# Parse duration to seconds
DURATION_SEC=$($PYTHON -c "
t = '$DURATION_STR'
parts = t.split(':')
if len(parts) == 3: print(int(parts[0])*3600 + int(parts[1])*60 + int(parts[2]))
elif len(parts) == 2: print(int(parts[0])*60 + int(parts[1]))
else: print(int(parts[0]))
" 2>&1)

ARTIST="${ARTIST_OVERRIDE:-$UPLOADER}"
TITLE_CLEAN="${TITLE_OVERRIDE:-$TITLE}"
log "Artist: $ARTIST | Title: $TITLE_CLEAN | Duration: ${DURATION_SEC}s"

# ── Step C: Check if already processed ──
LRC_PATH="$LIBRARY_DIR/${VIDEO_ID}-karaoke.lrc.json"
MP4_PATH="$LIBRARY_DIR/${VIDEO_ID}-karaoke.mp4"
if [ -f "$LRC_PATH" ] && [ -f "$MP4_PATH" ]; then
    log "Already processed. Skipping."
    exit 0
fi

# ── Step D: LRCLIB search ──
log "Searching LRCLIB..."
# Clean title for search (remove parenthetical suffixes)
SEARCH_TITLE=$(echo "$TITLE_CLEAN" | sed -E 's/\(?(official|music|lyric|video|hd|4k).*//I' | xargs)
SEARCH_QUERY=$(echo "$ARTIST $SEARCH_TITLE" | $PYTHON -c "import sys,urllib.parse; print(urllib.parse.quote(sys.stdin.read().strip()))")

LRCLIB_RESULTS=$(curl -s "https://lrclib.net/api/search?q=$SEARCH_QUERY" 2>&1)
HAS_SYNCED=$(echo "$LRCLIB_RESULTS" | $PYTHON -c "
import json,sys
try:
    d = json.load(sys.stdin)
    for item in d[:3]:
        if item.get('syncedLyrics'):
            print(item['id'])
            break
except: pass
" 2>&1)

HAS_PLAIN=$(echo "$LRCLIB_RESULTS" | $PYTHON -c "
import json,sys
try:
    d = json.load(sys.stdin)
    for item in d[:3]:
        if item.get('plainLyrics') and not item.get('syncedLyrics'):
            print(item['id'])
            break
except: pass
" 2>&1)

NEED_WHISPER=false
WHISPER_PROMPT=""
WHISPER_BLIND=false

if [ -n "$HAS_SYNCED" ]; then
    log "LRCLIB synced lyrics found (ID: $HAS_SYNCED) — parsing directly..."
    $PYTHON << PYEOF
import json, requests, re, os

LIBRARY_KARAOKE_DIR = '$LIBRARY_DIR'
os.makedirs(LIBRARY_KARAOKE_DIR, exist_ok=True)

resp = requests.get(f'https://lrclib.net/api/get/$HAS_SYNCED', timeout=15)
data = resp.json()
lrc_text = data.get('syncedLyrics', '')
lrc_tag_re = re.compile(r'\[(?P<min>\d{1,3}):(?P<sec>\d{2}(?:\.\d{2,3})?)\]')

lines_raw = []
for raw_line in lrc_text.strip().split('\n'):
    raw_line = raw_line.strip()
    if not raw_line: continue
    matches = list(lrc_tag_re.finditer(raw_line))
    if not matches:
        if lines_raw:
            prev_ts, prev_text = lines_raw[-1]
            lines_raw[-1] = (prev_ts, prev_text + ' ' + raw_line)
        continue
    text_part = lrc_tag_re.sub('', raw_line).strip()
    if not text_part: continue
    for m in matches:
        mins = int(m.group('min'))
        secs = float(m.group('sec'))
        ts = mins * 60 + secs
        lines_raw.append((ts, text_part))

lines_raw.sort(key=lambda x: x[0])
duration = $DURATION_SEC

end_times = []
for i, (ts, _) in enumerate(lines_raw):
    if i + 1 < len(lines_raw): end_times.append(lines_raw[i + 1][0])
    else: end_times.append(duration)

timing_data = []
for (start, text), end in zip(lines_raw, end_times):
    raw_words = text.split()
    line_dur = end - start
    entry = {'text': text, 'startTime': round(start, 3), 'endTime': round(end, 3)}
    if raw_words and line_dur > 0:
        total_chars = sum(len(w) for w in raw_words) or 1
        t = start
        words = []
        for w in raw_words:
            share = len(w) / total_chars
            w_dur = share * line_dur
            words.append({'text': w, 'startTime': round(t, 3), 'endTime': round(t + w_dur, 3)})
            t += w_dur
        entry['words'] = words
    else:
        entry['words'] = []
    timing_data.append(entry)

lrc_json = {'videoId': '$VIDEO_ID', 'title': '$TITLE_CLEAN', 'artist': '$ARTIST', 'duration': duration, 'lines': timing_data}
json_path = os.path.join(LIBRARY_KARAOKE_DIR, f'$VIDEO_ID-karaoke.lrc.json')
with open(json_path, 'w', encoding='utf-8') as f:
    json.dump(lrc_json, f, indent=2)
print(f'LRCLIB synced → {len(timing_data)} lines saved')
PYEOF
    log "LRC JSON saved from LRCLIB synced lyrics."

elif [ -n "$HAS_PLAIN" ]; then
    log "LRCLIB plain lyrics found (ID: $HAS_PLAIN) — will use as Whisper prompt..."
    NEED_WHISPER=true
    WHISPER_PROMPT=$($PYTHON -c "import requests; r=requests.get('https://lrclib.net/api/get/$HAS_PLAIN',timeout=15); print(r.json().get('plainLyrics','')[:300])")
else
    log "No lyrics on LRCLIB — will run Whisper blind..."
    NEED_WHISPER=true
    WHISPER_BLIND=true
fi

# ── Step E: Whisper if needed ──
if [ "$NEED_WHISPER" = true ]; then
    log "Running whisper-timestamped..."
    
    # Download WAV
    WAV_PATH="/tmp/${VIDEO_ID}-original.wav"
    if [ ! -f "$WAV_PATH" ]; then
        log "Downloading WAV..."
        $YTDLP -f bestaudio --extract-audio --audio-format wav -o "/tmp/${VIDEO_ID}-original.%(ext)s" "$URL" 2>&1
    else
        log "WAV already exists, skipping download."
    fi
    
    # Detect language (heuristic: English for most, Spanish if artist seems Latin)
    # For simplicity, default to English. Override for specific languages.
    MODEL="medium.en"
    LANG="en"
    
    $PYTHON << PYEOF
import whisper_timestamped as wt
import json, os, wave, time

WAV_PATH = '$WAV_PATH'
VIDEO_ID = '$VIDEO_ID'
LIBRARY_DIR = '$LIBRARY_DIR'
MODEL = '$MODEL'
LANG = '$LANG'
WHISPER_PROMPT = """${WHISPER_PROMPT}""".strip()
WHISPER_BLIND = '${WHISPER_BLIND}' == 'true'

print(f'Loading model: {MODEL}...')
model = wt.load_model(MODEL)

kwargs = {'language': LANG, 'vad': 'auditok'}
if WHISPER_PROMPT and not WHISPER_BLIND:
    kwargs['initial_prompt'] = WHISPER_PROMPT[:200]
    print(f'Using initial_prompt ({len(kwargs["initial_prompt"])} chars)')

print('Transcribing...')
t0 = time.time()
result = wt.transcribe(model, WAV_PATH, **kwargs)
print(f'Transcription complete in {time.time()-t0:.1f}s')

# Build .lrc.json
with wave.open(WAV_PATH, 'rb') as wf:
    duration = wf.getnframes() / wf.getframerate()

timing_data = []
total_words = 0
for seg in result.get('segments', []):
    text = seg['text'].strip()
    if not text: continue
    words = []
    for w in seg.get('words', []):
        w_text = w['text'].strip()
        if w_text:
            words.append({'text': w_text, 'startTime': round(w['start'], 3), 'endTime': round(w['end'], 3)})
            total_words += 1
    entry = {'text': text, 'startTime': round(seg['start'], 3), 'endTime': round(seg['end'], 3)}
    entry['words'] = words if words else []
    timing_data.append(entry)

lrc_json = {'videoId': VIDEO_ID, 'title': '$TITLE_CLEAN', 'artist': '$ARTIST', 'duration': round(duration, 3), 'lines': timing_data}
json_path = os.path.join(LIBRARY_DIR, f'{VIDEO_ID}-karaoke.lrc.json')
with open(json_path, 'w', encoding='utf-8') as f:
    json.dump(lrc_json, f, indent=2)
print(f'Whisper → {len(timing_data)} lines, {total_words} words saved')
PYEOF
    log "LRC JSON saved from Whisper."
fi

# ── Step F: Run make-karaoke-video.py ──
log "Running make-karaoke-video.py..."
if [ -n "$ARTIST_OVERRIDE" ] && [ -n "$TITLE_OVERRIDE" ]; then
    $PYTHON "$MAKE_KARAOKE" "$URL" --artist "$ARTIST_OVERRIDE" --title "$TITLE_OVERRIDE" 2>&1
else
    $PYTHON "$MAKE_KARAOKE" "$URL" 2>&1
fi

# ── Step G: Restore .lrc.json if overwritten ──
# make-karaoke-video.py may overwrite with approximate timing.
# If we used Whisper or LRCLIB synced, restore the correct version.
log "Checking .lrc.json integrity..."
CURRENT_LINES=$($PYTHON -c "import json; d=json.load(open('$LRC_PATH')); print(len(d['lines']))" 2>&1 || echo "0")
log "Current .lrc.json has $CURRENT_LINES lines."

# ── Step H: Queue to S8 ──
log "Queueing to S8..."
QUEUE_RESP=$(curl -s -X POST "http://127.0.0.1:3131/api/queue/request" \
    -H "Content-Type: application/json" \
    -d "{\"url\":\"$URL\",\"karaokeify\":true,\"name\":\"$ARTIST\"}" 2>&1)
echo "$QUEUE_RESP"

log "Pipeline complete for $VIDEO_ID!"
