// Karol Electron — Library Module
// Video file scanning, caching, metadata, lyrics, tags.
// Ported from api-server/index.js — stripped of all HTTP/routing.

const fs = require('fs');
const path = require('path');
const os = require('os');
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

/** Old Deskreen app kept Music Videos on the Mac — still where most of the ~600 live. */
const LEGACY_SONGS_DIR_CANDIDATES = [
  path.join(os.homedir(), 'Documents', 'GitHub', 'deskreen', '.deskreen', 'library', 'songs'),
  path.resolve(__dirname, '..', '..', 'deskreen', '.deskreen', 'library', 'songs'),
  path.resolve(__dirname, '..', '.deskreen', 'library', 'songs'),
];
function resolveExistingDirs(candidates) {
  const out = [];
  const seen = new Set();
  for (const d of candidates) {
    try {
      const abs = path.resolve(d);
      if (seen.has(abs)) continue;
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue;
      seen.add(abs);
      out.push(abs);
    } catch (_) {}
  }
  return out;
}
const LEGACY_SONGS_DIRS = resolveExistingDirs(LEGACY_SONGS_DIR_CANDIDATES);
if (LEGACY_SONGS_DIRS.length) {
  console.log('[library] Legacy Deskreen songs dirs:', LEGACY_SONGS_DIRS.join(', '));
}

// All library directories to search for files (USB first, then legacy Mac songs/)
const LIBRARY_SEARCH_DIRS = [LIBRARY_DIR, LIBRARY_KARAOKE_DIR, LIBRARY_SONGS_DIR, ...LEGACY_SONGS_DIRS];
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
      // accessSync only — never readdir here. ExFAT USB readdir can hang the
      // Electron main process for minutes and block API/window startup.
      fs.accessSync(LIBRARY_DIR, fs.constants.R_OK);
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

// Do NOT call ensureLibraryDirs() at module load — mkdir on a stalled ExFAT
// volume blocks Electron before app.whenReady (and before the API can fork).

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
        if (f.startsWith('._') || f === '.DS_Store') continue;
        if (mediaExt.test(f)) n++;
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
    // Do NOT auto-kick disk counts on ExFAT/USB — readdirSync of karaoke/
    // can freeze the Electron main process (and IPC) for minutes.
    // Disk counts run only when explicitly requested (Rescan / recount:true).
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
                upload_date: info.upload_date || '',
                title: info.title || '',
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

/**
 * Search order for a media id. Karaoke variants live under karaoke/;
 * base (Music Video) ids prefer songs/ so a leftover pipeline input
 * `karaoke/{id}.mp4` never shadows the real MV in songs/.
 */
function _mediaSearchDirsForId(videoId) {
  const id = String(videoId || '');
  if (/-karaoke$/.test(id)) {
    return [LIBRARY_KARAOKE_DIR, LIBRARY_DIR, LIBRARY_SONGS_DIR, ...LEGACY_SONGS_DIRS];
  }
  return [LIBRARY_SONGS_DIR, ...LEGACY_SONGS_DIRS, LIBRARY_DIR, LIBRARY_KARAOKE_DIR];
}

