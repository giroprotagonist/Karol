// Karol Electron — Library Module
// Video file scanning, caching, metadata, lyrics, tags.
// Ported from api-server/index.js — stripped of all HTTP/routing.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Resolve modules in both dev (repo checkout) and packaged Electron layouts.
function requireFirst(candidates, label) {
  let lastErr = null;
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (e) {
      lastErr = e;
    }
  }
  console.error('[library] Failed to load', label, lastErr && lastErr.message);
  return null;
}

const mysql = requireFirst([
  path.join(__dirname, '..', 'api-server', 'karol-mysql'),
  path.join(process.resourcesPath || '', 'api-server', 'karol-mysql'),
  '../api-server/karol-mysql',
], 'karol-mysql') || {
  tagSet: async () => {},
  catalogGetPublic: async () => null,
  catalogUpsertBatch: async () => {},
  catalogGetMedia: async () => null,
};

const mediaResolverMod = requireFirst([
  path.join(__dirname, 'media-resolver'),
  path.join(__dirname, '..', 'media-resolver'),
  path.join(process.resourcesPath || '', 'media-resolver'),
  '../media-resolver',
], 'media-resolver');
const createMediaResolver = mediaResolverMod && mediaResolverMod.createMediaResolver
  ? mediaResolverMod.createMediaResolver
  : () => ({
    findExisting: () => null,
    resolve: async () => null,
  });

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

/**
 * Probe external drive. Distinguishes:
 *  - unplugged
 *  - ghost /Volumes/maxone folder (blocks remount)
 *  - mounted but TCC/permission blocked (Removable Volumes)
 *  - mounted and readable
 */
function probeDrive() {
  const out = { mounted: false, readable: false, ghost: false, error: '', errorCode: '' };
  try {
    if (!fs.existsSync(EXTERNAL_DRIVE)) {
      out.error = 'not_mounted';
      return out;
    }
    const driveStat = fs.statSync(EXTERNAL_DRIVE);
    if (!driveStat.isDirectory()) {
      out.error = 'not_directory';
      return out;
    }
    const volumesStat = fs.statSync('/Volumes');
    // Ghost /Volumes/maxone (created while unplugged) shares /Volumes' device id.
    if (driveStat.dev === volumesStat.dev) {
      out.ghost = true;
      out.error = 'ghost_folder';
      return out;
    }
    out.mounted = true;
    try {
      fs.accessSync(LIBRARY_DIR, fs.constants.R_OK);
      // Cheap readability probe — do NOT readdir karaoke/ (20k+ entries) here.
      fs.readdirSync(LIBRARY_DIR, { withFileTypes: false }).slice(0, 1);
      out.readable = true;
    } catch (e) {
      out.errorCode = e.code || '';
      out.error = (e.code === 'EPERM' || e.code === 'EACCES')
        ? 'permission'
        : (e.message || 'unreadable');
    }
  } catch (e) {
    out.errorCode = e.code || '';
    out.error = e.message || 'probe_failed';
  }
  return out;
}

/** True only when EXTERNAL_DRIVE is a real mount, not a ghost folder under /Volumes. */
function isDriveMounted() {
  return probeDrive().mounted;
}

