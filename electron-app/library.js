// Karol Electron — Library Module
// Video file scanning, caching, metadata, lyrics, tags.
// Ported from api-server/index.js — stripped of all HTTP/routing.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// ── Directories (configurable via env, same as api-server defaults) ──
const EXTERNAL_DRIVE = process.env.KAROL_EXTERNAL_DRIVE || '/Volumes/maxone';
const LIBRARY_DIR = path.join(EXTERNAL_DRIVE, 'Deskreen');
const LIBRARY_KARAOKE_DIR = path.join(LIBRARY_DIR, 'karaoke');
const LIBRARY_SONGS_DIR = path.join(LIBRARY_DIR, 'songs');
const DOWNLOADS_DIR = path.resolve(__dirname, '..', '.karol', 'youtube-downloads');
const ARCHIVE_PATH = path.join(LIBRARY_DIR, 'youtube-download-archive.txt');
const TAGS_PATH = path.join(LIBRARY_DIR, 'tags.json');
const CACHE_FILE = '/tmp/karol-library-cache.json'; // Raw JSON cache written by library-scan-worker.js
const SCRIPTS_DIR = path.resolve(__dirname, '..', 'scripts');

// All library directories to search for files
const LIBRARY_SEARCH_DIRS = [LIBRARY_DIR, LIBRARY_KARAOKE_DIR, LIBRARY_SONGS_DIR];
const VIDEO_EXTS = ['.mp4', '.mkv', '.mp3', '.webm'];

