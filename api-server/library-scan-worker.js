// library-scan-worker.js — runs synchronous scan in a forked process
// so the main server stays responsive while filesystem I/O runs at full speed.
const fs = require('fs');
const path = require('path');

const LOCK_PATH = '/tmp/karol-library-scan.lock';
let lockFd = null;
function acquireScanLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      lockFd = fs.openSync(LOCK_PATH, 'wx');
      fs.writeFileSync(lockFd, String(process.pid));
      return;
    } catch (e) {
      let stale = false;
      try {
        const oldPid = parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim(), 10);
        if (!oldPid) stale = true;
        else {
          try { process.kill(oldPid, 0); } catch (_) { stale = true; }
          if (!stale) {
            console.error('[library-scan] Another scan already running (pid ' + oldPid + ') — exit');
            process.exit(3);
          }
        }
      } catch (_) { stale = true; }
      if (stale) {
        try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
        continue;
      }
    }
  }
  console.error('[library-scan] Could not acquire scan lock — exit');
  process.exit(3);
}
function releaseScanLock() {
  try { if (lockFd != null) fs.closeSync(lockFd); } catch (_) {}
  try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
  lockFd = null;
}
acquireScanLock();
process.on('exit', releaseScanLock);
process.on('SIGINT', () => { releaseScanLock(); process.exit(130); });
process.on('SIGTERM', () => { releaseScanLock(); process.exit(143); });

const [archivePath, libraryDir, downloadsDir, tagsPath] = process.argv.slice(2);

const downloadedVideoIds = new Set();
try {
  const data = fs.readFileSync(archivePath, 'utf8');
  for (const line of data.split('\n').filter(Boolean)) {
    const parts = line.trim().split(/\s+youtube\s+/i);
    for (const part of parts) {
      const vid = part.replace(/^youtube\s+/i, '').trim();
      if (vid && vid.length >= 10) downloadedVideoIds.add(vid);
    }
  }
} catch (e) { /* archive not found */ }

// Load tags.json for category enrichment
let tagsData = {};
try {
  if (tagsPath && fs.existsSync(tagsPath)) {
    const raw = JSON.parse(fs.readFileSync(tagsPath, 'utf8'));
    for (const [vid, val] of Object.entries(raw)) {
      if (typeof val === 'string') {
        tagsData[vid] = { tag: val, year: '', artist: '', source: '', title: '' };
      } else if (val && typeof val === 'object') {
        tagsData[vid] = {
          tag: val.tag || val.type || 'music',
          year: val.year || '',
          artist: val.artist || '',
          source: val.source || '',
          title: val.title || '',
          upload_date: val.upload_date || '',
        };
      }
    }
  }
} catch (e) { /* tags not available */ }

const fileMap = {};
function ensure(vid) {
  if (!fileMap[vid]) fileMap[vid] = { size: 0, subs: [], meta: null };
  return fileMap[vid];
}

// Build list of directories to scan: library subdirs + downloadsDir
const scanDirs = [downloadsDir];

// Scan library root (unclassified videos)
try { if (fs.existsSync(libraryDir)) scanDirs.push(libraryDir); } catch (e) {}

// Scan library/karaoke/ and library/songs/ subdirectories
for (const sub of ['karaoke', 'songs']) {
  const subPath = path.join(libraryDir, sub);
  try { if (fs.existsSync(subPath)) scanDirs.push(subPath); } catch (e) {}
}