function ensureLibraryDirs() {
  const probe = probeDrive();
  if (!probe.mounted || !probe.readable) return false;
  for (const d of [LIBRARY_DIR, LIBRARY_KARAOKE_DIR, LIBRARY_SONGS_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
  }
  return true;
}

// Ensure directories exist only when the external volume is actually mounted.
ensureLibraryDirs();

// ── Internal state ──
let __libraryListCache = { ts: 0, data: null, rawJson: null, archiveMtime: 0 };
let __libraryScanInFlight = null;
const LIBRARY_LIST_CACHE_MS = 60_000; // rescan every 60 seconds
let _rebuildTagsInFlight = null;
let _tagsSyncScheduled = false;
let _scanListener = null;
let __scanState = {
  status: 'idle', // idle | scanning | ready | error
  driveMounted: false,
  drivePath: EXTERNAL_DRIVE,
  libraryDir: LIBRARY_DIR,
  catalogCount: 0,
  diskMediaCount: 0,
  diskByFolder: {},
  startedAt: 0,
  finishedAt: 0,
  error: '',
  message: '',
};

function setScanListener(fn) {
  _scanListener = typeof fn === 'function' ? fn : null;
}

function emitScan( partial ) {
  __scanState = { ...__scanState, ...partial, drivePath: EXTERNAL_DRIVE, libraryDir: LIBRARY_DIR };
  if (_scanListener) {
    try { _scanListener({ ...__scanState }); } catch (e) { console.error('[library] scan listener error:', e.message); }
  }
}

function getScanStatus() {
  return { ...__scanState };
}

let __diskCountCache = { ts: 0, diskMediaCount: 0, diskByFolder: {} };
let __diskCountInFlight = null;
const DISK_COUNT_TTL_MS = 120_000;

/** Fast on-disk media file counts (no metadata parse). Never block startup on this. */
function countDiskMedia(force) {
  if (!force && __diskCountCache.ts && (Date.now() - __diskCountCache.ts) < DISK_COUNT_TTL_MS) {
    return { diskMediaCount: __diskCountCache.diskMediaCount, diskByFolder: { ...__diskCountCache.diskByFolder } };
  }
  const folders = {
    root: LIBRARY_DIR,
    karaoke: LIBRARY_KARAOKE_DIR,
    songs: LIBRARY_SONGS_DIR,
    downloads: DOWNLOADS_DIR,
  };
  const diskByFolder = {};
  let diskMediaCount = 0;
  const mediaExt = /\.(mp4|mkv|mp3|webm)$/i;
  for (const [key, dir] of Object.entries(folders)) {
    let n = 0;
    try {
      if (!fs.existsSync(dir)) { diskByFolder[key] = 0; continue; }
      for (const f of fs.readdirSync(dir)) {
        if (mediaExt.test(f) && !f.startsWith('._')) n++;
      }
    } catch { n = 0; }
    diskByFolder[key] = n;
    diskMediaCount += n;
  }
  __diskCountCache = { ts: Date.now(), diskMediaCount, diskByFolder };
  return { diskMediaCount, diskByFolder };
}

/** Background disk count so the UI/main process stays responsive. */
function scheduleDiskCount(force) {
  if (__diskCountInFlight) return __diskCountInFlight;
  if (!force && __diskCountCache.ts && (Date.now() - __diskCountCache.ts) < DISK_COUNT_TTL_MS) {
    return Promise.resolve(__diskCountCache);
  }
  __diskCountInFlight = new Promise((resolve) => {
    setImmediate(() => {
      try {
        const probe = probeDrive();
        if (probe.mounted && probe.readable) countDiskMedia(true);
      } catch (e) {
        console.error('[library] disk count failed:', e.message);
      }
      __diskCountInFlight = null;
      // Refresh status with new disk numbers (non-force, so no re-walk)
      try { refreshDiskStats({ recount: false }); } catch {}
      resolve(__diskCountCache);
    });
  });
  return __diskCountInFlight;
}

function catalogCountFromMemoryOrDisk() {
  if (__libraryListCache.data) {
    return __libraryListCache.data.count
      || (__libraryListCache.data.videos && __libraryListCache.data.videos.length)
      || 0;
  }
  // Fall back to on-disk cache file so UI isn't stuck at 0 after restart races
  tryLoadCacheFromDisk();
  if (__libraryListCache.data) {
    return __libraryListCache.data.count
      || (__libraryListCache.data.videos && __libraryListCache.data.videos.length)
      || 0;
  }
  return 0;
}

/**
 * Update scan status for the UI. By default does NOT walk the drive
 * (that was freezing Karol on launch). Pass { recount: true } after Rescan.
 */
function refreshDiskStats(opts = {}) {
  const recount = !!opts.recount;
  const probe = probeDrive();
  const mounted = probe.mounted;
  const readable = probe.readable;
  let disk = { diskMediaCount: __diskCountCache.diskMediaCount || 0, diskByFolder: { ...(__diskCountCache.diskByFolder || {}) } };
  if (mounted && readable && recount) {
    disk = countDiskMedia(true);
  } else if (mounted && readable && !__diskCountCache.ts) {
    // Kick a background count once; don't block this call
    scheduleDiskCount(false);
  }
  const catalogCount = catalogCountFromMemoryOrDisk();
  let status = 'idle';
  let message = '';
  let error = '';
  if (__libraryScanInFlight) {
    status = 'scanning';
    message = 'Scanning maxone library…'
      + (disk.diskMediaCount ? (' found ' + disk.diskMediaCount.toLocaleString() + ' media files') : '');
  } else if (!mounted) {
    status = probe.ghost ? 'error' : 'missing';
    message = probe.ghost
      ? 'Ghost folder at /Volumes/maxone — delete it and remount the drive'
      : 'External drive not mounted';
    error = probe.error || 'not_mounted';
  } else if (!readable) {
    status = 'error';
    message = 'maxone is mounted but Karol cannot read files — enable Removable Volumes for Karol in System Settings → Privacy';
    error = 'permission';
  } else if (catalogCount > 0) {
    status = 'ready';
    message = disk.diskMediaCount
      ? ('Library ready — ' + catalogCount.toLocaleString() + ' videos in catalog, '
        + disk.diskMediaCount.toLocaleString() + ' media files on disk')
      : ('Library ready — ' + catalogCount.toLocaleString() + ' videos (counting files on disk…)');
  } else {
    status = 'idle';
    message = 'Drive mounted and readable — waiting for library scan';
  }
  emitScan({
    driveMounted: mounted,
    driveReadable: readable,
    catalogCount,
    diskMediaCount: disk.diskMediaCount,
    diskByFolder: disk.diskByFolder,
    status,
    message,
    error,
  });
  return getScanStatus();
}

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
          // Preserve extra fields (title, duration, …) written by the karaoke
          // pipeline — dropping them here would destroy titles on next save.
          normalized[vid] = {
            ...val,
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
    // Atomic write (temp + rename): a concurrent reader must never observe a
    // partially-written tags.json — a truncated read parses as {} and can
    // trigger a destructive rebuild that loses karaoke-maker provenance.
    const tmpPath = TAGS_PATH + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(tags, null, 2), 'utf8');
    fs.renameSync(tmpPath, TAGS_PATH);
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
              // '<id>-karaoke' files are only ever produced by the local
              // karaoke pipeline, so the suffix itself is durable provenance —
              // the Custom library filter keys off source === 'karaoke-maker'.
              const isPipelineOutput = /^[A-Za-z0-9_-]{11}-karaoke$/.test(videoId);
              tags[videoId] = {
                tag: autoTag,
                year: (info.upload_date || '').slice(0, 4),
                artist: info.uploader || '',
                source: isPipelineOutput ? 'karaoke-maker' : 'rebuilt-from-info.json'
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
  return mediaResolver.findExisting(videoId);
}

async function resolveFilePath(videoId) {
  return mediaResolver.resolve(videoId);
}

const mediaResolver = createMediaResolver({
  findLocal(videoId) {
    const p = getVideoPath(videoId);
    return (p && fs.existsSync(p)) ? p : null;
  },
  catalogLookup: (videoId) => mysql.catalogGetMedia(videoId),
});

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
    if (result && result.ok && result.count > 0) {
      __libraryListCache = { ts: Date.now(), data: result, rawJson, archiveMtime: result.archiveMtime || 0 };
      console.log('[library] Loaded from disk: ' + result.count + ' videos');
      return true;
    }
  } catch (e) { console.error('[library] Failed to load cache:', e.message); }
  return false;
}