// Ensure directories exist
for (const d of [LIBRARY_DIR, LIBRARY_KARAOKE_DIR, LIBRARY_SONGS_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
}

// ── Internal state ──
let __libraryListCache = { ts: 0, data: null, rawJson: null, archiveMtime: 0 };
let __libraryScanInFlight = null;
const LIBRARY_LIST_CACHE_MS = 60_000; // rescan every 60 seconds
let _rebuildTagsInFlight = null;
let _tagsSyncScheduled = false;

// ── Tag helpers ──

function loadTags() {
  try {
    if (fs.existsSync(TAGS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(TAGS_PATH, 'utf8'));
      const normalized = {};
      for (const [vid, val] of Object.entries(raw)) {
        if (typeof val === 'string') {
          normalized[vid] = { tag: val, year: '', artist: '', source: '' };
        } else if (val && typeof val === 'object') {
          normalized[vid] = {
            tag: val.tag || val.type || 'music',
            year: val.year || '',
            artist: val.artist || '',
            source: val.source || ''
          };
        }
      }
      return normalized;
    }
  } catch (e) { console.error('[library/tags] load error:', e.message); }
  return {};
}

function saveTags(tags) {
  try {
    fs.writeFileSync(TAGS_PATH, JSON.stringify(tags, null, 2), 'utf8');
  } catch (e) { console.error('[library/tags] save error:', e.message); }
}

function rebuildTagsFromDisk() {
  if (_rebuildTagsInFlight) return _rebuildTagsInFlight;
  _rebuildTagsInFlight = (async () => {
    const startTime = Date.now();
    console.log('[library/tags] Rebuilding tags.json from info.json files ...');
    try {
      const tags = loadTags();
      let added = 0;
      for (const dir of LIBRARY_SEARCH_DIRS) {
        try {
          if (!fs.existsSync(dir)) continue;
          const files = fs.readdirSync(dir);
          for (const f of files) {
            if (!f.endsWith('.info.json') || f.startsWith('._')) continue;
            const videoId = f.replace('.info.json', '');
            if (tags[videoId]) continue;
            try {
              const info = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
              const title = (info.title || '').toLowerCase();
              const isKaraoke = /karaoke|instrumental|lyrics?|cover\b|backing.track|sing.along/i.test(title)
                || videoId.endsWith('-karaoke')
                || dir.includes('karaoke');
              const isSong = dir.includes('songs');
              const autoTag = isKaraoke ? 'karaoke' : (isSong ? 'music' : 'music');
              tags[videoId] = {
                tag: autoTag,
                year: (info.upload_date || '').slice(0, 4),
                artist: info.uploader || '',
                source: 'rebuilt-from-info.json'
              };
              added++;
            } catch (e) { /* skip corrupted */ }
          }
        } catch (e) { /* skip unreadable */ }
      }
      if (added > 0) {
        saveTags(tags);
        console.log(`[library/tags] Rebuilt ${added} entries in ${Date.now() - startTime}ms`);
        __libraryListCache = { ts: 0, data: null, rawJson: null, archiveMtime: 0 };
      }
    } catch (e) {
      console.error('[library/tags] Rebuild failed:', e.message);
    }
    _rebuildTagsInFlight = null;
  })();
  return _rebuildTagsInFlight;
}

// ── File path helpers ──

function _findInLibraryDirs(predicate) {
  for (const dir of LIBRARY_SEARCH_DIRS) {
    try {
      if (!fs.existsSync(dir)) continue;
      const result = predicate(dir);
      if (result) return result;
    } catch (e) { /* ignore */ }
  }
  return null;
}

function getVideoPath(videoId) {
  const found = _findInLibraryDirs((dir) => {
    for (const ext of VIDEO_EXTS) {
      const exact = path.join(dir, videoId + ext);
      if (fs.existsSync(exact)) return exact;
    }
    try {
      const files = fs.readdirSync(dir);
      for (const ext of VIDEO_EXTS) {
        const match = files.find(f => f.startsWith(videoId) && f.endsWith(ext));
        if (match) return path.join(dir, match);
      }
    } catch (e) { /* ignore */ }
    return null;
  });
  return found || path.join(LIBRARY_DIR, videoId + '.mp4');
}

function getFilePath(videoId) {
  const p = getVideoPath(videoId);
  return (p && fs.existsSync(p)) ? p : null;
}

function getInfoPath(videoId) {
  const found = _findInLibraryDirs((dir) => {
    const p = path.join(dir, videoId + '.info.json');
    if (fs.existsSync(p)) return p;
    return null;
  });
  return found || path.join(LIBRARY_DIR, videoId + '.info.json');
}

function getThumbPath(videoId) {
  return _findInLibraryDirs((dir) => {
    try {
      const files = fs.readdirSync(dir);
      for (const ext of ['jpg', 'webp', 'png']) {
        const exact = path.join(dir, videoId + '.' + ext);
        if (fs.existsSync(exact)) return exact;
        const match = files.find(f => f.startsWith(videoId) && f.endsWith('.' + ext) && !f.includes('.vtt') && !f.includes('.info.'));
        if (match) return path.join(dir, match);
      }
    } catch (e) { /* ignore */ }
    return null;
  });
}

function getMetadata(videoId) {
  try {
    const info = JSON.parse(fs.readFileSync(getInfoPath(videoId), 'utf8'));
    return {
      id: info.id,
      title: info.title,
      duration: info.duration,
      thumbnail: info.thumbnail,
      upload_date: info.upload_date,
      subtitles: Object.keys(info.subtitles || {}),
    };
  } catch { return null; }
}

// ── LRC Words Repair ──
// Ensures line.words[] arrays match line.text.  If text was corrected
// without rebuilding words[], the player renders stale wrong lyrics.
function _repairAndReturn(lrc) {
  if (!lrc || !lrc.lines) return lrc;
  // Force-aligned / manually-edited LRCs already have consistent text/words — don't destroy timings
  if (lrc.alignMode === 'reconcile+force') return lrc;
  if (lrc.manuallyEdited || String(lrc.alignMode || '').includes('|edited')) return lrc;
  let fixed = 0;
  for (const line of lrc.lines) {
    const text = (line.text || '').trim();
    const words = line.words || [];
    if (!words.length || !text) continue;
    const wordConcat = words.map(w => w.text || '').join('').replace(/\s/g, '');
    // Normalize unicode dashes/apostrophes the same way on both sides
    const norm = (s) => s
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      .replace(/[\u2018\u2019\u2032]/g, "'")
      .replace(/[\s,.\-!?;:'"]/g, '')
      .toLowerCase();
    if (norm(wordConcat) !== norm(text)) {
      // Rebuild words from text with even timing
      const rawWords = text.split(/\s+/).filter(Boolean);
      const start = line.startTime || 0;
      const end = line.endTime || (start + 1);
      const dur = Math.max(end - start, 0.1);
      const newWords = rawWords.map((w, i) => ({
        text: w,
        startTime: Math.round((start + dur * i / rawWords.length) * 1000) / 1000,
        endTime: Math.round((start + dur * (i + 1) / rawWords.length) * 1000) / 1000,
      }));
      line.words = newWords;
      fixed++;
    }
  }
  if (fixed) console.log('[library] Repaired', fixed, 'stale word arrays in lyrics');
  return lrc;
}

function getLyrics(videoId) {
  try {
    const lrcPath = path.join(LIBRARY_DIR, videoId + '.lrc.json');
    if (fs.existsSync(lrcPath)) {
      return _repairAndReturn(JSON.parse(fs.readFileSync(lrcPath, 'utf8')));
    }
    // Check karaoke dir — try videoId.lrc.json and videoId-karaoke.lrc.json
    const karaokeLrc = path.join(LIBRARY_KARAOKE_DIR, videoId + '.lrc.json');
    if (fs.existsSync(karaokeLrc)) {
      return _repairAndReturn(JSON.parse(fs.readFileSync(karaokeLrc, 'utf8')));
    }
    const karaokeLrcAlt = path.join(LIBRARY_KARAOKE_DIR, videoId + '-karaoke.lrc.json');
    if (fs.existsSync(karaokeLrcAlt)) {
      return _repairAndReturn(JSON.parse(fs.readFileSync(karaokeLrcAlt, 'utf8')));
    }
  } catch (e) { /* ignore */ }
  return null;
}

function getLrcJsonPath(videoId) {
  const base = String(videoId || '').replace(/-karaoke$/, '');
  const candidates = [
    path.join(LIBRARY_KARAOKE_DIR, base + '-karaoke.lrc.json'),
    path.join(LIBRARY_KARAOKE_DIR, videoId + '.lrc.json'),
    path.join(LIBRARY_KARAOKE_DIR, videoId + '-karaoke.lrc.json'),
    path.join(LIBRARY_DIR, videoId + '.lrc.json'),
    path.join(LIBRARY_DIR, base + '-karaoke.lrc.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Human-readable lyric provenance for UI badges. */
function getLyricProvenance(videoId) {
  const lrcPath = getLrcJsonPath(videoId);
  if (!lrcPath) {
    return { hasLyrics: false, source: '', label: 'No lyrics', alignMode: '', path: null };
  }
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(lrcPath, 'utf8'));
  } catch {
    return { hasLyrics: false, source: '', label: 'No lyrics', alignMode: '', path: lrcPath };
  }
  const mode = String(data.alignMode || data.source || '').toLowerCase();
  const edited = !!(data.manuallyEdited || mode.includes('edited') || mode.includes('manual'));
  let source = 'unknown';
  let label = 'Lyrics';
  if (mode.startsWith('lrclib_synced') || (mode.includes('lrclib') && mode.includes('synced'))) {
    source = 'lrclib_synced';
    label = 'LRCLIB synced';
  } else if (mode.includes('lrclib') && (mode.includes('+force') || mode.includes('+align'))) {
    source = 'lrclib_whisper';
    label = 'LRCLIB+Whisper';
  } else if (mode.includes('lrclib') && mode.includes('approx')) {
    source = 'lrclib_approx';
    label = 'LRCLIB approx';
  } else if (mode.includes('lrclib')) {
    source = 'lrclib_plain';
    label = 'LRCLIB';
  } else if (mode === 'reconcile+force' || mode.endsWith('+force')) {
    source = 'force_align';
    label = 'Force-align';
  } else if (mode.endsWith('+align') || mode.includes('whisper')) {
    source = 'whisper';
    label = 'Whisper';
  } else if (mode.includes('approx')) {
    source = 'approx';
    label = 'Approx';
  } else if (mode.includes('karaoke')) {
    source = 'karaoke_captions';
    label = 'YT karaoke';
  } else if (mode.includes('embedded')) {
    source = 'embedded';
    label = 'Embedded';
  } else if ((data.lines || []).length) {
    source = 'unknown';
    label = 'Lyrics';
  } else {
    return { hasLyrics: false, source: '', label: 'No lyrics', alignMode: mode, path: lrcPath };
  }
  if (edited) {
    label = label + ' · edited';
    source = source + '_edited';
  }
  return {
    hasLyrics: true,
    source,
    label,
    alignMode: data.alignMode || data.source || '',
    lrclibId: data.lrclibId || null,
    lineCount: (data.lines || []).length,
    path: lrcPath,
    manuallyEdited: edited,
  };
}

function _rebuildLineWords(line) {
  const text = String(line.text || '').trim();
  const start = Number(line.startTime) || 0;
  const end = Number(line.endTime);
  const safeEnd = Number.isFinite(end) && end > start ? end : start + Math.max(0.4, text.split(/\s+/).length * 0.35);
  const dur = Math.max(safeEnd - start, 0.05);
  const rawWords = text.split(/\s+/).filter(Boolean);
  line.text = text;
  line.startTime = Math.round(start * 1000) / 1000;
  line.endTime = Math.round(safeEnd * 1000) / 1000;
  if (!rawWords.length) {
    line.words = [];
    return line;
  }
  const totalChars = rawWords.reduce((s, w) => s + w.length, 0) || 1;
  let t = start;
  line.words = rawWords.map((w, i) => {
    const share = w.length / totalChars;
    const wDur = share * dur;
    const word = {
      text: w,
      startTime: Math.round(t * 1000) / 1000,
      endTime: Math.round((t + wDur) * 1000) / 1000,
    };
    t += wDur;
    return word;
  });
  line.words[line.words.length - 1].endTime = line.endTime;
  return line;
}

/**
 * Save edited lyric lines while preserving each line's start/end window.
 * Only `text` (and rebuilt `words`) change — timing cues stay put.
 */
function saveLyricsLines(videoId, editedLines) {
  const lrcPath = getLrcJsonPath(videoId);
  if (!lrcPath) return { ok: false, error: 'No LRC file found for ' + videoId };
  if (!Array.isArray(editedLines) || !editedLines.length) {
    return { ok: false, error: 'No lines to save' };
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(lrcPath, 'utf8'));
  } catch (e) {
    return { ok: false, error: 'Failed to read LRC: ' + e.message };
  }
  const existing = data.lines || [];
  if (editedLines.length !== existing.length) {
    return {
      ok: false,
      error: 'Line count must stay the same (' + existing.length + ' lines) so timing stays intact. Got ' + editedLines.length + '.',
    };
  }
  // Backup once before first manual edit
  try {
    const bak = lrcPath + '.pre-edit-bak';
    if (!fs.existsSync(bak)) fs.copyFileSync(lrcPath, bak);
  } catch (e) { /* non-fatal */ }

  const originalMode = data.alignMode || data.source || '';
  if (!data.originalAlignMode && originalMode) data.originalAlignMode = originalMode;

  const newLines = existing.map((oldLine, i) => {
    const incoming = editedLines[i] || {};
    const next = Object.assign({}, oldLine, {
      // Keep original timing windows — never trust client start/end for safety
      startTime: oldLine.startTime,
      endTime: oldLine.endTime,
      text: String(incoming.text != null ? incoming.text : oldLine.text || '').trim(),
    });
    return _rebuildLineWords(next);
  });

  data.lines = newLines;
  data.manuallyEdited = true;
  data.editedAt = new Date().toISOString();
  // Keep provenance readable but mark as edited
  const baseMode = (data.originalAlignMode || originalMode || 'lyrics').replace(/\|edited$/, '');
  data.alignMode = baseMode + '|edited';
  data.source = data.alignMode;

  try {
    fs.writeFileSync(lrcPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    return { ok: false, error: 'Failed to write LRC: ' + e.message };
  }
  return {
    ok: true,
    path: lrcPath,
    lineCount: newLines.length,
    provenance: getLyricProvenance(videoId),
  };
}

function getStatus(videoId) {
  const mp4 = getVideoPath(videoId);
  const exists = fs.existsSync(mp4);
  const info = exists ? getMetadata(videoId) : null;
  const lyrics = exists ? getLyrics(videoId) : null;
  return {
    exists,
    path: exists ? mp4 : null,
    size: exists ? fs.statSync(mp4).size : 0,
    metadata: info,
    hasLyrics: !!lyrics,
  };
}

// ── Cache management ──

function tryLoadCacheFromDisk() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return false;
    const rawJson = fs.readFileSync(CACHE_FILE, 'utf8');
    const result = JSON.parse(rawJson);
    if (result && result.ok) {
      __libraryListCache = { ts: Date.now(), data: result, rawJson, archiveMtime: result.archiveMtime || 0 };
      console.log('[library] Loaded from disk: ' + result.count + ' videos');
      return true;
    }
  } catch (e) { console.error('[library] Failed to load cache:', e.message); }
  return false;
}

function buildLibraryCache() {
  if (__libraryScanInFlight) return __libraryScanInFlight;
  __libraryScanInFlight = new Promise((resolve) => {
    const worker = execFile(
      '/opt/homebrew/bin/node',
      [path.join('/Users/macdonk/Documents/GitHub/Karol', 'api-server', 'library-scan-worker.js'), ARCHIVE_PATH, LIBRARY_DIR, DOWNLOADS_DIR, TAGS_PATH],
      { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
      async (err, stdout, stderr) => {
        if (stderr) console.error('[library] Worker stderr:', stderr.trim());
        let rawJson = null;
        try { rawJson = await fs.promises.readFile(CACHE_FILE, 'utf8'); } catch (e) {}
        let result = null;
        try { result = rawJson ? JSON.parse(rawJson) : null; } catch (e) { console.error('[library] Parse error:', e.message); }
        if (result && result.ok) {
          __libraryListCache = { ts: Date.now(), data: result, rawJson: rawJson, archiveMtime: result.archiveMtime || 0 };
          console.log('[library] Cache built: ' + result.count + ' videos');
        } else {
          console.error('[library] Worker failed:', err ? err.message : 'no result');
        }
        __libraryScanInFlight = null;
        resolve(result);
      }
    );
  });
  return __libraryScanInFlight;
}

// ── Public API ──

function init() {
  return new Promise((resolve) => {
    tryLoadCacheFromDisk();
    if (!__libraryListCache.data) {
      console.log('[library] No cache — starting background scan...');
      buildLibraryCache().then(() => {
        tryLoadCacheFromDisk();
        console.log('[library] Background scan complete');
        resolve();
      }).catch(e => {
        console.error('[library] Background scan failed:', e.message);
        resolve();
      });
    } else {
      resolve();
    }
  });
}

function list(opts) {
  if (!__libraryListCache.data) {
    return { ok: false, error: 'Library scan in progress — retry in a few seconds' };
  }

  const q = (opts.q || '').toLowerCase();
  const year = opts.year || '';
  const tag = opts.tag || '';
  const page = parseInt(opts.page, 10) || 1;
  const limit = parseInt(opts.limit, 10) || 0;

  const hasQuery = q || year || tag || page > 1 || limit > 0;
  if (!hasQuery) {
    // Fast path: return full cached data
    return JSON.parse(JSON.stringify(__libraryListCache.data));
  }

  let videos = __libraryListCache.data.videos || [];
  if (q) {
    videos = videos.filter(v =>
      (v.title || '').toLowerCase().includes(q) ||
      (v.artist || '').toLowerCase().includes(q) ||
      String(v.year || '').includes(q)
    );
  }
  if (year) {
    videos = videos.filter(v => String(v.year) === year);
  }
  if (tag) {
    videos = videos.filter(v => (v.tag || '') === tag);
  }
  const total = videos.length;
  if (limit > 0) {
    const start = (page - 1) * limit;
    videos = videos.slice(start, start + limit);
  }

  return {
    ok: true,
    count: total,
    page: page,
    limit: limit || total,
    videos,
  };
}

function getTags() {
  return loadTags();
}

function setTag(videoId, tag) {
  const tags = loadTags();
  tags[videoId] = { tag, year: '', artist: '', source: 'manual' };
  saveTags(tags);
  return true;
}

function getDownloadDir(videoId) {
  const tags = loadTags();
  const tag = tags[videoId]?.tag;
  if (tag === 'karaoke') return LIBRARY_KARAOKE_DIR;
  if (tag === 'song' || tag === 'music') return LIBRARY_SONGS_DIR;
  return LIBRARY_DIR;
}

async function scanSummary() {
  let totalMp4Files = 0;
  let totalSize = 0;
  const langSet = new Set();

  for (const dir of [LIBRARY_DIR, LIBRARY_KARAOKE_DIR, LIBRARY_SONGS_DIR, DOWNLOADS_DIR]) {
    try { await fs.promises.access(dir); } catch (e) { continue; }
    const files = await fs.promises.readdir(dir);
    for (const f of files) {
      if (f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.mp3') || f.endsWith('.webm')) {
        totalMp4Files++;
        try {
          const stat = await fs.promises.stat(path.join(dir, f));
          totalSize += stat.size;
        } catch (e) { /* skip */ }
      }
    }
  }

  return { ok: true, totalFiles: totalMp4Files, totalSize, subtitleLanguages: [...langSet] };
}

module.exports = {
  init,
  list,
  getTags,
  setTag,
  getMetadata,
  getVideoPath,
  getFilePath,
  getInfoPath,
  getThumbPath,
  getLyrics,
  getLyricProvenance,
  getLrcJsonPath,
  saveLyricsLines,
  getStatus,
  getDownloadDir,
  scanSummary,
  LIBRARY_DIR,
  LIBRARY_KARAOKE_DIR,
  LIBRARY_SONGS_DIR,
  DOWNLOADS_DIR,
  ARCHIVE_PATH,
  TAGS_PATH,
};
