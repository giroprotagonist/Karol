#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('../api-server/karol-mysql');

const LIBRARY_DIR = process.env.KAROL_LIBRARY_DIR || '/Volumes/maxone/Deskreen';
const CACHE_FILE = process.env.KAROL_LIBRARY_CACHE || '/tmp/karol-library-cache.json';
const BATCH_SIZE = Math.max(1, Math.min(100, Number(process.env.KAROL_CATALOG_BATCH || 75)));
const MEDIA_EXTS = new Set(['.mp4', '.mkv', '.mp3', '.webm']);

function walkFiles(dir, relative = '') {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith('._') || entry.name === '.DS_Store') continue;
    const abs = path.join(dir, entry.name);
    const rel = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs, rel));
    else out.push({ abs, rel });
  }
  return out;
}

// Identity key for a file. '-karaoke' variants are DISTINCT catalog entries:
// 'VIDEO_ID-karaoke.*' files belong to the 'VIDEO_ID-karaoke' row, never to
// the base 'VIDEO_ID' row.
function fileId(filename) {
  return filename
    .replace(/\.(info\.json|lrc\.json|bundle\.json|audit\.json|mp4|mkv|mp3|webm|webp|jpg|jpeg|png|vtt)$/i, '')
    .replace(/\.[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/i, '');
}

function objectKey(rel) {
  return 'library/' + rel.split(path.sep).join('/');
}

function choose(files, test, score) {
  return files.filter(test).sort((a, b) => score(b) - score(a))[0] || null;
}

function mediaScore(file) {
  let score = 0;
  if (file.rel.includes('/karaoke/') || file.rel.startsWith('karaoke/')) score += 100;
  if (/-karaoke\.(mp4|mkv|mp3|webm)$/i.test(file.rel)) score += 50;
  try { score += Math.min(fs.statSync(file.abs).size / 1e9, 10); } catch (e) {}
  return score;
}

async function main() {
  if (!fs.existsSync(LIBRARY_DIR)) throw new Error('Library drive not mounted: ' + LIBRARY_DIR);
  const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  if (!cache.ok || !Array.isArray(cache.videos) || cache.videos.length === 0) {
    throw new Error('Library cache is empty; rebuild it before syncing');
  }

  console.log('[catalog] Indexing local files...');
  const files = walkFiles(LIBRARY_DIR);
  const byId = new Map();
  for (const file of files) {
    const id = fileId(path.basename(file.rel));
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(file);
  }

  const songs = cache.videos.map((video) => {
    // Exact-id lookup: base rows get base files, '-karaoke' rows get variant files
    const related = byId.get(String(video.videoId)) || [];
    const media = choose(related, f => MEDIA_EXTS.has(path.extname(f.rel).toLowerCase()), mediaScore);
    const metadata = choose(related, f => f.rel.endsWith('.info.json'), f => f.rel.includes('karaoke/') ? 2 : 1);
    const lyrics = choose(related, f => f.rel.endsWith('.lrc.json'), f => f.rel.includes('karaoke/') ? 2 : 1);
    const subtitles = related.filter(f => f.rel.endsWith('.vtt')).map(f => objectKey(f.rel));
    let size = Number(video.size || 0);
    if (media) {
      try { size = fs.statSync(media.abs).size; } catch (e) {}
    }
    // Never push a bare video id as the title: db.php's upsert skips rows with
    // empty titles, so sending '' preserves whatever (better) title MySQL has
    // instead of clobbering it with an id.
    const bareId = (t) => !t || /^[A-Za-z0-9_-]{11}(-karaoke)?$/.test(String(t).trim());
    return {
      video_id: video.videoId,
      title: bareId(video.title) ? '' : String(video.title).trim(),
      artist: video.artist || '',
      year: Number(video.year || 0) || null,
      duration: Number(video.duration || 0),
      tag: video.tag || 'music',
      source: video.source || '',
      thumbnail_url: video.thumbnail || '',
      media_key: media ? objectKey(media.rel) : '',
      metadata_key: metadata ? objectKey(metadata.rel) : '',
      lyrics_key: lyrics ? objectKey(lyrics.rel) : '',
      subtitles,
      local_relpath: media ? media.rel : '',
      size_bytes: size,
      sha256: '',
      r2_uploaded: false,
      available_local: !!media,
    };
  });

  let synced = 0;
  for (let i = 0; i < songs.length; i += BATCH_SIZE) {
    const batch = songs.slice(i, i + BATCH_SIZE);
    const result = await mysql.catalogUpsertBatch(batch);
    if (!result || result.ok === false) throw new Error(result?.error || 'catalog batch failed');
    synced += Number(result.upserted || batch.length);
    process.stdout.write(`\r[catalog] MySQL ${Math.min(i + batch.length, songs.length)}/${songs.length}`);
  }
  process.stdout.write('\n');
  const counts = await mysql.catalogCount();
  console.log('[catalog] Complete:', { synced, remote: counts });
}

main().catch((error) => {
  console.error('[catalog] Failed:', error.message);
  process.exit(1);
});