function buildLibraryCache() {
  if (__libraryScanInFlight) return __libraryScanInFlight;
  const probe = probeDrive();
  emitScan({
    status: 'scanning',
    startedAt: Date.now(),
    finishedAt: 0,
    error: '',
    driveMounted: probe.mounted,
    driveReadable: probe.readable,
    diskMediaCount: __diskCountCache.diskMediaCount || 0,
    diskByFolder: __diskCountCache.diskByFolder || {},
    catalogCount: catalogCountFromMemoryOrDisk(),
    message: 'Scanning maxone library in background…',
  });
  // Disk file counts in parallel — do not block spawning the worker
  scheduleDiskCount(true);
  __libraryScanInFlight = new Promise((resolve) => {
    const workerCandidates = [
      path.resolve(__dirname, '..', 'api-server', 'library-scan-worker.js'),
      path.resolve(__dirname, '..', '..', 'api-server', 'library-scan-worker.js'),
      path.join('/Users/macdonk/Documents/GitHub/Karol', 'api-server', 'library-scan-worker.js'),
      // Packaged app: worker ships next to api-server under Resources
      (typeof process !== 'undefined' && process.resourcesPath)
        ? path.join(process.resourcesPath, 'api-server', 'library-scan-worker.js')
        : '',
    ].filter(Boolean);
    const workerPath = workerCandidates.find(p => fs.existsSync(p)) || workerCandidates[0];
    if (!fs.existsSync(workerPath)) {
      const msg = 'library-scan-worker.js not found';
      console.error('[library]', msg);
      __libraryScanInFlight = null;
      emitScan({ status: 'error', error: msg, finishedAt: Date.now(), message: msg });
      resolve(null);
      return;
    }
    console.log('[library] Scan worker:', workerPath);
    execFile(
      '/opt/homebrew/bin/node',
      [workerPath, ARCHIVE_PATH, LIBRARY_DIR, DOWNLOADS_DIR, TAGS_PATH],
      { timeout: 180_000, maxBuffer: 20 * 1024 * 1024 },
      async (err, stdout, stderr) => {
        if (stderr) console.error('[library] Worker stderr:', stderr.trim());
        let rawJson = null;
        try { rawJson = await fs.promises.readFile(CACHE_FILE, 'utf8'); } catch (e) {}
        let result = null;
        try { result = rawJson ? JSON.parse(rawJson) : null; } catch (e) { console.error('[library] Parse error:', e.message); }
        // Prefer cached disk counts; refresh in background
        const diskAfter = {
          diskMediaCount: __diskCountCache.diskMediaCount || 0,
          diskByFolder: __diskCountCache.diskByFolder || {},
        };
        scheduleDiskCount(false);
        if (result && result.ok && result.count > 0) {
          __libraryListCache = { ts: Date.now(), data: result, rawJson: rawJson, archiveMtime: result.archiveMtime || 0 };
          console.log('[library] Cache built: ' + result.count + ' videos');
          __libraryScanInFlight = null;
          emitScan({
            status: 'ready',
            catalogCount: result.count || 0,
            diskMediaCount: diskAfter.diskMediaCount,
            diskByFolder: diskAfter.diskByFolder,
            finishedAt: Date.now(),
            error: '',
            driveMounted: probeDrive().mounted,
            driveReadable: probeDrive().readable,
            message: 'Scan complete — ' + (result.count || 0).toLocaleString() + ' videos in library',
          });
        } else {
          // Keep prior good cache if worker failed / empty race
          tryLoadCacheFromDisk();
          const failMsg = err ? err.message : 'scan produced no result';
          console.error('[library] Worker failed:', failMsg);
          __libraryScanInFlight = null;
          const catalogCount = catalogCountFromMemoryOrDisk();
          emitScan({
            status: catalogCount > 0 ? 'ready' : 'error',
            catalogCount,
            diskMediaCount: diskAfter.diskMediaCount,
            diskByFolder: diskAfter.diskByFolder,
            finishedAt: Date.now(),
            error: catalogCount > 0 ? '' : failMsg,
            driveMounted: probeDrive().mounted,
            driveReadable: probeDrive().readable,
            message: catalogCount > 0
              ? ('Using previous library cache — ' + catalogCount.toLocaleString() + ' videos')
              : ('Scan failed — ' + failMsg),
          });
        }
        resolve(result);
      }
    );
  });
  return __libraryScanInFlight;
}

