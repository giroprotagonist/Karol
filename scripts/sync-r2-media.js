#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const mysql = require('../api-server/karol-mysql');

const LIBRARY_DIR = process.env.KAROL_LIBRARY_DIR || '/Volumes/maxone/Deskreen';
const BUCKET = process.env.KAROL_R2_BUCKET || 'karol';
const CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.KAROL_R2_CONCURRENCY || 5)));
const MAX_ATTEMPTS = Math.max(1, Number(process.env.KAROL_R2_MAX_ATTEMPTS || 6));
// Cloudflare's client API limit is ~1200 requests / 5 min (4/s). Space out PUT
// starts globally so many small files can't burst past it like plain
// concurrency limits allow.
const MIN_PUT_INTERVAL_MS = Math.max(0, Number(process.env.KAROL_R2_PUT_INTERVAL_MS || 300));
const MANIFEST_FILE = process.env.KAROL_R2_MANIFEST
  || path.join(os.homedir(), '.karol-r2-upload-manifest.json');
const WRANGLER = path.resolve(__dirname, '..', 'node_modules', '.bin', 'wrangler');
const MEDIA_EXTS = new Set(['.mp4', '.mkv', '.mp3', '.webm']);

function shouldUpload(name) {
  if (name.startsWith('._') || name === '.DS_Store') return false;
  if (/\.(part|tmp)$/i.test(name) || /\.part-/i.test(name) || /\.bak$/i.test(name)) return false;
  return true;
}

function walk(dir, relative = '') {
  const files = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return files; }
  for (const entry of entries) {
    if (!shouldUpload(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    const rel = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...walk(abs, rel));
    else {
      const stat = fs.statSync(abs);
      files.push({ abs, rel, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) });
    }
  }
  return files;
}

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')); }
  catch (e) { return { version: 1, bucket: BUCKET, files: {} }; }
}

function saveManifest(manifest) {
  const temp = MANIFEST_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(manifest, null, 2));
  fs.renameSync(temp, MANIFEST_FILE);
}

function contentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ({
    '.mp4': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg',
    '.webm': 'video/webm',
    '.json': 'application/json',
    '.vtt': 'text/vtt; charset=utf-8',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.txt': 'text/plain; charset=utf-8',
  })[ext] || 'application/octet-stream';
}

function objectKey(rel) {
  return 'library/' + rel.split(path.sep).join('/');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Global pacing: spaces out PUT starts across all workers, and holds everyone
// back when Cloudflare tells us we are rate limited.
let nextPutAt = 0;
let rateLimitedUntil = 0;

async function acquirePutSlot() {
  while (true) {
    const now = Date.now();
    const wait = Math.max(nextPutAt - now, rateLimitedUntil - now);
    if (wait <= 0) break;
    await sleep(Math.min(wait, 5000));
  }
  nextPutAt = Math.max(Date.now(), nextPutAt) + MIN_PUT_INTERVAL_MS;
}

function summarizeWranglerError(stderr, exitCode) {
  // eslint-disable-next-line no-control-regex
  const lines = stderr.replace(/\x1b\[[0-9;]*m/g, '').split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.includes('Logs were written') && !line.startsWith('🪵'));
  const errorLines = lines.filter(line => /error|failed|429|\[code/i.test(line));
  const picked = (errorLines.length ? errorLines : lines).slice(-3).join(' | ');
  return picked || `wrangler exited ${exitCode}`;
}

function isRetryableError(message) {
  return /429|\b971\b|10071|too many requests|rate.?limit|timed?.?out|ETIMEDOUT|ECONNRESET|EPIPE|ENETDOWN|EAI_AGAIN|ENOTFOUND|unable to resolve|DNS|socket hang up|fetch failed|network|\b5\d\d\b|internal error/i.test(message);
}

function isRateLimitError(message) {
  return /429|\b971\b|too many requests|rate.?limit/i.test(message);
}

function uploadOnce(file) {
  const key = objectKey(file.rel);
  const args = [
    'r2', 'object', 'put', `${BUCKET}/${key}`,
    '--file', file.abs,
    '--content-type', contentType(file.rel),
    '--remote',
    '--force',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(WRANGLER, args, {
      cwd: path.resolve(__dirname, '..'),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(key);
      else reject(new Error(summarizeWranglerError(stderr, code)));
    });
  });
}

async function upload(file, onRetry) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await acquirePutSlot();
    try {
      return await uploadOnce(file);
    } catch (error) {
      lastError = error;
      if (attempt >= MAX_ATTEMPTS || !isRetryableError(error.message)) break;
      // Bounded exponential backoff with full jitter: 2s, 4s, 8s ... capped at 60s.
      const base = Math.min(2000 * 2 ** (attempt - 1), 60000);
      const delay = Math.round(base * (0.5 + Math.random()));
      if (isRateLimitError(error.message)) {
        // Push all workers back, not just this one.
        rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + delay);
      }
      if (onRetry) onRetry(attempt, delay, error);
      await sleep(delay);
    }
  }
  throw lastError;
}