for (const dir of scanDirs) {
  let files;
  try { files = fs.readdirSync(dir); } catch (e) { continue; }
  for (const f of files) {
    // ExFAT/macOS litter — scanning these doubled I/O on karaoke/ (~10k ._ files)
    // and made the library "stuck scanning" while two workers fought the USB.
    if (!f || f.startsWith('._') || f === '.DS_Store') continue;
    const extMatch = f.match(/\.(mp4|mkv|mp3|info\.json|vtt|webp|jpg)$/);
    if (!extMatch) continue;

    const base = f.slice(0, -extMatch[0].length);
    const vid = (extMatch[1] === 'vtt')
      ? base.split('.')[0].replace(/\.f\d+$/, '')
      : base.replace(/\.f\d+$/, '');
    // IMPORTANT: '-karaoke' variants are DISTINCT library entries. Never strip
    // the suffix for identity — 'VIDEO_ID' and 'VIDEO_ID-karaoke' are two rows.
    const videoIdFromFile = vid;
    // Index ALL files that exist on disk — the archive only tracks download status,
    // it doesn't gate whether a file is a valid library entry
    if (!videoIdFromFile) continue;
    // Reject playlist IDs / garbage stems (real YT ids are exactly 11 chars;
    // karaoke variants are "<11>-karaoke"). Orphan playlist .info.json/.jpg
    // used to create fake Music Video rows like "Naynay Bday".
    const baseIdCheck = videoIdFromFile.endsWith('-karaoke')
      ? videoIdFromFile.slice(0, -8)
      : videoIdFromFile;
    if (!/^[A-Za-z0-9_-]{11}$/.test(baseIdCheck)) continue;

    const entry = ensure(videoIdFromFile);
    if (extMatch[1] === 'mp4' || extMatch[1] === 'mkv' || extMatch[1] === 'mp3') {
      try {
        const full = path.join(dir, f);
        // Dual-presence: pipeline leaves karaoke/{id}.mp4 (source) beside
        // karaoke/{id}-karaoke.mp4. The Music Video row must reflect songs/.
        const isKaraokeDir = path.basename(dir) === 'karaoke';
        const isBareId = !videoIdFromFile.endsWith('-karaoke');
        if (isKaraokeDir && isBareId) {
          const songsTwin = path.join(libraryDir, 'songs', f);
          if (fs.existsSync(songsTwin) && fs.statSync(songsTwin).size >= 50_000) {
            // Skip — songs/ pass (later) owns the base-id media size.
          } else {
            entry.size = fs.statSync(full).size;
          }
        } else {
          entry.size = fs.statSync(full).size;
        }
      } catch (e) {}
    } else if (extMatch[1] === 'info.json') {
      try { entry.meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) {}
    } else if (extMatch[1] === 'vtt') {
      const parts = base.split('.');
      for (const p of parts) {
        if (/^[a-z]{2,3}(-[A-Za-z0-9]+)*$/i.test(p) && p !== 'live_chat') {
          entry.subs.push(p);
          break;
        }
      }
    }
  }
}