// ── Public API ──

function init(force) {
  return new Promise((resolve) => {
    if (force) {
      __libraryListCache = { ts: 0, data: null, rawJson: null, archiveMtime: 0 };
    }
    const hadCache = tryLoadCacheFromDisk();
    // Instant status for UI — never block launch on a full drive walk
    const status = refreshDiskStats({ recount: false });
    if (force || !__libraryListCache.data) {
      console.log('[library] Starting library scan…', force ? '(forced)' : '(no cache)');
      buildLibraryCache().then(() => {
        tryLoadCacheFromDisk();
        refreshDiskStats({ recount: false });
        scheduleDiskCount(true);
        console.log('[library] Background scan complete');
        resolve(getScanStatus());
      }).catch(e => {
        console.error('[library] Background scan failed:', e.message);
        emitScan({ status: 'error', error: e.message, finishedAt: Date.now(), message: 'Scan failed — ' + e.message });
        resolve(getScanStatus());
      });
    } else {
      emitScan({
        status: 'ready',
        catalogCount: __libraryListCache.data.count || 0,
        finishedAt: Date.now(),
        driveMounted: status.driveMounted,
        driveReadable: status.driveReadable,
        message: 'Loaded library cache — ' + (__libraryListCache.data.count || 0).toLocaleString() + ' videos',
      });
      scheduleDiskCount(false);
      resolve(getScanStatus());
    }
  });
}