function videoIdForMedia(rel) {
  if (!MEDIA_EXTS.has(path.extname(rel).toLowerCase())) return '';
  // '-karaoke' variants are distinct catalog rows — mark the exact id uploaded
  return path.basename(rel, path.extname(rel));
}

async function markUploaded(ids) {
  const unique = [...new Set(ids)].filter(Boolean);
  for (let i = 0; i < unique.length; i += 200) {
    await mysql.catalogMarkR2Batch(unique.slice(i, i + 200));
  }
}

async function main() {
  if (!fs.existsSync(LIBRARY_DIR)) throw new Error('Library drive not mounted: ' + LIBRARY_DIR);
  if (!fs.existsSync(WRANGLER)) throw new Error('Wrangler missing; run npm install');

  const manifest = loadManifest();
  manifest.bucket = BUCKET;
  manifest.files = manifest.files || {};

  console.log('[r2] Scanning', LIBRARY_DIR);
  const all = walk(LIBRARY_DIR);
  const pending = all.filter(file => {
    const prev = manifest.files[file.rel];
    return !prev || prev.size !== file.size || prev.mtimeMs !== file.mtimeMs;
  });
  // Put tiny metadata first so the cloud catalog becomes useful immediately,
  // then saturate upload bandwidth with media.
  pending.sort((a, b) => {
    const am = MEDIA_EXTS.has(path.extname(a.rel).toLowerCase()) ? 1 : 0;
    const bm = MEDIA_EXTS.has(path.extname(b.rel).toLowerCase()) ? 1 : 0;
    return am - bm || b.size - a.size;
  });

  const totalBytes = pending.reduce((sum, file) => sum + file.size, 0);
  console.log(`[r2] ${all.length} files total; ${pending.length} pending; ${(totalBytes / 1024 ** 3).toFixed(2)} GiB; concurrency ${CONCURRENCY}`);
  if (!pending.length) return;

  let cursor = 0;
  let completed = 0;
  let completedBytes = 0;
  let failures = 0;
  let retries = 0;
  let dirty = 0;
  const failedFiles = [];
  const uploadedVideoIds = [];
  const startedAt = Date.now();

  let stopping = false;
  const stop = signal => {
    if (stopping) return;
    stopping = true;
    console.error(`\n[r2] ${signal} received; saving manifest and exiting...`);
    saveManifest(manifest);
    process.exit(130);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= pending.length) return;
      const file = pending[index];
      try {
        const key = await upload(file, (attempt, delay, error) => {
          retries++;
          console.error(`\n[r2] Retry ${attempt}/${MAX_ATTEMPTS - 1} in ${(delay / 1000).toFixed(1)}s for ${file.rel}: ${error.message}`);
        });
        manifest.files[file.rel] = {
          key,
          size: file.size,
          mtimeMs: file.mtimeMs,
          uploadedAt: new Date().toISOString(),
        };
        const videoId = videoIdForMedia(file.rel);
        if (videoId) uploadedVideoIds.push(videoId);
        completed++;
        completedBytes += file.size;
        dirty++;
        if (dirty >= 20) { saveManifest(manifest); dirty = 0; }
        const elapsed = Math.max(1, (Date.now() - startedAt) / 1000);
        const mbps = (completedBytes * 8 / 1e6) / elapsed;
        const pct = totalBytes ? completedBytes / totalBytes * 100 : 100;
        process.stdout.write(`\r[r2] ${completed}/${pending.length} ${pct.toFixed(1)}% ${mbps.toFixed(1)} Mbps retries=${retries} failures=${failures}   `);
      } catch (error) {
        failures++;
        failedFiles.push(file.rel);
        console.error(`\n[r2] Failed (giving up) ${file.rel}: ${error.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
  saveManifest(manifest);
  process.stdout.write('\n');
  if (uploadedVideoIds.length) {
    try { await markUploaded(uploadedVideoIds); }
    catch (error) { console.error('[r2] MySQL mark warning:', error.message); }
  }
  console.log('[r2] Finished', { completed, retries, failures, manifest: MANIFEST_FILE });
  if (failures) {
    console.log('[r2] Failed files (re-run to retry):');
    for (const rel of failedFiles.slice(0, 50)) console.log('  -', rel);
    if (failedFiles.length > 50) console.log(`  ... and ${failedFiles.length - 50} more`);
    process.exitCode = 2;
  }
}

main().catch(error => {
  console.error('[r2] Fatal:', error.message);
  process.exit(1);
});