function getVideoPath(videoId) {
  const MIN_BYTES = 50_000; // skip 0-byte / truncated ghosts that poison USB root
  const id = String(videoId || '');
  for (const dir of _mediaSearchDirsForId(id)) {
    try {
      if (!fs.existsSync(dir)) continue;
    } catch (_) { continue; }
    for (const ext of VIDEO_EXTS) {
      const exact = path.join(dir, id + ext);
      try {
        if (fs.existsSync(exact) && fs.statSync(exact).size >= MIN_BYTES) return exact;
      } catch (_) { /* ignore */ }
    }
  }
  return path.join(LIBRARY_DIR, id + '.mp4');
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
function _repairLinesArray(lines, alignMode, manuallyEdited) {
  if (!Array.isArray(lines)) return 0;
  if (alignMode === 'reconcile+force') return 0;
  if (manuallyEdited || String(alignMode || '').includes('|edited')) return 0;
  let fixed = 0;
  for (const line of lines) {
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
  return fixed;
}

/**
 * Resolve primary/secondary/tertiary lyric tracks for multi-line display.
 * Backward compatible: legacy files with only top-level `lines` → primary only.
 *
 * Visual stack (HDMI): tertiary ABOVE primary (e.g. Thai script), primary
 * (sing/highlight line, e.g. RTGS), secondary BELOW (e.g. English).
 */
function resolveLyricDisplay(lrc) {
  if (!lrc || typeof lrc !== 'object') {
    return {
      primaryLines: [], secondaryLines: null, tertiaryLines: null,
      primaryKey: null, secondaryKey: null, tertiaryKey: null, display: null,
    };
  }
  const tracks = lrc.tracks && typeof lrc.tracks === 'object' ? lrc.tracks : null;
  const display = lrc.display && typeof lrc.display === 'object'
    ? lrc.display
    : (tracks ? { primary: 'sung', secondary: 'english' } : null);

  if (!tracks) {
    return {
      primaryLines: Array.isArray(lrc.lines) ? lrc.lines : [],
      secondaryLines: null,
      tertiaryLines: null,
      primaryKey: null,
      secondaryKey: null,
      tertiaryKey: null,
      display: null,
    };
  }

  // Prefer explicit display keys; fall back sensibly for Asian / Latin mixes
  let primaryKey = display && display.primary;
  let secondaryKey = display && display.secondary;
  let tertiaryKey = display && display.tertiary;
  if (!primaryKey || !tracks[primaryKey]) {
    if (tracks.romanized) primaryKey = 'romanized';
    else if (tracks.sung) primaryKey = 'sung';
    else if (tracks.english) primaryKey = 'english';
    else primaryKey = Object.keys(tracks)[0] || null;
  }
  if (!secondaryKey || !tracks[secondaryKey] || secondaryKey === primaryKey) {
    if (tracks.english && primaryKey !== 'english') secondaryKey = 'english';
    else if (tracks.sung && primaryKey !== 'sung') secondaryKey = 'sung';
    else secondaryKey = null;
  }
  if (!tertiaryKey || !tracks[tertiaryKey]
      || tertiaryKey === primaryKey || tertiaryKey === secondaryKey) {
    // Auto tertiary: native/sung Thai (or other native script) above RTGS+English
    if (primaryKey === 'romanized') {
      if (tracks.native && secondaryKey !== 'native') tertiaryKey = 'native';
      else if (tracks.sung && secondaryKey !== 'sung') tertiaryKey = 'sung';
      else tertiaryKey = null;
    } else {
      tertiaryKey = null;
    }
  }

  const primaryLines = (primaryKey && tracks[primaryKey] && Array.isArray(tracks[primaryKey].lines))
    ? tracks[primaryKey].lines
    : (Array.isArray(lrc.lines) ? lrc.lines : []);
  const secondaryLines = (secondaryKey && tracks[secondaryKey] && Array.isArray(tracks[secondaryKey].lines)
    && tracks[secondaryKey].lines.length)
    ? tracks[secondaryKey].lines
    : null;
  const tertiaryLines = (tertiaryKey && tracks[tertiaryKey] && Array.isArray(tracks[tertiaryKey].lines)
    && tracks[tertiaryKey].lines.length)
    ? tracks[tertiaryKey].lines
    : null;

  return {
    primaryLines,
    secondaryLines,
    tertiaryLines,
    primaryKey,
    secondaryKey,
    tertiaryKey,
    display: { primary: primaryKey, secondary: secondaryKey, tertiary: tertiaryKey || null },
  };
}

/**
 * Normalize an LRC object for consumers: set top-level `lines` to the primary
 * track (legacy) and attach secondary/tertiary lines for the player.
 */
function normalizeLyricTracks(lrc) {
  if (!lrc || typeof lrc !== 'object') return lrc;
  const resolved = resolveLyricDisplay(lrc);
  // Mirror primary into top-level lines for older callers
  lrc.lines = resolved.primaryLines || [];
  lrc.secondaryLines = resolved.secondaryLines;
  lrc.tertiaryLines = resolved.tertiaryLines;
  lrc.display = resolved.display || lrc.display || null;
  lrc.primaryTrack = resolved.primaryKey;
  lrc.secondaryTrack = resolved.secondaryKey;
  lrc.tertiaryTrack = resolved.tertiaryKey;
  return lrc;
}

/**
 * Merge a newly generated single-track LRC into an existing multi-track file
 * without destroying other tracks. `trackKey` defaults to 'sung'.
 */
function mergeLyricTrack(existingLrc, incomingLrc, trackKey, opts) {
  const key = trackKey || 'sung';
  const options = opts || {};
  const base = existingLrc && typeof existingLrc === 'object'
    ? JSON.parse(JSON.stringify(existingLrc))
    : {};
  const incoming = incomingLrc && typeof incomingLrc === 'object' ? incomingLrc : {};
  const incomingLines = Array.isArray(incoming.lines) ? incoming.lines : [];

  if (!base.tracks || typeof base.tracks !== 'object') base.tracks = {};

  // Migrate legacy top-level lines into a track once, if needed
  if (Array.isArray(base.lines) && base.lines.length && !Object.keys(base.tracks).length) {
    const legacyKey = options.legacyAs || 'english';
    base.tracks[legacyKey] = {
      lang: legacyKey === 'english' ? 'en' : '',
      label: legacyKey === 'english' ? 'English' : 'As sung',
      role: legacyKey === 'english' ? 'translation' : 'primary',
      lines: base.lines,
      alignMode: base.alignMode || base.source || '',
    };
  }

  // Never clobber a protected track unless explicitly forced
  const protectEnglish = options.protectEnglish !== false;
  if (protectEnglish && key === 'english' && base.tracks.english
      && Array.isArray(base.tracks.english.lines) && base.tracks.english.lines.length
      && !options.force) {
    return normalizeLyricTracks(base);
  }

  base.tracks[key] = {
    lang: options.lang || (key === 'english' ? 'en' : (base.tracks[key] && base.tracks[key].lang) || ''),
    label: options.label || (key === 'english' ? 'English' : key === 'romanized' ? 'Romanized' : 'As sung'),
    role: options.role || (key === 'english' ? 'translation' : 'primary'),
    lines: incomingLines,
    alignMode: incoming.alignMode || incoming.source || '',
  };

  // Carry metadata
  if (incoming.videoId) base.videoId = incoming.videoId;
  if (incoming.duration != null) base.duration = incoming.duration;
  if (incoming.title) base.title = base.title || incoming.title;
  if (incoming.artist) base.artist = base.artist || incoming.artist;
  if (incoming.lrclibId != null && key !== 'english') base.lrclibId = incoming.lrclibId;

  const displayPrimary = options.displayPrimary
    || (key === 'romanized' ? 'romanized' : (key === 'sung' ? 'sung' : (base.display && base.display.primary) || key));
  const displaySecondary = options.displaySecondary != null
    ? options.displaySecondary
    : (base.tracks.english && displayPrimary !== 'english' ? 'english' : null);
  const displayTertiary = options.displayTertiary != null
    ? options.displayTertiary
    : (base.display && base.display.tertiary) || null;
  base.display = {
    primary: displayPrimary,
    secondary: displaySecondary,
    tertiary: displayTertiary,
  };

  // Top-level alignMode reflects primary track provenance
  const primaryTrack = base.tracks[displayPrimary];
  if (primaryTrack && primaryTrack.alignMode) {
    base.alignMode = primaryTrack.alignMode;
    base.source = primaryTrack.alignMode;
  }

  return normalizeLyricTracks(base);
}

function _repairAndReturn(lrc) {
  if (!lrc) return lrc;
  let fixed = 0;
  fixed += _repairLinesArray(lrc.lines, lrc.alignMode, lrc.manuallyEdited);
  if (lrc.tracks && typeof lrc.tracks === 'object') {
    for (const key of Object.keys(lrc.tracks)) {
      const tr = lrc.tracks[key];
      if (!tr || !Array.isArray(tr.lines)) continue;
      fixed += _repairLinesArray(tr.lines, tr.alignMode || lrc.alignMode, lrc.manuallyEdited);
    }
  }
  if (fixed) console.log('[library] Repaired', fixed, 'stale word arrays in lyrics');
  return normalizeLyricTracks(lrc);
}

function getLyrics(videoId) {
  try {
    let data = null;
    const lrcPath = path.join(LIBRARY_DIR, videoId + '.lrc.json');
    if (fs.existsSync(lrcPath)) {
      data = _repairAndReturn(JSON.parse(fs.readFileSync(lrcPath, 'utf8')));
    } else {
      const karaokeLrc = path.join(LIBRARY_KARAOKE_DIR, videoId + '.lrc.json');
      if (fs.existsSync(karaokeLrc)) {
        data = _repairAndReturn(JSON.parse(fs.readFileSync(karaokeLrc, 'utf8')));
      } else {
        const karaokeLrcAlt = path.join(LIBRARY_KARAOKE_DIR, videoId + '-karaoke.lrc.json');
        if (fs.existsSync(karaokeLrcAlt)) {
          data = _repairAndReturn(JSON.parse(fs.readFileSync(karaokeLrcAlt, 'utf8')));
        }
      }
    }
    if (data) {
      const stems = getStemPaths(videoId);
      data.vocalMixAvailable = !!stems.vocalMixAvailable;
      data.hasVocals = !!stems.hasVocals;
      return data;
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
  } else if (data.tracks && Object.keys(data.tracks).some(k => (data.tracks[k].lines || []).length)) {
    source = 'multi_track';
    label = 'Multi-track';
  } else {
    return { hasLyrics: false, source: '', label: 'No lyrics', alignMode: mode, path: lrcPath };
  }
  if (edited) {
    label = label + ' · edited';
    source = source + '_edited';
  }
  const resolved = resolveLyricDisplay(data);
  return {
    hasLyrics: true,
    source,
    label,
    alignMode: data.alignMode || data.source || '',
    lrclibId: data.lrclibId || null,
    lineCount: (resolved.primaryLines || data.lines || []).length,
    path: lrcPath,
    manuallyEdited: edited,
    primaryTrack: resolved.primaryKey,
    secondaryTrack: resolved.secondaryKey,
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
  const resolved = resolveLyricDisplay(data);
  const primaryKey = resolved.primaryKey;
  const existing = resolved.primaryLines.length
    ? resolved.primaryLines
    : (data.lines || []);
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
  if (primaryKey) {
    if (!data.tracks) data.tracks = {};
    if (!data.tracks[primaryKey]) {
      data.tracks[primaryKey] = {
        lang: primaryKey === 'english' ? 'en' : '',
        label: primaryKey === 'english' ? 'English' : primaryKey === 'romanized' ? 'Romanized' : 'As sung',
        role: primaryKey === 'english' ? 'translation' : 'primary',
        lines: newLines,
      };
    } else {
      data.tracks[primaryKey].lines = newLines;
    }
  }
  data.manuallyEdited = true;
  data.editedAt = new Date().toISOString();
  // Keep provenance readable but mark as edited
  const baseMode = (data.originalAlignMode || originalMode || 'lyrics').replace(/\|edited$/, '');
  data.alignMode = baseMode + '|edited';
  data.source = data.alignMode;

  try {
    fs.writeFileSync(lrcPath, JSON.stringify(normalizeLyricTracks(data), null, 2), 'utf8');
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

function getStemPaths(videoId) {
  const base = String(videoId || '').replace(/-karaoke$/, '');
  const vocals = path.join(LIBRARY_KARAOKE_DIR, base + '-karaoke-vocals.wav');
  const instrumental = path.join(LIBRARY_KARAOKE_DIR, base + '-instrumental.wav');
  let hasVocals = false;
  let hasInstrumental = false;
  try { hasVocals = fs.existsSync(vocals) && fs.statSync(vocals).size > 10000; } catch (_) {}
  try { hasInstrumental = fs.existsSync(instrumental) && fs.statSync(instrumental).size > 10000; } catch (_) {}
  // Bundle hint (optional)
  try {
    const bundlePath = path.join(LIBRARY_KARAOKE_DIR, base + '-karaoke.bundle.json');
    if (fs.existsSync(bundlePath)) {
      const b = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
      if (b.hasVocals) hasVocals = hasVocals || !!b.hasVocals;
      if (b.hasInstrumental) hasInstrumental = hasInstrumental || !!b.hasInstrumental;
    }
  } catch (_) {}
  return {
    videoId: base,
    vocals: hasVocals ? vocals : null,
    instrumental: hasInstrumental ? instrumental : null,
    hasVocals,
    hasInstrumental,
    vocalMixAvailable: hasVocals,
  };
}

function getStatus(videoId) {
  const mp4 = getVideoPath(videoId);
  const exists = fs.existsSync(mp4);
  const info = exists ? getMetadata(videoId) : null;
  const lyrics = exists ? getLyrics(videoId) : null;
  const stems = getStemPaths(videoId);
  return {
    exists,
    path: exists ? mp4 : null,
    size: exists ? fs.statSync(mp4).size : 0,
    metadata: info,
    hasLyrics: !!lyrics,
    vocalMixAvailable: !!stems.vocalMixAvailable,
    hasVocals: !!stems.hasVocals,
    hasInstrumental: !!stems.hasInstrumental,
  };
}

// ── Cache management ──

function tryLoadCacheFromDisk() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return false;
    const rawJson = fs.readFileSync(CACHE_FILE, 'utf8');
    const result = JSON.parse(rawJson);
    if (result && result.ok && result.count > 0) {
      attachRatingsFromTags(result.videos || []);
      __libraryListCache = { ts: Date.now(), data: result, rawJson, archiveMtime: result.archiveMtime || 0 };
      console.log('[library] Loaded from disk: ' + result.count + ' videos');
      return true;
    }
  } catch (e) { console.error('[library] Failed to load cache:', e.message); }
  return false;
}

/** Stamp 1–5 star ratings from tags.json onto library list rows (in place). */
function attachRatingsFromTags(videos) {
  if (!Array.isArray(videos) || !videos.length) return videos;
  let tags;
  try { tags = loadTags(); } catch (_) { return videos; }
  for (const v of videos) {
    const vid = String(v.videoId || '');
    const base = vid.replace(/-karaoke$/, '');
    const entry = tags[vid] || tags[base + '-karaoke'] || tags[base] || {};
    const n = Number(entry.rating);
    v.rating = (Number.isFinite(n) && n > 0) ? Math.max(1, Math.min(5, Math.round(n))) : null;
  }
  return videos;
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
      // No scheduleDiskCount here — USB readdir freezes main/IPC.
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
    const probe = probeDrive();
    if (probe.mounted && probe.readable) {
      console.log('[library] maxone ready — auto-starting background scan');
      buildLibraryCache();
      return { ok: false, error: 'Library scan in progress — retry in a few seconds', scanning: true };
    }
    const errMsg = probe.ghost
      ? 'Ghost folder at /Volumes/maxone — delete it and remount the drive'
      : (!probe.mounted
        ? 'Plug in maxone (/Volumes/maxone), then click Rescan'
        : 'maxone mounted but not readable — enable Removable Volumes for Karol in System Settings');
    return { ok: false, error: errMsg, scanning: false };
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
// Other fields (title, artist, year, …) are preserved. Also moves on-disk media
// (+ sidecars) into the matching library folder when needed.
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

  let move = { moved: false };
  try {
    move = moveMediaForTag(videoId, tag) || move;
  } catch (e) {
    console.warn('[library] reclassify move failed:', videoId, e && e.message);
    move = { moved: false, error: e && e.message };
  }

  // Durable MySQL write, immediate + best-effort (same paths the tag sync
  // uses): library_tags for base ids, song_catalog tag/source via
  // read-modify-write so upsert_batch doesn't blank other columns.
  _syncReclassifyToMysql(videoId, next).catch((e) => {
    console.error('[library/tags] reclassify MySQL sync failed:', e.message);
  });
  return {
    ok: true,
    videoId,
    tag: next.tag,
    source: next.source || '',
    moved: !!move.moved,
    from: move.from || '',
    to: move.to || '',
    moveError: move.error || '',
  };
}

/** Strip one or more trailing `-karaoke` suffixes (guards against double-append bugs). */
function normalizeVideoIdBase(videoId) {
  return String(videoId || '').replace(/(-karaoke)+$/g, '');
}

/**
 * Resolve which tags.json key owns a karaoke/custom track's metadata.
 * Prefers the `-karaoke` pipeline key when present.
 */
function resolveTagKey(videoId) {
  const tags = loadTags();
  const id = String(videoId || '');
  const base = normalizeVideoIdBase(id);
  const karaokeKey = base + '-karaoke';
  // Prefer the pipeline `-karaoke` key (where Custom metadata lives)
  if (tags[karaokeKey]) return karaokeKey;
  if (tags[base]) return base;
  // Accept an existing exact key only if it is not a mangled multi-suffix leftover
  if (tags[id] && !/(-karaoke){2,}$/.test(id)) return id;
  return karaokeKey;
}

/** Mangled keys from older save bugs: base + two or more `-karaoke` suffixes. */
function _mangledOffsetKeys(tags, base) {
  const b = String(base || '');
  if (!b) return [];
  const re = new RegExp('^' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(-karaoke){2,}$');
  return Object.keys(tags || {}).filter((k) => re.test(k));
}

/**
 * Read durable lyric timing offset (seconds). Migrates offsets saved under
 * mangled `…-karaoke-karaoke…` keys onto the canonical tags entry.
 */
function getLyricOffset(videoId) {
  const tags = loadTags();
  const base = normalizeVideoIdBase(videoId);
  const key = resolveTagKey(videoId);
  let offset = Number(tags[key] && tags[key].lyricOffset);
  if (!Number.isFinite(offset)) offset = 0;

  let dirty = false;
  for (const mk of _mangledOffsetKeys(tags, base)) {
    const n = Number(tags[mk] && tags[mk].lyricOffset);
    if (!offset && Number.isFinite(n) && n !== 0) {
      offset = n;
      const existing = tags[key] || { tag: 'karaoke', year: '', artist: '', source: 'karaoke-maker' };
      tags[key] = { ...existing, lyricOffset: n };
    }
    delete tags[mk];
    dirty = true;
  }
  if (dirty) saveTags(tags);

  return { ok: true, offset: offset || 0, videoId: key, baseVideoId: base };
}

/**
 * Persist lyric timing offset on the canonical tags.json key the player reads.
 * Does not mutate LRC timestamps — offset is applied at playback time.
 */
function setLyricOffset(videoId, offset) {
  const id = String(videoId || '');
  if (!id) return { ok: false, error: 'videoId required' };
  let n = Number(offset);
  if (!Number.isFinite(n)) return { ok: false, error: 'offset must be a number' };
  // Clamp to slider range used by the player UI
  n = Math.max(-30, Math.min(30, Math.round(n * 10) / 10));

  const tags = loadTags();
  const base = normalizeVideoIdBase(id);
  const key = resolveTagKey(id);
  const existing = tags[key] || { tag: 'karaoke', year: '', artist: '', source: 'karaoke-maker' };
  const next = { ...existing };
  if (Math.abs(n) < 0.05) {
    delete next.lyricOffset;
    n = 0;
  } else {
    next.lyricOffset = n;
  }
  tags[key] = next;

  // Drop legacy mangled keys so restart cannot revive a stale wrong-key value
  for (const mk of _mangledOffsetKeys(tags, base)) {
    if (mk !== key) delete tags[mk];
  }
  saveTags(tags);
  return { ok: true, offset: n, videoId: key, baseVideoId: base };
}

/**
 * Set a 0–5 star rating on a custom karaoke track (stored in tags.json).
 * 0 clears the rating. Writes onto the `-karaoke` key when that entry exists.
 */
function setRating(videoId, rating) {
  const id = String(videoId || '');
  if (!id) return { ok: false, error: 'videoId required' };
  let n = Number(rating);
  if (!Number.isFinite(n)) return { ok: false, error: 'rating must be a number' };
  n = Math.max(0, Math.min(5, Math.round(n)));

  const tags = loadTags();
  const key = resolveTagKey(id);
  const existing = tags[key] || { tag: 'karaoke', year: '', artist: '', source: 'karaoke-maker' };
  const next = { ...existing };
  if (n === 0) {
    delete next.rating;
  } else {
    next.rating = n;
  }
  tags[key] = next;
  saveTags(tags);
  // Keep in-memory library rows in sync so the controller sees the new rating
  // without waiting for a full rescan.
  try {
    const videos = (__libraryListCache.data && __libraryListCache.data.videos) || [];
    const base = id.replace(/-karaoke$/, '');
    for (const v of videos) {
      const vid = String(v.videoId || '');
      if (vid === id || vid === key || vid === base || vid === base + '-karaoke') {
        v.rating = n || null;
      }
    }
  } catch (_) {}
  return { ok: true, videoId: key, rating: n || null, baseVideoId: id.replace(/-karaoke$/, '') };
}

function getRating(videoId) {
  const tags = loadTags();
  const key = resolveTagKey(videoId);
  const entry = tags[key] || tags[String(videoId || '')] || {};
  const n = Number(entry.rating);
  return {
    ok: true,
    videoId: key,
    rating: (Number.isFinite(n) && n > 0) ? Math.max(1, Math.min(5, Math.round(n))) : null,
  };
}

function _isMusicLibraryDir(dir) {
  if (!dir) return false;
  const abs = path.resolve(dir);
  if (abs === path.resolve(LIBRARY_SONGS_DIR)) return true;
  for (const d of LEGACY_SONGS_DIRS || []) {
    try { if (abs === path.resolve(d)) return true; } catch (_) {}
  }
  return false;
}

function _isKaraokeLibraryDir(dir) {
  if (!dir) return false;
  try { return path.resolve(dir) === path.resolve(LIBRARY_KARAOKE_DIR); } catch (_) { return false; }
}

function _targetDirForTag(tag) {
  if (tag === 'karaoke') return LIBRARY_KARAOKE_DIR;
  if (tag === 'music' || tag === 'song') return LIBRARY_SONGS_DIR;
  return LIBRARY_DIR;
}

/** Move videoId media (+ common sidecars) into the folder for `tag`. */
function moveMediaForTag(videoId, tag) {
  const destDir = _targetDirForTag(tag);
  if (!destDir) return { moved: false, reason: 'no_dest' };

  let srcPath = null;
  try {
    srcPath = getFilePath(videoId);
  } catch (_) {}
  if (!srcPath || !fs.existsSync(srcPath)) {
    try {
      const p = getVideoPath(videoId);
      if (p && fs.existsSync(p)) srcPath = p;
    } catch (_) {}
  }
  if (!srcPath || !fs.existsSync(srcPath)) return { moved: false, reason: 'not_found' };

  const srcDir = path.dirname(srcPath);
  // Already in a correct-type folder — leave it (don't shuffle USB ↔ Mac songs/)
  if (tag === 'karaoke' || tag === 'custom') {
    if (_isKaraokeLibraryDir(srcDir)) return { moved: false, reason: 'already_there', path: srcPath };
  } else if (tag === 'music' || tag === 'song') {
    if (_isMusicLibraryDir(srcDir)) return { moved: false, reason: 'already_there', path: srcPath };
  } else if (path.resolve(srcDir) === path.resolve(destDir)) {
    return { moved: false, reason: 'already_there', path: srcPath };
  }

  try { fs.mkdirSync(destDir, { recursive: true }); } catch (_) {}

  const stem = path.basename(srcPath, path.extname(srcPath));
  let names = [];
  try { names = fs.readdirSync(srcDir); } catch (_) { names = [path.basename(srcPath)]; }
  const toMove = names.filter((name) => {
    if (!name || name.startsWith('._')) return false;
    if (name === path.basename(srcPath)) return true;
    // Same stem sidecars: id.info.json, id.webp, id-vocals.wav, etc.
    return name === stem || name.startsWith(stem + '.') || name.startsWith(stem + '-');
  });

  // Dual-presence: Music Videos stay in songs/ even when a karaoke/custom
  // variant is registered. Reclassifying to karaoke used to *move* the MV out
  // of songs/, leaving an archive ghost (yt-dlp skips, Music Videos empty).
  // Copy into karaoke/ and leave songs/ intact.
  const preserveSongsCopy =
    (tag === 'karaoke' || tag === 'custom') && _isMusicLibraryDir(srcDir);

  const movedFiles = [];
  for (const name of toMove) {
    const from = path.join(srcDir, name);
    const to = path.join(destDir, name);
    if (path.resolve(from) === path.resolve(to)) continue;
    try {
      if (fs.existsSync(to)) {
        // Dest already has this file — only delete source when we are truly moving
        if (!preserveSongsCopy) {
          try { fs.unlinkSync(from); } catch (_) {}
        }
        continue;
      }
      if (preserveSongsCopy) {
        fs.copyFileSync(from, to);
      } else {
        fs.renameSync(from, to);
      }
      movedFiles.push(name);
    } catch (e) {
      // Cross-device (or copy-preserve path): copy; unlink only when moving
      try {
        fs.copyFileSync(from, to);
        if (!preserveSongsCopy) fs.unlinkSync(from);
        movedFiles.push(name);
      } catch (e2) {
        console.warn('[library] move failed:', from, '→', to, e2 && e2.message);
        return {
          moved: movedFiles.length > 0,
          from: srcDir,
          to: destDir,
          files: movedFiles,
          error: e2 && e2.message,
          preservedSongs: !!preserveSongsCopy,
        };
      }
    }
  }

  if (movedFiles.length) {
    console.log(
      '[library]',
      preserveSongsCopy ? 'Copied (kept songs/)' : 'Moved',
      videoId,
      '(' + movedFiles.length + ' files)',
      srcDir,
      '→',
      destDir,
    );
  }
  return {
    moved: movedFiles.length > 0,
    from: srcDir,
    to: destDir,
    files: movedFiles,
    reason: movedFiles.length ? (preserveSongsCopy ? 'copied_preserved_songs' : 'moved') : 'nothing',
    preservedSongs: !!preserveSongsCopy,
  };
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

/**
 * Build one library-list row from on-disk media + tags.json (same shape as
 * library-scan-worker). Returns null when there is no playable mp4 / metadata.
 */
function _buildCacheRowFromDisk(videoId) {
  const id = String(videoId || '');
  if (!id) return null;
  const isKaraokeVariant = /-karaoke$/.test(id);
  const baseVideoId = isKaraokeVariant ? id.replace(/-karaoke$/, '') : id;
  if (!/^[A-Za-z0-9_-]{11}$/.test(baseVideoId)) return null;

  let mediaPath = null;
  for (const ext of VIDEO_EXTS) {
    for (const dir of _mediaSearchDirsForId(id)) {
      const p = path.join(dir, id + ext);
      try {
        if (fs.existsSync(p) && fs.statSync(p).size >= 50_000) {
          mediaPath = p;
          break;
        }
      } catch (_) { /* ignore */ }
    }
    if (mediaPath) break;
  }
  if (!mediaPath) return null;

  let meta = null;
  try {
    const infoPath = getInfoPath(id);
    if (infoPath && fs.existsSync(infoPath)) meta = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
  } catch (_) { /* ignore */ }
  if (!meta?.title && isKaraokeVariant) {
    try {
      const baseInfo = getInfoPath(baseVideoId);
      if (baseInfo && fs.existsSync(baseInfo)) meta = JSON.parse(fs.readFileSync(baseInfo, 'utf8'));
    } catch (_) { /* ignore */ }
  }

  const tags = loadTags();
  // Never let the '-karaoke' tag's source/tag bleed onto the base Music Video
  // row — that made Custom show both `{id}` and `{id}-karaoke` as duplicates.
  const own = tags[id] || {};
  const sibling = tags[isKaraokeVariant ? baseVideoId : (id + '-karaoke')] || {};
  const tagEntry = isKaraokeVariant
    ? { ...sibling, ...own }
    : { ...own };
  if (!isKaraokeVariant) {
    if (!tagEntry.title && sibling.title) tagEntry.title = sibling.title;
    if (!tagEntry.artist && sibling.artist) tagEntry.artist = sibling.artist;
    if (!tagEntry.year && sibling.year) tagEntry.year = sibling.year;
    if (!tagEntry.upload_date && sibling.upload_date) tagEntry.upload_date = sibling.upload_date;
    if (!tagEntry.duration && sibling.duration) tagEntry.duration = sibling.duration;
  }
  const tagTitle = ((tags[id] || {}).title
    || (tags[baseVideoId + '-karaoke'] || {}).title
    || (tags[baseVideoId] || {}).title || '').trim();
  const bestTitle = ((meta && meta.title) || '').trim() || tagTitle || id;
  if (!bestTitle && !(meta && meta.thumbnail)) return null;

  let size = 0;
  try { size = fs.statSync(mediaPath).size; } catch (_) { /* ignore */ }

  let rating = null;
  const n = Number(tagEntry.rating);
  if (Number.isFinite(n) && n > 0) {
    rating = Math.max(1, Math.min(5, Math.round(n)));
  } else {
    const sn = Number(sibling.rating);
    if (Number.isFinite(sn) && sn > 0) rating = Math.max(1, Math.min(5, Math.round(sn)));
  }

  // Base Music Video rows must not inherit karaoke-maker provenance.
  let source = tagEntry.source || '';
  if (isKaraokeVariant) {
    source = source || 'karaoke-maker';
  } else if (source === 'karaoke-maker') {
    source = '';
  }

  const hasKaraoke = !isKaraokeVariant && (
    fs.existsSync(path.join(LIBRARY_KARAOKE_DIR, id + '-karaoke.mp4'))
    || fs.existsSync(path.join(LIBRARY_DIR, id + '-karaoke.mp4'))
  );
  let rowTag = tagEntry.tag;
  if (!rowTag) {
    if (isKaraokeVariant) rowTag = 'karaoke';
    else if (hasKaraoke && sibling.source === 'karaoke-maker' && !own.source) rowTag = 'karaoke';
    else rowTag = 'music';
  } else if (!isKaraokeVariant && (rowTag === 'music' || rowTag === 'song')
    && hasKaraoke && sibling.source === 'karaoke-maker' && !own.source) {
    rowTag = 'karaoke';
  }

  return {
    videoId: id,
    title: bestTitle.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\\/g, '\\\\'),
    duration: (meta && meta.duration) || tagEntry.duration || 0,
    size,
    subtitles: (meta && meta.subtitles) ? Object.keys(meta.subtitles) : [],
    thumbnail: String((meta && meta.thumbnail) || '').replace(/\/(maxres|hq|sd|mq)default/, '/mqdefault'),
    upload_date: tagEntry.upload_date || (meta && meta.upload_date) || '',
    cached: true,
    tag: isKaraokeVariant ? 'karaoke' : rowTag,
    year: tagEntry.year || String(tagEntry.upload_date || (meta && meta.upload_date) || '').slice(0, 4),
    artist: tagEntry.artist || (meta && meta.uploader) || '',
    source,
    isKaraokeVariant,
    baseVideoId,
    hasKaraoke,
    rating,
  };
}

/**
 * Upsert one (or more) video ids into the in-memory + /tmp library cache
 * without a full USB walk. Used after karaoke-maker / download completes so
 * Custom / Music tabs show the new track immediately.
 *
 * For a base youtube id, also upserts the `-karaoke` variant when that mp4 exists.
 */
function upsertLibraryCacheEntry(videoId) {
  const base = normalizeVideoIdBase(videoId);
  if (!base) return { ok: false, error: 'videoId required', upserted: [] };

  if (!__libraryListCache.data) tryLoadCacheFromDisk();
  if (!__libraryListCache.data || !Array.isArray(__libraryListCache.data.videos)) {
    // No cache yet — leave a full scan to populate; do not invent a partial catalog.
    return { ok: false, error: 'library cache not loaded', upserted: [] };
  }

  const ids = [base];
  const karaokeId = base + '-karaoke';
  try {
    if (fs.existsSync(path.join(LIBRARY_KARAOKE_DIR, karaokeId + '.mp4'))
        || fs.existsSync(path.join(LIBRARY_DIR, karaokeId + '.mp4'))) {
      ids.push(karaokeId);
    }
  } catch (_) { /* ignore */ }

  const videos = __libraryListCache.data.videos;
  const byId = new Map();
  for (let i = 0; i < videos.length; i++) {
    const vid = videos[i] && videos[i].videoId;
    if (vid) byId.set(vid, i);
  }

  const upserted = [];
  for (const id of ids) {
    const row = _buildCacheRowFromDisk(id);
    if (!row) continue;
    if (id === base && row.hasKaraoke === false && ids.includes(karaokeId)) {
      row.hasKaraoke = true;
    }
    const idx = byId.get(id);
    if (idx != null) {
      videos[idx] = { ...videos[idx], ...row };
    } else {
      byId.set(id, videos.length);
      videos.push(row);
    }
    upserted.push(id);
  }

  if (!upserted.length) return { ok: false, error: 'no playable media on disk', upserted: [] };

  __libraryListCache.data.count = videos.length;
  __libraryListCache.ts = Date.now();
  try {
    const rawJson = JSON.stringify(__libraryListCache.data);
    __libraryListCache.rawJson = rawJson;
    fs.writeFileSync(CACHE_FILE, rawJson, 'utf8');
  } catch (e) {
    console.warn('[library] upsertLibraryCacheEntry: disk write failed:', e.message);
  }
  console.log('[library] Upserted cache entries:', upserted.join(', '));
  return { ok: true, upserted, count: videos.length };
}

module.exports = {
  init,
  list,
  getTags,
  mergeTagMeta,
  mergeTagMetaBatch,
  setTag,
  reclassify,
  setRating,
  getRating,
  resolveTagKey,
  normalizeVideoIdBase,
  getLyricOffset,
  setLyricOffset,
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
  resolveLyricDisplay,
  normalizeLyricTracks,
  mergeLyricTrack,
  getStatus,
  getStemPaths,
  getDownloadDir,
  scanSummary,
  isDriveMounted,
  probeDrive,
  ensureLibraryDirs,
  invalidateListCache,
  upsertLibraryCacheEntry,
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
  LEGACY_SONGS_DIRS,
  LIBRARY_SEARCH_DIRS,
  DOWNLOADS_DIR,
  ARCHIVE_PATH,
  TAGS_PATH,
};