function list(opts) {
  if (!__libraryListCache.data) {
    // Another process / prior session may have already built the cache file.
    tryLoadCacheFromDisk();
  }
  if (!__libraryListCache.data) {
    if (__libraryScanInFlight) {
      return { ok: false, error: 'Library scan in progress — retry in a few seconds', scanning: true };
    }
    return { ok: false, error: 'Library not loaded yet — click Rescan', scanning: false };
  }

  const q = (opts.q || '').toLowerCase();
  const year = opts.year || '';
  const tag = opts.tag || '';
  const page = parseInt(opts.page, 10) || 1;
  const limit = parseInt(opts.limit, 10) || 0;

  const hasQuery = q || year || tag || page > 1 || limit > 0;
  if (!hasQuery) {
    // Fast path: return cached data without a deep clone of 4k+ rows
    // (JSON round-trip was freezing the UI for seconds on every load).
    const cached = __libraryListCache.data;
    return {
      ok: true,
      count: cached.count || (cached.videos ? cached.videos.length : 0),
      videos: cached.videos || [],
      archiveMtime: cached.archiveMtime || 0,
    };
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

// Merge fields into a tag entry without clobbering existing non-empty values.
// Used to persist resolved titles for remote-only music videos.
function mergeTagMeta(videoId, fields) {
  const tags = loadTags();
  const existing = tags[videoId] || { tag: 'music', year: '', artist: '', source: '' };
  const merged = { ...existing };
  for (const [k, v] of Object.entries(fields || {})) {
    if (v !== '' && v != null && !existing[k]) merged[k] = v;
  }
  tags[videoId] = merged;
  saveTags(tags);
  return true;
}

// Batch variant: one load + one atomic save for many ids (tags.json is large;
// per-id writes were a major slowdown when resolving titles in bulk).
function mergeTagMetaBatch(byId) {
  const tags = loadTags();
  let changed = false;
  for (const [videoId, fields] of Object.entries(byId || {})) {
    const existing = tags[videoId] || { tag: 'music', year: '', artist: '', source: '' };
    const merged = { ...existing };
    for (const [k, v] of Object.entries(fields || {})) {
      if (v !== '' && v != null && !existing[k]) { merged[k] = v; changed = true; }
    }
    tags[videoId] = merged;
  }
  if (changed) saveTags(tags);
  return true;
}

function setTag(videoId, tag) {
  const tags = loadTags();
  // Merge — keep title/artist/year/source written by other sources. Never
  // demote a karaoke-maker provenance stamp to 'manual'.
  const existing = tags[videoId] || {};
  const keepSource = existing.source === 'karaoke-maker' ? 'karaoke-maker' : 'manual';
  tags[videoId] = { year: '', artist: '', ...existing, tag, source: keepSource };
  saveTags(tags);
  return true;
}

// DJ reclassification: unlike setTag/mergeTagMeta (which preserve provenance /
// only fill empties), this OVERWRITES tag and source as requested — moving a
// track between Karaoke / Custom / Music Video buckets is an explicit intent.
// Other fields (title, artist, year, …) are preserved.
function reclassify(videoId, { tag, source } = {}) {
  if (!videoId || !tag) return { ok: false, error: 'videoId and tag required' };
  const tags = loadTags();
  const existing = tags[videoId] || { tag: 'music', year: '', artist: '', source: '' };
  const next = { ...existing, tag };
  if (source != null) next.source = source;
  tags[videoId] = next;
  saveTags(tags);
  // Stale-mark the list cache so the next scan republishes the new tag
  __libraryListCache.ts = 0;
  // Durable MySQL write, immediate + best-effort (same paths the tag sync
  // uses): library_tags for base ids, song_catalog tag/source via
  // read-modify-write so upsert_batch doesn't blank other columns.
  _syncReclassifyToMysql(videoId, next).catch((e) => {
    console.error('[library/tags] reclassify MySQL sync failed:', e.message);
  });
  return { ok: true, videoId, tag: next.tag, source: next.source || '' };
}

async function _syncReclassifyToMysql(videoId, entry) {
  // library_tags (tagSet itself skips variant/invalid ids)
  try {
    await mysql.tagSet(videoId, entry.tag || 'music', entry.artist || '', entry.year || '', entry.source || '');
  } catch (e) {
    console.error('[library/tags] MySQL tagSet failed:', videoId, e.message);
  }
  // song_catalog: upsert_batch overwrites title/artist/year/duration/thumbnail,
  // so re-send the existing row's values with only tag/source changed.
  try {
    const row = await mysql.catalogGetPublic(videoId);
    if (row && row.title) {
      await mysql.catalogUpsertBatch([{
        video_id: videoId,
        title: row.title,
        artist: row.artist || '',
        year: row.year || 0,
        duration: row.duration || 0,
        tag: entry.tag || 'music',
        source: entry.source || '',
        thumbnail_url: row.thumbnail || '',
        size_bytes: row.size || 0,
        r2_uploaded: row.cloudBacked ? 1 : 0,
        available_local: row.availableLocal != null ? (row.availableLocal ? 1 : 0) : 1,
      }]);
    }
  } catch (e) {
    console.error('[library/tags] MySQL catalog sync failed:', videoId, e.message);
  }
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

function invalidateListCache() {
  __libraryListCache = { ts: 0, data: null, rawJson: null, archiveMtime: 0 };
}

module.exports = {
  init,
  list,
  getTags,
  mergeTagMeta,
  mergeTagMetaBatch,
  setTag,
  reclassify,
  getMetadata,
  getVideoPath,
  getFilePath,
  resolveFilePath,
  getInfoPath,
  getThumbPath,
  getLyrics,
  getLyricProvenance,
  getLrcJsonPath,
  saveLyricsLines,
  getStatus,
  getDownloadDir,
  scanSummary,
  isDriveMounted,
  probeDrive,
  ensureLibraryDirs,
  invalidateListCache,
  setScanListener,
  getScanStatus,
  refreshDiskStats,
  scheduleDiskCount,
  countDiskMedia,
  tryLoadCacheFromDisk,
  EXTERNAL_DRIVE,
  LIBRARY_DIR,
  LIBRARY_KARAOKE_DIR,
  LIBRARY_SONGS_DIR,
  DOWNLOADS_DIR,
  ARCHIVE_PATH,
  TAGS_PATH,
};