const videos = [];
for (const videoId of Object.keys(fileMap)) {
  const f = fileMap[videoId] || { size: 0, subs: [], meta: null };
  const isKaraokeVariant = videoId.endsWith('-karaoke');
  const baseVideoId = isKaraokeVariant ? videoId.slice(0, -8) : videoId;
  // Skip sidecar-only ghosts (info.json/webp with no playable media).
  // These appeared as duplicate Custom/Music rows after MVs were moved beside
  // an existing `-karaoke.mp4` pipeline output.
  if (!f.size) continue;
  // Karaoke variants without their own info.json borrow the base entry's meta
  // so older pipeline outputs still appear as distinct rows.
  let meta = f.meta;
  if (!meta?.title && isKaraokeVariant && fileMap[baseVideoId]?.meta) {
    meta = fileMap[baseVideoId].meta;
  }
  if (!meta?.title && !meta?.thumbnail) continue;
  // For BASE rows, never merge the '-karaoke' tag's source/tag onto the Music
  // Video row (that duplicated Custom entries as both `{id}` and `{id}-karaoke`).
  // Sibling metadata (title/artist/…) may still fill gaps.
  const own = tagsData[videoId] || {};
  const sibling = tagsData[isKaraokeVariant ? baseVideoId : (videoId + '-karaoke')] || {};
  const tagEntry = isKaraokeVariant ? { ...sibling, ...own } : { ...own };
  if (!isKaraokeVariant) {
    if (!tagEntry.title && sibling.title) tagEntry.title = sibling.title;
    if (!tagEntry.artist && sibling.artist) tagEntry.artist = sibling.artist;
    if (!tagEntry.year && sibling.year) tagEntry.year = sibling.year;
    if (!tagEntry.upload_date && sibling.upload_date) tagEntry.upload_date = sibling.upload_date;
  }
  // Title: info.json → tags.json (exact key, then variant/base keys) — only
  // ever fall back to the raw video id when no better source exists anywhere.
  const tagTitle = ((tagsData[videoId] || {}).title
    || (tagsData[baseVideoId + '-karaoke'] || {}).title
    || (tagsData[baseVideoId] || {}).title || '').trim();
  const bestTitle = (meta?.title || '').trim() || tagTitle || videoId;
  // Sanitize: strip control chars and escape backslashes that would break JSON
  const rawTitle = bestTitle.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\\/g, '\\\\');
  // '<id>-karaoke' files are only produced by the local karaoke pipeline;
  // stamp provenance even when tags.json lost it. Base Music Video rows must
  // never inherit karaoke-maker (Custom filter keys off that source).
  let source = tagEntry.source || '';
  if (isKaraokeVariant) {
    source = source || 'karaoke-maker';
  } else if (source === 'karaoke-maker') {
    source = '';
  }
  const hasKaraoke = !isKaraokeVariant && !!fileMap[videoId + '-karaoke'];
  let rowTag = tagEntry.tag;
  if (!rowTag) {
    if (isKaraokeVariant) rowTag = 'karaoke';
    else if (hasKaraoke && sibling.source === 'karaoke-maker' && !(own.source)) rowTag = 'karaoke';
    else rowTag = 'music';
  } else if (!isKaraokeVariant && (rowTag === 'music' || rowTag === 'song')
    && hasKaraoke && sibling.source === 'karaoke-maker' && !own.source) {
    rowTag = 'karaoke';
  }
  videos.push({
    videoId,
    title: rawTitle,
    duration: meta?.duration || 0,
    size: f.size,
    subtitles: f.subs,
    thumbnail: (meta?.thumbnail || '').replace(/\/(maxres|hq|sd|mq)default/, '/mqdefault'),
    upload_date: tagEntry.upload_date || meta?.upload_date || '',
    cached: true,
    tag: isKaraokeVariant ? 'karaoke' : rowTag,
    year: tagEntry.year || String(tagEntry.upload_date || meta?.upload_date || '').slice(0, 4),
    artist: tagEntry.artist || '',
    source,
    isKaraokeVariant,
    baseVideoId,
    hasKaraoke,
    rating: (function () {
      var n = Number(tagEntry.rating);
      if (!Number.isFinite(n) || n <= 0) {
        n = Number(sibling.rating);
      }
      return (Number.isFinite(n) && n > 0) ? Math.max(1, Math.min(5, Math.round(n))) : null;
    })(),
  });
}
videos.sort((a, b) => b.size - a.size);

let archiveMtime = 0;
try { archiveMtime = fs.statSync(archivePath).mtimeMs; } catch (e) {}

const cachePath = '/tmp/karol-library-cache.json';
// On login, Karol can start before macOS finishes mounting the USB drive.
// Never replace a healthy catalog with an empty scan from that race.
if (videos.length === 0) {
  try {
    const previous = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (previous && previous.ok && previous.count > 0) {
      console.error('[library-scan] Empty scan; preserving previous cache of ' + previous.count + ' videos');
      process.exit(2);
    }
  } catch (e) {}
}

// Atomic replacement prevents API/Electron readers from observing partial JSON.
const tempPath = cachePath + '.' + process.pid + '.tmp';
fs.writeFileSync(tempPath, JSON.stringify({ ok: true, count: videos.length, videos, archiveMtime }));
fs.renameSync(tempPath, cachePath);
process.exit(0);
