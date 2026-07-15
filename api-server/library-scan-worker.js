// library-scan-worker.js — runs synchronous scan in a forked process
// so the main server stays responsive while filesystem I/O runs at full speed.
const fs = require('fs');
const path = require('path');

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
        tagsData[vid] = { tag: val, year: '', artist: '', source: '' };
      } else if (val && typeof val === 'object') {
        tagsData[vid] = {
          tag: val.tag || val.type || 'music',
          year: val.year || '',
          artist: val.artist || '',
          source: val.source || '',
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
    const extMatch = f.match(/\.(mp4|mkv|mp3|info\.json|vtt|webp|jpg)$/);
    if (!extMatch) continue;

    const base = f.slice(0, -extMatch[0].length);
    const vid = (extMatch[1] === 'vtt')
      ? base.split('.')[0].replace(/\.f\d+$/, '')
      : base.replace(/\.f\d+$/, '');
    let videoIdFromFile = null;
    if (downloadedVideoIds.has(vid)) videoIdFromFile = vid;
    // Handle karaoke variants: {videoId}-karaoke.mp4
    else if (vid.endsWith('-karaoke')) {
      const baseVid = vid.slice(0, -8);  // strip '-karaoke' suffix (8 chars)
      if (downloadedVideoIds.has(baseVid)) videoIdFromFile = baseVid;
    }
    else if (extMatch[1] === 'vtt') {
      const m = base.match(/[.-]([A-Za-z0-9_-]{10,12})$/);
      if (m && downloadedVideoIds.has(m[1])) videoIdFromFile = m[1];
    }
    if (!videoIdFromFile) continue;

    const entry = ensure(videoIdFromFile);
    if (extMatch[1] === 'mp4' || extMatch[1] === 'mkv' || extMatch[1] === 'mp3') {
      try { entry.size = fs.statSync(path.join(dir, f)).size; } catch (e) {}
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
for (const videoId of downloadedVideoIds) {
  const f = fileMap[videoId] || { size: 0, subs: [], meta: null };
  // Sanitize title: strip control chars and escape backslashes that would break JSON
  const rawTitle = (f.meta?.title || videoId).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\\/g, '\\\\');
  // Merge tags from base videoId AND karaoke variant (karaoke variant takes priority)
  const tagEntry = { ...(tagsData[videoId] || {}), ...(tagsData[videoId + '-karaoke'] || {}) };
  videos.push({
    videoId,
    title: rawTitle,
    duration: f.meta?.duration || 0,
    size: f.size,
    subtitles: f.subs,
    thumbnail: f.meta?.thumbnail || '',
    upload_date: f.meta?.upload_date || '',
    cached: true,
    tag: tagEntry.tag || 'music',
    year: tagEntry.year || '',
    artist: tagEntry.artist || '',
    source: tagEntry.source || '',
  });
}
videos.sort((a, b) => b.size - a.size);

let archiveMtime = 0;
try { archiveMtime = fs.statSync(archivePath).mtimeMs; } catch (e) {}

fs.writeFileSync('/tmp/karol-library-cache.json', JSON.stringify({ ok: true, count: videos.length, videos, archiveMtime }));
process.exit(0);
