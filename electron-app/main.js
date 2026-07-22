// Karol Electron — Stable Architecture
// Absolute paths for modules, preload, and HTML to avoid resolution issues.

const { app, BrowserWindow, ipcMain, screen, protocol, session, powerSaveBlocker, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, fork } = require('child_process');
const os = require('os');
let apiServerProcess = null;

// Custom media scheme must be privileged BEFORE ready so <video> can stream
// (HTTP range). Without stream:true, large local MP4s often stall at t=0.
// Do NOT set standard:true — that changes URL host/path parsing for karol-file:///...
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'karol-file',
    privileges: {
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true,
    },
  },
]);

// ── Single-instance lock — prevent macOS reopen-dialog hangs ──
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log('[karol] Another instance is running — quitting');
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  // Focus existing windows when user double-clicks Dock icon
  console.log('[karol] Second instance detected — focusing existing windows');
  if (ctrlWin) { ctrlWin.show(); ctrlWin.focus(); }
  if (playWin) { playWin.show(); playWin.focus(); }
});

// Minimal flags — let Chromium handle GPU/audio natively
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

process.on('uncaughtException', (e) => { console.error('[karol] FATAL:', e.message); });
process.on('unhandledRejection', (r) => { console.error('[karol] REJECTION:', r?.message || r); });

// ── Force-quit handlers — ensure the app can always exit ──
process.on('SIGTERM', () => { console.log('[karol] SIGTERM - force exit'); process.exit(0); });
process.on('SIGINT', () => { console.log('[karol] SIGINT - force exit'); process.exit(0); });

// ── Absolute paths ──
const BASE = path.resolve(__dirname);
const PRELOAD = path.join(BASE, 'preload.js');
const CTRL_HTML = path.join(BASE, 'controller.html');
const PLAY_HTML = path.join(BASE, 'player.html');

// ── Library ──
let library = null;
try { library = require(path.join(BASE, 'library')); } catch (e) { console.error('[karol] library FAIL:', e.message); }

// ── Downloads / Pipeline ──
let downloads = null;
try { downloads = require(path.join(BASE, 'downloads')); } catch (e) { console.error('[karol] downloads FAIL:', e.message); }

// ── MySQL proxy client (durable jobs / request state) ──
let mysql = null;
try { mysql = require(path.join(BASE, '..', 'api-server', 'karol-mysql')); }
catch (e) { console.error('[karol] mysql client FAIL:', e.message); }
const JOB_OWNER = 'mac-' + os.hostname().split('.')[0];
const JOB_RECIPE = 'karaoke-v1';
const JOB_LEASE_SECONDS = 1800;
// Durable local fallback for karaoke jobs (survives restarts even when the
// MySQL proxy is unreachable).
const JOBS_FILE = path.join('/Users/macdonk/Documents/GitHub/Karol', '.karol', 'karaoke-jobs.json');

// ── Processing job tracker ──
// { videoId: { status: 'downloading'|'processing'|'done'|'error', progress: 0-100, label: string, errorMessage: string } }
const processingJobs = {};

// ── Serial karaoke pipeline queue ──
// Ensures only one karaoke job runs at a time to prevent GPU contention
const karaokeQueue = [];
let karaokeRunning = false;

// ── Durable karaoke job registry ──
// MySQL (karaoke_jobs table) is preferred; a local JSON file is the fallback
// so restarts can resume in-flight work even when the proxy is unreachable.
// One generation job per source video + recipe; multiple requests (queue
// slots / MySQL request rows) attach to the same job.
let localJobs = { version: 1, jobs: {} };

function loadLocalJobs() {
  try {
    const data = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
    if (data && data.jobs) localJobs = data;
  } catch { /* first run or corrupted — start fresh */ }
}

function persistLocalJobs() {
  try {
    fs.mkdirSync(path.dirname(JOBS_FILE), { recursive: true });
    const temp = JOBS_FILE + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(localJobs, null, 2));
    fs.renameSync(temp, JOBS_FILE);
  } catch (e) { console.error('[karol] Job persist failed:', e.message); }
}

function upsertLocalJob(videoId, fields) {
  const base = String(videoId).replace(/-karaoke$/, '');
  const entry = localJobs.jobs[base] || { videoId: base, requesters: [], mysqlRequestIds: [], createdAt: new Date().toISOString() };
  Object.assign(entry, fields, { updatedAt: new Date().toISOString() });
  localJobs.jobs[base] = entry;
  persistLocalJobs();
  return entry;
}

function attachRequestToLocalJob(videoId, requester, mysqlRequestId) {
  const base = String(videoId).replace(/-karaoke$/, '');
  const entry = localJobs.jobs[base];
  if (!entry) return;
  if (requester && !entry.requesters.includes(requester)) entry.requesters.push(requester);
  if (mysqlRequestId && !entry.mysqlRequestIds.includes(mysqlRequestId)) entry.mysqlRequestIds.push(mysqlRequestId);
  persistLocalJobs();
}

// Fire-and-forget MySQL job status update (jobId resolved from local registry)
function syncJobToMysql(videoId, fields) {
  if (!mysql) return;
  const base = String(videoId).replace(/-karaoke$/, '');
  const entry = localJobs.jobs[base];
  if (!entry || !entry.jobId) return;
  mysql.jobUpdate(entry.jobId, { extend_lease_seconds: JOB_LEASE_SECONDS, ...fields })
    .catch((e) => console.error('[karol] MySQL job update failed:', base, e.message));
}

// Create (or attach to) the durable MySQL job row for this generation.
async function registerDurableJob(videoId, url) {
  const base = String(videoId).replace(/-karaoke$/, '');
  upsertLocalJob(base, { url: url || '', status: 'queued' });
  if (!mysql) return null;
  try {
    const result = await mysql.jobUpsert(base, url || '', JOB_RECIPE);
    if (result && result.ok && result.id) {
      upsertLocalJob(base, { jobId: Number(result.id) });
      return Number(result.id);
    }
  } catch (e) {
    console.error('[karol] MySQL job upsert failed (local fallback active):', base, e.message);
  }
  return null;
}

// Startup recovery: reclaim expired MySQL leases, inspect outputs already on
// disk, and re-enqueue anything unfinished — idempotently.
async function reclaimKaraokeJobs() {
  loadLocalJobs();
  const seen = new Set();
  const candidates = [];

  if (mysql) {
    try {
      await mysql.jobReclaimExpired();
      const claim = await mysql.jobClaimBatch(JOB_OWNER, JOB_LEASE_SECONDS, 10);
      for (const row of (claim && claim.rows) || []) {
        candidates.push({ videoId: row.video_id, url: row.source_url || '', jobId: Number(row.id) });
        seen.add(String(row.video_id).replace(/-karaoke$/, ''));
      }
    } catch (e) {
      console.error('[karol] MySQL job reclaim failed (using local fallback):', e.message);
    }
  }
  for (const entry of Object.values(localJobs.jobs)) {
    const base = String(entry.videoId).replace(/-karaoke$/, '');
    if (seen.has(base)) continue;
    if (entry.status === 'queued' || entry.status === 'running') {
      candidates.push({ videoId: base, url: entry.url || '', jobId: entry.jobId || null });
    }
  }

  for (const job of candidates) {
    const base = String(job.videoId).replace(/-karaoke$/, '');
    if (job.jobId) upsertLocalJob(base, { jobId: job.jobId });
    let finishedMp4 = null;
    try {
      const candidate = path.join(library.LIBRARY_KARAOKE_DIR, base + '-karaoke.mp4');
      if (fs.existsSync(candidate) && fs.statSync(candidate).size > 10000) finishedMp4 = candidate;
    } catch {}
    if (finishedMp4) {
      console.log('[karol] Reclaim: output already exists for', base, '— marking done');
      upsertLocalJob(base, { status: 'done' });
      syncJobToMysql(base, { status: 'done', progress: 100, stage: 'recovered-existing-output' });
      continue;
    }
    console.log('[karol] Reclaim: resuming karaoke job', base);
    const requesters = (localJobs.jobs[base] && localJobs.jobs[base].requesters) || [];
    enqueueKaraokeJob(base, job.url || ('https://www.youtube.com/watch?v=' + base), requesters[0] || '');
  }
  if (candidates.length) console.log('[karol] Reclaimed', candidates.length, 'karaoke job(s) at startup');
}

function processNextKaraokeJob() {
  if (karaokeRunning) return;
  if (karaokeQueue.length === 0) {
    console.log('[karol] Karaoke queue empty');
    return;
  }

  // Find the first non-error job
  const entry = karaokeQueue.shift();
  const { videoId, url, requester, isReLyric, forceWhisper, karaokeMatch, lyricsText, whisperModel } = entry;

  karaokeRunning = true;
  console.log('[karol] Karaoke queue: starting', videoId, '(remaining:', karaokeQueue.length, ')');
  if (!isReLyric) {
    upsertLocalJob(videoId, { status: 'running', stage: 'downloading' });
    syncJobToMysql(videoId, { status: 'downloading', stage: 'downloading', progress: 0 });
  }

  const startLabel = isReLyric
    ? ('Re-Lyric: ' + videoId + (whisperModel ? ' [' + whisperModel + ']' : '') + (lyricsText ? ' [+lyrics]' : ''))
    : (requester ? requester + ': ' + (url || videoId) : (url || videoId));
  processingJobs[videoId] = { status: 'downloading', progress: 0, label: startLabel, url: url, karaokify: true, requester: requester, isReLyric: !!isReLyric };
  // Recalculate queue positions for remaining entries
  for (let i = 0; i < karaokeQueue.length; i++) {
    const e = karaokeQueue[i];
    if (processingJobs[e.videoId] && processingJobs[e.videoId].status === 'queued') {
      processingJobs[e.videoId].queuePosition = i + 1;
    }
  }
  broadcastJobProgress();

  if (!downloads) {
    processingJobs[videoId] = { status: 'error', progress: 0, label: videoId, errorMessage: 'Download module not available' };
    broadcastJobProgress();
    karaokeRunning = false;
    processNextKaraokeJob();
    return;
  }

  downloads.start(videoId, true, url, { isReLyric: entry.isReLyric, forceWhisper: entry.forceWhisper, karaokeMatch: karaokeMatch, lyricsText: lyricsText, whisperModel: whisperModel })
    .then((result) => {
      if (result.karaokeDone) {
        const doneLabel = isReLyric ? ('Re-Lyric done: ' + videoId) : videoId;
        processingJobs[videoId] = { status: 'done', progress: 100, label: doneLabel, url: url, karaokify: true, requester: requester, isReLyric: !!isReLyric };
        console.log('[karol] Pipeline complete:', videoId, result.message || '');
        // Resolve a real title (pipeline info.json / tags.json) and update /
        // insert into the DJ queue for the singer — never a bare video id.
        let resolvedTitle = resolveTitleLocal(videoId) || TITLE_PLACEHOLDER;
        if (resolvedTitle === TITLE_PLACEHOLDER) {
          setTimeout(() => { fixBareIdQueueTitles('karaoke-done:' + videoId).catch(() => {}); }, 500);
        }
        const playId = resolveVid(videoId);
        if (requester && !isReLyric) {
          const existing = queue.findIndex(item =>
            item.videoId === playId || item.videoId === videoId || item.videoId === videoId + '-karaoke');
          if (existing >= 0) {
            queue[existing].videoId = playId;
            if (looksLikeBareIdTitle(queue[existing].title, playId)) {
              queue[existing].title = resolvedTitle;
            }
            queue[existing].singer = queue[existing].singer || requester;
            queue[existing].requester = queue[existing].requester || requester;
          } else {
            queue.push({ videoId: playId, title: resolvedTitle, singer: requester, requester });
          }
          saveState();
          notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
          notifyPlayerQueue();
          console.log('[karol] Queue updated after karaoke ready:', playId, resolvedTitle, requester);
        }
        if (library && typeof library.init === 'function') {
          library.init(true).then(() => {
            notifyCtrl('library-scan-progress', { videoId, status: 'done' });
          });
        }
        if (!isReLyric) {
          upsertLocalJob(videoId, { status: 'done', stage: 'done' });
          syncJobToMysql(videoId, { status: 'done', stage: 'done', progress: 100 });
          publishKaraokeAssets(videoId).catch((e) =>
            console.error('[karol] Asset publish failed for', videoId, ':', e.message));
        }
      } else if (result.karaokeFailed) {
        processingJobs[videoId] = { status: 'error', progress: 50, label: startLabel, errorMessage: result.message || 'Karaoke pipeline failed', url: url, karaokify: true, requester: requester, isReLyric: !!isReLyric };
        if (!isReLyric) failDurableJob(videoId, result.message || 'Karaoke pipeline failed');
      } else {
        processingJobs[videoId] = { status: 'done', progress: 100, label: videoId, url: url, karaokify: true, requester: requester };
      }
      broadcastJobProgress();
      karaokeRunning = false;
      processNextKaraokeJob();
    })
    .catch((err) => {
      processingJobs[videoId] = { status: 'error', progress: 0, label: startLabel, errorMessage: err.message, url: url, karaokify: true, requester: requester, isReLyric: !!isReLyric };
      if (!isReLyric) failDurableJob(videoId, err.message);
      broadcastJobProgress();
      console.error('[karol] Pipeline error for', videoId, ':', err.message);
      karaokeRunning = false;
      processNextKaraokeJob();
    });

  // Simulate progress since downloads.js doesn't emit events we can hook into
  pollDownloadProgress(videoId);
}

// Mark a failed generation in both durable stores and propagate the error to
// every MySQL request row attached to this job.
function failDurableJob(videoId, message) {
  upsertLocalJob(videoId, { status: 'error', lastError: String(message || '').slice(0, 500) });
  syncJobToMysql(videoId, { status: 'error', last_error: String(message || '').slice(0, 1000) });
  const base = String(videoId).replace(/-karaoke$/, '');
  const entry = localJobs.jobs[base];
  for (const requestId of (entry && entry.mysqlRequestIds) || []) {
    updateMysqlRequestStatus({ mysqlRequestId: requestId }, 'error', message);
  }
}

// ── Post-success publish: catalog upsert + asset rows + R2 upload/verify ──
// Local `ready` comes from the validated bundle on the USB drive (the library
// rescan makes the song requestable immediately). Cloud durability is a
// separate, later `uploaded`/`verified` state per asset role.
const WRANGLER_BIN = path.join('/Users/macdonk/Documents/GitHub/Karol', 'node_modules', '.bin', 'wrangler');
const R2_BUCKET = process.env.KAROL_R2_BUCKET || 'karol';
const R2_MANIFEST_FILE = process.env.KAROL_R2_MANIFEST || path.join(os.homedir(), '.karol-r2-upload-manifest.json');

function sha256File(filePath) {
  const crypto = require('crypto');
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

function wranglerPut(key, filePath, mime) {
  return new Promise((resolve, reject) => {
    const proc = spawn(WRANGLER_BIN, [
      'r2', 'object', 'put', `${R2_BUCKET}/${key}`,
      '--file', filePath,
      '--content-type', mime,
      '--remote', '--force',
    ], { cwd: '/Users/macdonk/Documents/GitHub/Karol', stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(key);
      else reject(new Error(`wrangler put ${key} exited ${code}: ${stderr.slice(-300)}`));
    });
  });
}

function recordUploadInR2Manifest(rel, absPath, key) {
  try {
    let manifest = { version: 1, bucket: R2_BUCKET, files: {} };
    try { manifest = JSON.parse(fs.readFileSync(R2_MANIFEST_FILE, 'utf8')); } catch {}
    manifest.files = manifest.files || {};
    const stat = fs.statSync(absPath);
    manifest.files[rel] = { key, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs), uploadedAt: new Date().toISOString() };
    const temp = R2_MANIFEST_FILE + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(manifest, null, 2));
    fs.renameSync(temp, R2_MANIFEST_FILE);
  } catch (e) { console.error('[karol] R2 manifest update failed:', e.message); }
}

async function publishKaraokeAssets(videoId) {
  const base = String(videoId).replace(/-karaoke$/, '');
  const karaokeId = base + '-karaoke';
  const dir = library.LIBRARY_KARAOKE_DIR;
  const bundlePath = path.join(dir, karaokeId + '.bundle.json');

  // The bundle manifest is written last by the pipeline; if it is missing,
  // fall back to hashing whatever required files exist on disk.
  let bundle = null;
  try { bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8')); } catch {}
  const roleFiles = {
    media: karaokeId + '.mp4',
    lyrics: karaokeId + '.lrc.json',
    metadata: karaokeId + '.info.json',
  };
  for (const ext of ['.jpg', '.webp', '.png']) {
    if (fs.existsSync(path.join(dir, karaokeId + ext))) { roleFiles.thumbnail = karaokeId + ext; break; }
  }

  const assets = [];
  for (const [role, filename] of Object.entries(roleFiles)) {
    const abs = path.join(dir, filename);
    if (!fs.existsSync(abs)) {
      console.warn('[karol] Publish: missing', role, 'asset for', karaokeId, '—', filename);
      continue;
    }
    const stat = fs.statSync(abs);
    const fromBundle = bundle && bundle.files && bundle.files[filename];
    const sha = (fromBundle && fromBundle.sha256) || await sha256File(abs);
    assets.push({
      role,
      filename,
      abs,
      rel: 'karaoke/' + filename,
      key: 'library/karaoke/' + filename,
      size: stat.size,
      sha256: sha,
    });
  }
  if (!assets.some((a) => a.role === 'media')) {
    throw new Error('No karaoke mp4 on disk for ' + karaokeId);
  }

  if (!mysql) return;

  // 1) Catalog row for the karaoke VARIANT (distinct from the base row)
  const media = assets.find((a) => a.role === 'media');
  const lyrics = assets.find((a) => a.role === 'lyrics');
  const metadata = assets.find((a) => a.role === 'metadata');
  const thumb = assets.find((a) => a.role === 'thumbnail');
  let title = karaokeId;
  let duration = 0;
  let thumbnailUrl = '';
  let artist = '';
  try {
    const info = JSON.parse(fs.readFileSync(path.join(dir, roleFiles.metadata), 'utf8'));
    title = info.title || title;
    duration = info.duration || 0;
    thumbnailUrl = (info.thumbnail || '').replace(/\/(maxres|hq|sd|mq)default/, '/mqdefault');
    artist = info.uploader || '';
  } catch {}
  try {
    await mysql.catalogUpsertBatch([{
      video_id: karaokeId,
      title,
      artist,
      duration,
      tag: 'karaoke',
      source: 'karaoke-maker',
      thumbnail_url: thumbnailUrl,
      media_key: media.key,
      metadata_key: metadata ? metadata.key : '',
      lyrics_key: lyrics ? lyrics.key : '',
      local_relpath: media.rel,
      size_bytes: media.size,
      sha256: media.sha256,
      r2_uploaded: false,
      available_local: true,
    }]);
    await mysql.assetUpsertBatch(assets.map((a) => ({
      video_id: karaokeId,
      role: a.role,
      r2_key: a.key,
      local_relpath: a.rel,
      size_bytes: a.size,
      sha256: a.sha256,
      r2_state: 'pending',
    })));
    console.log('[karol] Publish: cataloged', karaokeId, 'with', assets.length, 'assets');
  } catch (e) {
    console.error('[karol] Publish: catalog upsert failed for', karaokeId, ':', e.message);
  }

  // 2) Upload required roles to R2 (cold durability — playback never waits on this)
  syncJobToMysql(base, { status: 'uploading', stage: 'uploading-r2' });
  const mimeByExt = { '.mp4': 'video/mp4', '.json': 'application/json', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.png': 'image/png' };
  const uploadedIds = [];
  for (const asset of assets) {
    try {
      const mime = mimeByExt[path.extname(asset.filename).toLowerCase()] || 'application/octet-stream';
      await wranglerPut(asset.key, asset.abs, mime);
      recordUploadInR2Manifest(asset.rel, asset.abs, asset.key);
      await mysql.assetMarkState(karaokeId, 'uploaded', [asset.role]);
      // 3) Verify small assets by re-download + sha256 compare; the mp4 stays
      // `uploaded` until the nightly sync verifies it.
      if (asset.size < 5 * 1024 * 1024) {
        const tempFile = path.join(os.tmpdir(), `karol-verify-${Date.now()}-${asset.filename}`);
        try {
          await new Promise((resolve, reject) => {
            const proc = spawn(WRANGLER_BIN, ['r2', 'object', 'get', `${R2_BUCKET}/${asset.key}`, '--file', tempFile, '--remote'],
              { cwd: '/Users/macdonk/Documents/GitHub/Karol', stdio: 'ignore' });
            proc.on('error', reject);
            proc.on('close', (code) => code === 0 ? resolve() : reject(new Error('get exited ' + code)));
          });
          const remoteSha = await sha256File(tempFile);
          if (remoteSha === asset.sha256) {
            await mysql.assetMarkState(karaokeId, 'verified', [asset.role]);
          } else {
            console.warn('[karol] Publish: sha mismatch after upload for', asset.key);
          }
        } finally {
          try { fs.unlinkSync(tempFile); } catch {}
        }
      }
      if (asset.role === 'media') uploadedIds.push(karaokeId);
      console.log('[karol] Publish: uploaded', asset.key);
    } catch (e) {
      console.error('[karol] Publish: R2 upload failed for', asset.key, ':', e.message, '(nightly sync will retry)');
    }
  }
  if (uploadedIds.length) {
    try { await mysql.catalogMarkR2Batch(uploadedIds); } catch (e) { console.error('[karol] Publish: mark R2 failed:', e.message); }
  }
  syncJobToMysql(base, { status: 'done', stage: 'done', progress: 100 });
}

function enqueueKaraokeJob(videoId, url, requester, mysqlRequestId) {
  // Already in queue or processing — attach this request to the same job
  if (karaokeQueue.some(e => e.videoId === videoId)) {
    console.log('[karol] Already queued:', videoId);
    attachRequestToLocalJob(videoId, requester, mysqlRequestId);
    return false;
  }
  // A finished plain download of the same id must not block a karaoke
  // generation request — only live/finished KARAOKE jobs dedupe here.
  const existingJob = processingJobs[videoId];
  if (existingJob && existingJob.status !== 'error'
      && !(existingJob.status === 'done' && existingJob.karaokify === false)) {
    console.log('[karol] Already processing:', videoId);
    attachRequestToLocalJob(videoId, requester, mysqlRequestId);
    return false;
  }
  registerDurableJob(videoId, url).then(() => {
    attachRequestToLocalJob(videoId, requester, mysqlRequestId);
  });
  karaokeQueue.push({ videoId, url, requester });
  console.log('[karol] Enqueued:', videoId, '(position:', karaokeQueue.length, ')');
  // Update processingJobs to show as queued with accurate positions
  processingJobs[videoId] = { status: 'queued', progress: 0, label: requester ? requester + ': ' + (url || videoId) : (url || videoId), url: url, karaokify: true, requester: requester, queuePosition: karaokeQueue.length };
  // Update queue positions for all queued entries
  for (let i = 0; i < karaokeQueue.length; i++) {
    const e = karaokeQueue[i];
    if (processingJobs[e.videoId] && processingJobs[e.videoId].status === 'queued') {
      processingJobs[e.videoId].queuePosition = i + 1;
    }
  }
  broadcastJobProgress();
  processNextKaraokeJob();
  return true;
}

function startKaraokePipeline(videoId, url, requester) {
  enqueueKaraokeJob(videoId, url, requester);
}

function broadcastJobProgress() {
  if (ctrlWin && !ctrlWin.isDestroyed()) {
    ctrlWin.webContents.send('download-progress', JSON.parse(JSON.stringify(processingJobs)));
  }
}

function pollDownloadProgress(videoId) {
  let lastProgress = -1;
  let stalledAt = 0;
  let lastSyncedMysqlStatus = '';
  const STAGE_MAP = {
    'starting': { status: 'downloading', stage: 'Starting pipeline...' },
    'downloading': { status: 'downloading', stage: 'Downloading video' },
    'demucs': { status: 'processing', stage: 'Separating vocals' },
    'whisper': { status: 'processing', stage: 'Transcribing lyrics' },
    'rendering': { status: 'processing', stage: 'Rendering video' },
  };
  // Local stage → durable karaoke_jobs.status
  const MYSQL_STAGE_MAP = {
    'starting': 'downloading',
    'downloading': 'downloading',
    'demucs': 'separating',
    'whisper': 'transcribing',
    'lyrics': 'transcribing',
    'rendering': 'rendering',
  };
  const interval = setInterval(() => {
    if (!processingJobs[videoId] || processingJobs[videoId].status === 'done' || processingJobs[videoId].status === 'error') {
      clearInterval(interval);
      return;
    }
    if (downloads) {
      const ds = downloads.getStatus(videoId);
      const mapped = STAGE_MAP[ds.status] || STAGE_MAP['downloading'];
      processingJobs[videoId].status = mapped.status;
      processingJobs[videoId].stage = mapped.stage;

      // Push real stage transitions to the durable MySQL job (throttled:
      // only when the mapped status changes, also extends the lease).
      // Only karaoke generations own a durable karaoke_jobs entry — plain
      // direct downloads must never create phantom job rows here.
      const mysqlStatus = MYSQL_STAGE_MAP[ds.status];
      if (mysqlStatus && mysqlStatus !== lastSyncedMysqlStatus && !processingJobs[videoId].isReLyric && processingJobs[videoId].karaokify) {
        lastSyncedMysqlStatus = mysqlStatus;
        upsertLocalJob(videoId, { status: 'running', stage: mysqlStatus });
        syncJobToMysql(videoId, {
          status: mysqlStatus,
          stage: mysqlStatus,
          progress: Math.round(processingJobs[videoId].progress || 0),
        });
      }

      if (ds.progress !== undefined && ds.progress > 0) {
        // yt-dlp reports 0-100% — Demucs/Whisper don't report percent, so only use it during download
        if (ds.status === 'downloading' || ds.status === 'starting') {
          processingJobs[videoId].progress = Math.min(90, ds.progress);
        }
        lastProgress = ds.progress;
        stalledAt = 0;
      } else if (ds.status === 'demucs') {
        processingJobs[videoId].progress = 30;
      } else if (ds.status === 'whisper') {
        processingJobs[videoId].progress = 60;
      } else if (ds.status === 'rendering') {
        processingJobs[videoId].progress = 80;
      } else if (!ds.downloading && ds.exists) {
        processingJobs[videoId].progress = 95;
      }

      // Timeout warning: if progress stays at 0 for 60s+
      if (processingJobs[videoId].progress === 0) {
        stalledAt += 2;
        if (stalledAt >= 60) {
          processingJobs[videoId].stage = 'Download starting — still trying...';
        }
      } else {
        stalledAt = 0;
      }
    }
    broadcastJobProgress();
  }, 2000);
}

function startDirectDownload(videoId, url, tag = 'music') {
  if (processingJobs[videoId] && processingJobs[videoId].status !== 'error') {
    return; // Already processing
  }

  processingJobs[videoId] = { status: 'downloading', progress: 0, label: url || videoId, karaokify: false, url: url, tag: tag };
  broadcastJobProgress();
  console.log('[karol] Starting direct download for:', videoId, '(tag: ' + tag + ')');

  if (!downloads) {
    processingJobs[videoId] = { status: 'error', progress: 0, label: videoId, errorMessage: 'Download module not available', karaokify: false, url: url };
    broadcastJobProgress();
    return;
  }

  downloads.start(videoId, false, url)
    .then((result) => {
      if (result.ok) {
        // Register in tags.json with the requested tag so the library picks it
        // up in the right bucket (yt_karaoke → 'karaoke', jukebox → 'music')
        if (library && typeof library.setTag === 'function') {
          library.setTag(videoId, tag);
        }
        processingJobs[videoId] = { status: 'done', progress: 100, label: videoId, karaokify: false, url: url };
        console.log('[karol] Direct download complete:', videoId);
        // Refresh queue title from metadata if we only had a placeholder
        try {
          const resolvedTitle = resolveTitleLocal(videoId);
          let changed = false;
          for (const item of queue) {
            if (item.videoId === videoId || item.videoId === videoId + '-karaoke') {
              if (looksLikeBareIdTitle(item.title, item.videoId)
                  && resolvedTitle && !looksLikeBareIdTitle(resolvedTitle, item.videoId)) {
                item.title = resolvedTitle;
                changed = true;
              }
            }
          }
          if (changed) {
            saveState();
            notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
            notifyPlayerQueue();
          } else {
            setTimeout(() => { fixBareIdQueueTitles('download-done:' + videoId).catch(() => {}); }, 500);
          }
        } catch (e) {}
        if (library && typeof library.init === 'function') {
          library.init(true).then(() => {
            notifyCtrl('library-scan-progress', { videoId, status: 'done' });
          });
        }
      } else {
        processingJobs[videoId] = { status: 'error', progress: 50, label: videoId, errorMessage: 'Download failed', karaokify: false, url: url, tag: tag };
      }
      broadcastJobProgress();
    })
    .catch((err) => {
      processingJobs[videoId] = { status: 'error', progress: 0, label: videoId, errorMessage: err.message, karaokify: false, url: url, tag: tag };
      broadcastJobProgress();
      console.error('[karol] Direct download error for', videoId, ':', err.message);
    });

  // Poll progress
  pollDownloadProgress(videoId);
}


// ── State ──
let queue = [];
let queueIndex = -1;
let playback = { videoId: null, currentTime: 0, duration: 0, state: 'idle' };
let volumeLevel = 1;
let skipRequested = false;

// ── State persistence ──
const STATE_FILE = path.join('/tmp', 'karol-state.json');

function saveState() {
  try {
    const filteredJobs = {};
    for (const [vid, job] of Object.entries(processingJobs)) {
      // Only persist non-error, non-done jobs that are still active
      if (job.status !== 'error' && job.status !== 'done') {
        filteredJobs[vid] = job;
      }
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify({ queue, queueIndex, jobs: filteredJobs }, null, 2));
  } catch (e) { console.error('[karol] State save failed:', e.message); }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (state.queue && Array.isArray(state.queue)) queue = state.queue;
      if (typeof state.queueIndex === 'number') queueIndex = state.queueIndex;
      console.log('[karol] Loaded state: ' + queue.length + ' queued, index ' + queueIndex);
      // Don't reload processingJobs from old session — they may not be running
    }
  } catch (e) { console.error('[karol] State load failed:', e.message); }
}

// ── Health check ──
async function runHealthCheck() {
  const results = {};
  try {
    // External drive
    const drivePath = process.env.KAROL_EXTERNAL_DRIVE || '/Volumes/maxone';
    results.drive = fs.existsSync(drivePath);
  } catch { results.drive = false; }
  try {
    // yt-dlp
    results.ytdlp = fs.existsSync('/opt/homebrew/bin/yt-dlp');
  } catch { results.ytdlp = false; }
  try {
    results.ffmpeg = fs.existsSync('/opt/homebrew/bin/ffmpeg');
  } catch { results.ffmpeg = false; }
  try {
    results.python3 = fs.existsSync('/opt/homebrew/bin/python3');
  } catch { results.python3 = false; }
  // Library count
  try {
    const cachePath = '/tmp/karol-library-cache.json';
    if (fs.existsSync(cachePath)) {
      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      results.libraryCount = cache.count || (cache.videos ? cache.videos.length : 0) || 0;
    } else { results.libraryCount = 0; }
  } catch { results.libraryCount = 0; }
  // API server health
  results.apiServer = (apiServerProcess && apiServerProcess.connected) ? true : false;

  // Exit any quick-start scan workers from previous session (non-blocking)
  try {
    const { execFile } = require('child_process');
    execFile('/usr/bin/pkill', ['-f', 'library-scan-worker'], { timeout: 3000 }, () => {});
  } catch {}

  // Clean stale temp dirs (>24h old)
  try {
    const tempBase = '/Users/macdonk/Documents/GitHub/Karol/.karol/karaoke-temp';
    if (fs.existsSync(tempBase)) {
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      for (const entry of fs.readdirSync(tempBase)) {
        const entryPath = path.join(tempBase, entry);
        try {
          const stat = fs.statSync(entryPath);
          if (stat.mtimeMs < oneDayAgo) {
            const { rmSync } = require('fs');
            rmSync(entryPath, { recursive: true, force: true });
            console.log('[karol] Cleaned stale temp:', entry);
          }
        } catch {}
      }
    }
  } catch {}
  
  return results;
}

// ── Windows ──
let ctrlWin = null;
let playWin = null;
let monitorWin = null;
let monitorModeEnabled = false;
let karaokePowerBlockerId = null;

let pendingPlay = null;
let isQuitting = false;

function isKaraokeActive() {
  return !!(playWin && !playWin.isDestroyed());
}

function getKaraokePowerStatus() {
  const active = isKaraokeActive();
  const onBattery = powerMonitor.isOnBatteryPower();
  const externalDisplayReady = !!getExternalDisplay();
  return {
    karaokeActive: active,
    powerBlockerActive: karaokePowerBlockerId !== null
      && powerSaveBlocker.isStarted(karaokePowerBlockerId),
    onBattery,
    externalDisplayReady,
    closedDisplayReady: active && !onBattery && externalDisplayReady,
    closedDisplayNote: active && !onBattery && externalDisplayReady
      ? 'Ready for macOS closed-display mode'
      : 'Connect external power and an external display before closing the lid',
  };
}

function updateKaraokePowerPolicy(reason) {
  const shouldBlock = isKaraokeActive();
  const blockerRunning = karaokePowerBlockerId !== null
    && powerSaveBlocker.isStarted(karaokePowerBlockerId);

  if (shouldBlock && !blockerRunning) {
    // Keeps the external HDMI display lit and prevents idle system suspension.
    // macOS itself still controls lid-close sleep; closed-display mode requires
    // external power + external display (and a wake-capable input device).
    karaokePowerBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    console.log('[karol] Karaoke power blocker started', karaokePowerBlockerId,
      reason ? `(${reason})` : '');
  } else if (!shouldBlock && blockerRunning) {
    powerSaveBlocker.stop(karaokePowerBlockerId);
    console.log('[karol] Karaoke power blocker stopped',
      reason ? `(${reason})` : '');
    karaokePowerBlockerId = null;
  }
}

// ── Window close handler — forces window destruction on macOS ──
// On macOS, BrowserWindow.close() hides the window instead of destroying it.
// We override this so the window is actually destroyed, which triggers
// window-all-closed for proper app quit.
function onWindowClose(e) {
  if (process.platform === 'darwin') {
    e.preventDefault();
    // Remove this listener to avoid re-entrancy, then destroy
    this.removeListener('close', onWindowClose);
    this.destroy();
  }
}

function resolveVid(videoId) {
  // Strip existing -karaoke suffix so we can re-check cleanly
  const baseId = videoId.replace(/-karaoke$/, '');
  try {
    if (library && fs.existsSync(path.join(library.LIBRARY_KARAOKE_DIR, baseId + '-karaoke.mp4'))) {
      return baseId + '-karaoke';
    }
  } catch {}
  return baseId;
}

// ── Queue title hygiene ──
// A raw YouTube id (11 chars, optionally '-karaoke') must never be shown as a
// song title. Resolution order: local info.json → tags.json → MySQL catalog →
// YouTube oEmbed. Until resolved, items display TITLE_PLACEHOLDER.
const TITLE_PLACEHOLDER = 'Loading title…';

function looksLikeBareIdTitle(title, videoId) {
  const t = String(title || '').trim();
  if (!t) return true;
  if (t === TITLE_PLACEHOLDER) return true;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^[A-Za-z0-9_-]{11}(-karaoke)?$/.test(t)) return true;
  if (/^Karaokifying/i.test(t)) return true;
  const vid = String(videoId || '');
  const base = vid.replace(/-karaoke$/, '');
  return t === vid || t === base;
}

/** Synchronous local lookup: info.json (base + karaoke variant), then tags.json. */
function resolveTitleLocal(videoId) {
  const vid = String(videoId || '');
  const base = vid.replace(/-karaoke$/, '');
  try {
    if (library && library.getMetadata) {
      const meta = library.getMetadata(base + '-karaoke') || library.getMetadata(base)
        || (vid !== base && vid !== base + '-karaoke' ? library.getMetadata(vid) : null);
      const t = meta && meta.title ? String(meta.title).trim() : '';
      if (t && !looksLikeBareIdTitle(t, vid)) return t;
    }
  } catch {}
  try {
    if (library && library.TAGS_PATH && fs.existsSync(library.TAGS_PATH)) {
      const tags = JSON.parse(fs.readFileSync(library.TAGS_PATH, 'utf8'));
      const entry = tags[base + '-karaoke'] || tags[vid] || tags[base] || {};
      const t = entry && entry.title ? String(entry.title).trim() : '';
      if (t && !looksLikeBareIdTitle(t, vid)) return t;
    }
  } catch {}
  return '';
}

/** oEmbed lookup returning { title, status }. status 4xx = permanently gone. */
function fetchYoutubeOembedInfo(videoId) {
  const base = String(videoId || '').replace(/-karaoke$/, '');
  return new Promise((resolve) => {
    if (!/^[A-Za-z0-9_-]{11}$/.test(base)) { resolve({ title: '', status: 0 }); return; }
    const https = require('https');
    const oembed = 'https://www.youtube.com/oembed?format=json&url=' +
      encodeURIComponent('https://www.youtube.com/watch?v=' + base);
    const req = https.get(oembed, { timeout: 8000 }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try {
          const t = res.statusCode === 200 ? JSON.parse(raw).title : '';
          resolve({ title: t ? String(t).trim().substring(0, 160) : '', status: res.statusCode });
        } catch { resolve({ title: '', status: res.statusCode }); }
      });
    });
    req.on('error', () => resolve({ title: '', status: 0 }));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ title: '', status: 0 }); });
  });
}

function fetchYoutubeOembedTitle(videoId) {
  return fetchYoutubeOembedInfo(videoId).then((r) => r.title);
}

/** Full async chain: local files → MySQL catalog → YouTube oEmbed. */
async function resolveTitleFull(videoId) {
  const local = resolveTitleLocal(videoId);
  if (local) return local;
  const vid = String(videoId || '');
  const base = vid.replace(/-karaoke$/, '');
  if (mysql && mysql.catalogGetPublic) {
    for (const key of [base + '-karaoke', base]) {
      try {
        const row = await mysql.catalogGetPublic(key);
        const t = row && row.title ? String(row.title).trim() : '';
        if (t && !looksLikeBareIdTitle(t, vid)) return t;
      } catch {}
    }
  }
  return fetchYoutubeOembedTitle(vid);
}

/**
 * Pick the best immediately-available title for a queue item. When nothing
 * real is known yet, returns TITLE_PLACEHOLDER and schedules an async pass
 * that heals the queue in place (never displays a raw video id).
 */
function bestTitleFor(videoId, suppliedTitle) {
  const supplied = String(suppliedTitle || '').trim();
  if (supplied && !looksLikeBareIdTitle(supplied, videoId)) return supplied;
  const local = resolveTitleLocal(videoId);
  if (local) return local;
  setTimeout(() => { fixBareIdQueueTitles('ingress:' + videoId).catch(() => {}); }, 250);
  return TITLE_PLACEHOLDER;
}

/** Display-safe title for player/phone payloads. */
function displayTitle(item) {
  if (!item) return '';
  if (!looksLikeBareIdTitle(item.title, item.videoId)) return item.title;
  return resolveTitleLocal(item.videoId) || TITLE_PLACEHOLDER;
}

let titleFixInFlight = false;
async function fixBareIdQueueTitles(reason) {
  if (titleFixInFlight) return;
  titleFixInFlight = true;
  try {
    let changed = false;
    for (const item of queue) {
      if (!item || !looksLikeBareIdTitle(item.title, item.videoId)) continue;
      let t = '';
      try { t = await resolveTitleFull(item.videoId); } catch {}
      if (t && !looksLikeBareIdTitle(t, item.videoId)) {
        console.log('[karol] Queue title healed (' + (reason || 'periodic') + '):', item.videoId, '→', t);
        item.title = t;
        changed = true;
      }
    }
    if (changed) {
      saveState();
      notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
      notifyPlayerQueue();
    }
  } finally {
    titleFixInFlight = false;
  }
}

function handlePlayerCrash() {
  const prevPlayWin = playWin;
  playWin = null;
  updateKaraokePowerPolicy('player-crash');

  // Try to destroy the crashed window
  try { if (prevPlayWin && !prevPlayWin.isDestroyed()) prevPlayWin.destroy(); } catch(e) {}

  // Recreate player and resume where we left off
  setTimeout(() => {
    console.log('[karol] Recreating player window after crash...');
    createPlayer();
    // Resume playback from current queue position on both HDMI + monitor
    if (queue.length > 0 && queueIndex >= 0 && queueIndex < queue.length) {
      if (playWin && !playWin.isDestroyed()) {
        pendingPlay = null;
        const resume = () => {
          if (queue.length > 0 && queueIndex >= 0 && queueIndex < queue.length) {
            sendToPlayers('player-event', {
              type: 'play', videoId: queue[queueIndex].videoId,
              isYouTube: false, title: displayTitle(queue[queueIndex]),
              requester: queue[queueIndex].singer || queue[queueIndex].requester,
              queue: queue, currentIndex: queueIndex,
            });
          }
        };
        playWin.webContents.once('did-finish-load', resume);
        if (!playWin.webContents.isLoading()) resume();
      }
    }
    notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
  }, 2000);
}

function getExternalDisplay() {
  const primary = screen.getPrimaryDisplay();
  const displays = screen.getAllDisplays();
  // Prefer a non-primary display (HDMI / HP monitor). If several, pick the largest.
  const externals = displays.filter(d => d.id !== primary.id);
  if (!externals.length) return null;
  externals.sort((a, b) => (b.bounds.width * b.bounds.height) - (a.bounds.width * a.bounds.height));
  return externals[0];
}

function placePlayerOnExternalDisplay(reason) {
  if (!playWin || playWin.isDestroyed()) return false;
  const ext = getExternalDisplay();
  if (!ext) {
    console.log('[karol] No external display for player' + (reason ? ` (${reason})` : ''));
    return false;
  }
  try {
    if (playWin.isFullScreen()) playWin.setFullScreen(false);
    playWin.setBounds(ext.bounds);
    playWin.setFullScreen(true);
    playWin.setAlwaysOnTop(true, 'screen-saver');
    playWin.show();
    console.log('[karol] Player → external display', ext.label || ext.id,
      `${ext.bounds.width}x${ext.bounds.height}` + (reason ? ` (${reason})` : ''));
    return true;
  } catch (e) {
    console.error('[karol] placePlayerOnExternalDisplay failed:', e.message);
    return false;
  }
}

function sendToPlayers(channel, msg) {
  if (playWin && !playWin.isDestroyed()) {
    try { playWin.webContents.send(channel, msg); } catch (e) {}
  }
  if (monitorWin && !monitorWin.isDestroyed()) {
    try { monitorWin.webContents.send(channel, msg); } catch (e) {}
  }
}

function createMonitor() {
  if (monitorWin && !monitorWin.isDestroyed()) {
    monitorWin.show();
    monitorWin.focus();
    return monitorWin;
  }
  const primary = screen.getPrimaryDisplay();
  const b = primary.workArea || primary.bounds;
  // Resizable singer window on the Mac — not fullscreen
  const w = Math.min(960, Math.max(640, Math.floor(b.width * 0.55)));
  const h = Math.min(540, Math.max(360, Math.floor(b.height * 0.55)));
  monitorWin = new BrowserWindow({
    x: b.x + Math.floor((b.width - w) / 2),
    y: b.y + Math.floor((b.height - h) / 2),
    width: w,
    height: h,
    minWidth: 480,
    minHeight: 270,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
    title: 'Karol Monitor (Singer)',
    backgroundColor: '#000000',
    show: true,
    fullscreen: false,
    alwaysOnTop: false,
  });
  monitorWin.webContents.on('console-message', (_e, _l, m) => console.log('[monitor]', m));
  monitorWin.on('closed', () => {
    monitorWin = null;
    monitorModeEnabled = false;
    notifyCtrl('monitor-mode', { enabled: false });
  });
  monitorWin.loadFile(PLAY_HTML, { query: { role: 'monitor' } });
  monitorWin.webContents.on('did-finish-load', () => {
    // Catch up with whatever the crowd player is showing
    notifyPlayerQueue();
    if (queueIndex >= 0 && queueIndex < queue.length) {
      const item = queue[queueIndex];
      const resolved = resolveVid(item.videoId);
      monitorWin.webContents.send('player-event', {
        type: 'play', videoId: resolved, isYouTube: false,
        title: displayTitle(item), requester: item.singer || item.requester,
        queue, currentIndex: queueIndex,
      });
      if (playback.state === 'paused') {
        setTimeout(() => {
          if (monitorWin && !monitorWin.isDestroyed()) {
            monitorWin.webContents.send('player-event', { type: 'pause' });
            if (playback.currentTime > 0) {
              monitorWin.webContents.send('player-event', { type: 'seek', time: playback.currentTime });
            }
          }
        }, 400);
      } else if (playback.currentTime > 0.5) {
        setTimeout(() => {
          if (monitorWin && !monitorWin.isDestroyed()) {
            monitorWin.webContents.send('player-event', { type: 'seek', time: playback.currentTime });
          }
        }, 500);
      }
    }
  });
  console.log('[karol] Monitor window opened on primary display');
  return monitorWin;
}

function setMonitorMode(enabled) {
  monitorModeEnabled = !!enabled;
  if (monitorModeEnabled) {
    if (!playWin || playWin.isDestroyed()) createPlayer();
    createMonitor();
  } else if (monitorWin && !monitorWin.isDestroyed()) {
    monitorWin.close();
    monitorWin = null;
  }
  notifyCtrl('monitor-mode', { enabled: monitorModeEnabled });
  return { ok: true, enabled: monitorModeEnabled };
}

function createPlayer() {
  if (playWin && !playWin.isDestroyed()) {
    placePlayerOnExternalDisplay('show-existing');
    playWin.show();
    playWin.focus();
    return;
  }

  console.log('[karol] Creating player window...');
  const ext = getExternalDisplay();
  const bounds = ext ? ext.bounds : { x: 0, y: 0, width: 1280, height: 720 };
  playWin = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
    title: 'Karol Player', backgroundColor: '#000000', show: true,
    fullscreen: !!ext,
    alwaysOnTop: !!ext,
  });
  updateKaraokePowerPolicy('player-opened');

  playWin.webContents.on('console-message', (e, l, m) => console.log('[player]', m));
  playWin.webContents.on('did-finish-load', () => {
    console.log('[karol] Player loaded');
    placePlayerOnExternalDisplay('did-finish-load');

    // Send initial queue state so marquee renders immediately
    notifyPlayerQueue();

    if (pendingPlay) {
      const p = pendingPlay; pendingPlay = null;
      sendToPlayers('player-event', {
        type: 'play', videoId: p.videoId, isYouTube: false, title: p.title, requester: p.requester,
        queue: queue, currentIndex: queueIndex,
      });
    }
  });

  // ── Dead man's switch: auto-recreate player on renderer crash ──
  playWin.webContents.on('crashed', () => {
    console.error('[karol] Player renderer CRASHED — auto-recovering in 2s');
    handlePlayerCrash();
  });
  playWin.webContents.on('render-process-gone', (_e, details) => {
    console.error('[karol] Player renderer GONE (reason=' + details.reason + ', exitCode=' + details.exitCode + ')');
    handlePlayerCrash();
  });

  // ── Player window close → null out reference (don't quit app) ──
  playWin.on('close', onWindowClose);
  playWin.on('closed', () => {
    playWin = null;
    updateKaraokePowerPolicy('player-closed');
  });
  playWin.loadFile(PLAY_HTML);
}

function getLanIp() {
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets || {})) {
      if (/^(en|wl|eth|wlan)/i.test(name)) {
        for (const addr of nets[name]) {
          if (addr.family === 'IPv4' && !addr.internal) return addr.address;
        }
      }
    }
  } catch (e) {}
  return '127.0.0.1';
}

function buildPhoneQueueItem(item, index) {
  const videoId = item.videoId || '';
  const baseId = String(videoId).replace(/-karaoke$/, '');
  return {
    id: index + ':' + videoId,
    url: 'https://www.youtube.com/watch?v=' + baseId,
    videoId,
    title: displayTitle(item),
    thumbnail: baseId ? ('https://i.ytimg.com/vi/' + baseId + '/hqdefault.jpg') : '',
    status: index === queueIndex
      ? (playback.state === 'playing' ? 'playing' : (playback.state === 'paused' ? 'queued' : 'playing'))
      : 'queued',
    requester: item.singer || item.requester || '',
    channelTitle: item.singer || item.requester || '',
  };
}

function buildPhoneQueueState() {
  const items = queue.map((item, i) => buildPhoneQueueItem(item, i));
  const current = queueIndex >= 0 && queueIndex < queue.length ? queue[queueIndex] : null;
  const baseId = current ? String(current.videoId || '').replace(/-karaoke$/, '') : '';
  return {
    ok: true,
    electronMode: true,
    queue: items,
    currentIndex: queueIndex,
    mode: 'queue',
    isPlaying: playback.state === 'playing',
    currentTitle: current ? displayTitle(current) : '',
    currentThumbnail: baseId ? ('https://i.ytimg.com/vi/' + baseId + '/hqdefault.jpg') : '',
    currentTime: playback.currentTime || 0,
    duration: playback.duration || 0,
    ...getKaraokePowerStatus(),
  };
}

function buildPhoneNowPlaying() {
  if (queueIndex < 0 || queueIndex >= queue.length) {
    return { title: '', videoId: '', thumbnail: '', currentTime: 0, duration: 0, state: -2 };
  }
  const item = queue[queueIndex];
  const baseId = String(item.videoId || '').replace(/-karaoke$/, '');
  const state = playback.state === 'playing' ? 1 : (playback.state === 'paused' ? 2 : (playback.state === 'ended' ? 0 : 2));
  return {
    ok: true,
    title: displayTitle(item),
    videoId: item.videoId,
    thumbnail: baseId ? ('https://i.ytimg.com/vi/' + baseId + '/hqdefault.jpg') : '',
    currentTime: playback.currentTime || 0,
    duration: playback.duration || 0,
    state,
    volumeLevel,
    requester: item.singer || item.requester || '',
    ...getKaraokePowerStatus(),
  };
}

function findQueueIndexById(id) {
  if (id == null || id === '') return -1;
  const asNum = Number(id);
  if (Number.isInteger(asNum) && asNum >= 0 && asNum < queue.length && String(asNum) === String(id)) {
    return asNum;
  }
  const s = String(id);
  // "index:videoId" form
  const m = s.match(/^(\d+):/);
  if (m) {
    const idx = parseInt(m[1], 10);
    if (idx >= 0 && idx < queue.length) return idx;
  }
  return queue.findIndex((item) => item.videoId === s || (item.id && item.id === s));
}

function handleDjApi(action, payload) {
  switch (action) {
    case 'status':
      return {
        ok: true,
        electronMode: true,
        hostMode: 'mac',
        status: 'online',
        djActive: true,
        castConnected: isKaraokeActive(),
        captureReady: isKaraokeActive(),
        showActive: isKaraokeActive(),
        queueLength: queue.length,
        currentTitle: queueIndex >= 0 && queue[queueIndex] ? displayTitle(queue[queueIndex]) : '',
        volumeLevel,
        ...getKaraokePowerStatus(),
      };
    case 'now-playing':
      return buildPhoneNowPlaying();
    case 'queue-get':
      return buildPhoneQueueState();
    case 'queue-add': {
      const videoId = payload.videoId || '';
      const requester = payload.requester || payload.singer || '';
      if (!videoId && payload.url) {
        const m = String(payload.url).match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
        if (m) payload.videoId = m[1];
      }
      const vid = resolveVid(payload.videoId || videoId);
      if (!vid) return { ok: false, error: 'No videoId' };
      const title = bestTitleFor(vid, payload.title);
      queue.push({ videoId: vid, title, singer: requester, requester });
      if (queueIndex < 0) {
        queueIndex = queue.length - 1;
        sendPlay(vid, title, requester);
      }
      saveState();
      notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
      notifyPlayerQueue();
      return { ok: true, videoId: vid, state: buildPhoneQueueState() };
    }
    case 'play-now': {
      const vid = resolveVid(payload.videoId);
      if (!vid) return { ok: false, error: 'No videoId' };
      const title = bestTitleFor(vid, payload.title);
      const requester = payload.requester || '';
      const existingIdx = queue.findIndex((item) => item.videoId === vid);
      let carriedMysqlId = null;
      if (existingIdx >= 0) {
        carriedMysqlId = queue[existingIdx].mysqlRequestId || null;
        queue.splice(existingIdx, 1);
      }
      queue.push({ videoId: vid, title, singer: requester, requester, mysqlRequestId: carriedMysqlId });
      skipRequested = true;
      clearBetweenSongsTimer();
      queueIndex = queue.length - 1;
      saveState();
      sendPlay(vid, title, requester);
      notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
      notifyPlayerQueue();
      return { ok: true, state: buildPhoneQueueState() };
    }
    case 'queue-remove': {
      let idx = payload.index;
      if (idx == null && payload.id != null) idx = findQueueIndexById(payload.id);
      if (idx == null || idx < 0 || idx >= queue.length) return { ok: false, error: 'Invalid index' };
      // Close the durable request so lease expiry can't resurrect it
      updateMysqlRequestStatus(queue[idx], 'ended', 'removed from queue');
      if (idx === queueIndex) {
        queue.splice(idx, 1);
        if (queue.length === 0) {
          queueIndex = -1;
          notifyPlayer({ type: 'stop' });
        } else {
          queueIndex = queueIndex >= queue.length ? 0 : queueIndex;
          clearBetweenSongsTimer();
          sendPlay(queue[queueIndex].videoId, queue[queueIndex].title, queue[queueIndex].singer);
        }
      } else {
        queue.splice(idx, 1);
        if (idx < queueIndex) queueIndex--;
      }
      saveState();
      notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
      notifyPlayerQueue();
      return { ok: true, state: buildPhoneQueueState() };
    }
    case 'queue-clear':
      for (const item of queue) updateMysqlRequestStatus(item, 'ended', 'queue cleared');
      queue = [];
      queueIndex = -1;
      playback = { videoId: null, currentTime: 0, duration: 0, state: 'idle' };
      clearBetweenSongsTimer();
      saveState();
      notifyPlayer({ type: 'stop' });
      notifyCtrl('queue-update', { queue: [], currentIndex: -1 });
      notifyPlayerQueue();
      return { ok: true, state: buildPhoneQueueState() };
    case 'queue-reorder': {
      const from = payload.fromIndex ?? payload.from;
      const to = payload.toIndex ?? payload.to;
      if (from < 0 || from >= queue.length || to < 0 || to >= queue.length) {
        return { ok: false, error: 'Invalid indices', state: buildPhoneQueueState() };
      }
      const [item] = queue.splice(from, 1);
      queue.splice(to, 0, item);
      if (from === queueIndex) queueIndex = to;
      else if (from < queueIndex && to >= queueIndex) queueIndex--;
      else if (from > queueIndex && to <= queueIndex) queueIndex++;
      saveState();
      notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
      notifyPlayerQueue();
      return { ok: true, state: buildPhoneQueueState() };
    }
    case 'queue-skip-to': {
      let idx = payload.index ?? payload.idx;
      if (idx == null && payload.id != null) idx = findQueueIndexById(payload.id);
      if (idx == null || idx < 0 || idx >= queue.length) return { ok: false, error: 'Invalid index' };
      skipRequested = true;
      clearBetweenSongsTimer();
      queueIndex = idx;
      saveState();
      sendPlay(queue[idx].videoId, queue[idx].title, queue[idx].singer || queue[idx].requester);
      notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
      notifyPlayerQueue();
      return { ok: true, state: buildPhoneQueueState(), nowPlaying: buildPhoneNowPlaying() };
    }
    case 'transport-play':
      return doTransportPlay();
    case 'transport-pause':
      return doTransportPause();
    case 'transport-skip':
      advanceQueue(1);
      return { ok: true, nowPlaying: buildPhoneNowPlaying(), state: buildPhoneQueueState() };
    case 'transport-prev':
      advanceQueue(-1);
      return { ok: true, nowPlaying: buildPhoneNowPlaying(), state: buildPhoneQueueState() };
    case 'transport-seek': {
      const seconds = Number(payload.seconds ?? payload.time ?? 0);
      notifyPlayer({ type: 'seek', time: seconds });
      playback.currentTime = seconds;
      return { ok: true, nowPlaying: buildPhoneNowPlaying() };
    }
    case 'transport-seek-relative': {
      const delta = Number(payload.delta ?? 0);
      const next = Math.max(0, (playback.currentTime || 0) + delta);
      notifyPlayer({ type: 'seek', time: next });
      playback.currentTime = next;
      return { ok: true, nowPlaying: buildPhoneNowPlaying() };
    }
    case 'transport-volume': {
      const level = Number(payload.level ?? payload.volume ?? 1);
      volumeLevel = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 1));
      notifyPlayer({ type: 'volume', level: volumeLevel });
      return { ok: true, volumeLevel, nowPlaying: buildPhoneNowPlaying() };
    }
    case 'fx-trigger': {
      const allowed = new Set(['sendit', 'applause', 'airhorn', 'fire', 'encore']);
      const name = String(payload.name || '');
      if (!allowed.has(name)) return { ok: false, error: 'Invalid FX' };
      if (!isKaraokeActive()) createPlayer();
      notifyPlayer({ type: 'fx', name });
      return { ok: true, name, ...getKaraokePowerStatus() };
    }
    case 'karaoke-power-status':
      return { ok: true, ...getKaraokePowerStatus() };
    default:
      return { ok: false, error: 'Unknown action: ' + action };
  }
}

function updateMysqlRequestStatus(item, status, error) {
  if (!item || !item.mysqlRequestId || !apiServerProcess || !apiServerProcess.connected) return;
  try {
    apiServerProcess.send({
      type: 'mysql-request-status',
      id: item.mysqlRequestId,
      status,
      error: error ? String(error).slice(0, 500) : '',
    });
  } catch (e) {
    console.error('[karol] MySQL request status IPC failed:', e.message);
  }
}

function sendPlay(videoId, title, requester) {
  clearBetweenSongsTimer();
  if (!playWin || playWin.isDestroyed()) {
    pendingPlay = { videoId, title, requester };
    createPlayer();
    return;
  }
  // Resolve to the best available file (karaoke vs regular)
  const resolved = resolveVid(videoId);
  // If the resolved ID differs from what's in the queue, update the queue entry
  if (resolved !== videoId && queueIndex >= 0 && queueIndex < queue.length) {
    const item = queue[queueIndex];
    if (item.videoId === videoId) {
      item.videoId = resolved;
      saveState();
    }
  }
  // Send play + full queue snapshot so player + monitor can render immediately
  sendToPlayers('player-event', {
    type: 'play', videoId: resolved, isYouTube: false,
    title: displayTitle({ title, videoId: resolved }),
    requester: requester || '',
    queue: queue, currentIndex: queueIndex,
  });
}

let betweenSongsTimer = null;
const BETWEEN_SONGS_MS = 10000;

function clearBetweenSongsTimer() {
  if (betweenSongsTimer) {
    clearTimeout(betweenSongsTimer);
    betweenSongsTimer = null;
  }
}

/** Payload for pause interstitial — prefer next singer, else current / paused tip. */
function buildPauseInterstitialPayload() {
  let singer = '';
  let title = '';
  let label = 'Up next';
  if (queue.length > 1 && queueIndex >= 0) {
    const next = queue[(queueIndex + 1) % queue.length];
    singer = String(next.singer || next.requester || '').trim();
    title = displayTitle(next);
    label = 'Up next';
  } else if (queueIndex >= 0 && queueIndex < queue.length) {
    const cur = queue[queueIndex];
    singer = String(cur.singer || cur.requester || '').trim() || 'Paused';
    title = displayTitle(cur);
    label = 'Paused';
  } else {
    singer = 'Paused';
    title = 'Scan QR to request a song';
    label = 'Paused';
  }
  return {
    type: 'pause-interstitial',
    singer: singer || 'Next up',
    title,
    label,
    queue,
    currentIndex: queueIndex,
  };
}

function doTransportPause() {
  // Don't interrupt natural between-songs auto-advance with a pause interstitial
  if (betweenSongsTimer) {
    notifyPlayer({ type: 'pause' });
    playback.state = 'paused';
    return { ok: true, nowPlaying: buildPhoneNowPlaying() };
  }
  // Show interstitial over a live (or already paused) track — never advance queue
  if (playback.state === 'playing' || playback.state === 'paused' || playback.videoId) {
    clearBetweenSongsTimer();
    sendToPlayers('player-event', buildPauseInterstitialPayload());
    playback.state = 'paused';
    notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
    return { ok: true, nowPlaying: buildPhoneNowPlaying() };
  }
  notifyPlayer({ type: 'pause' });
  playback.state = 'paused';
  return { ok: true, nowPlaying: buildPhoneNowPlaying() };
}

function doTransportPlay() {
  // Resume same paused track (reverse QR trip) — do not call sendPlay / advance
  if (playback.state === 'paused') {
    sendToPlayers('player-event', { type: 'resume' });
    playback.state = 'playing';
    return { ok: true, nowPlaying: buildPhoneNowPlaying() };
  }
  notifyPlayer({ type: 'play' });
  playback.state = 'playing';
  return { ok: true, nowPlaying: buildPhoneNowPlaying() };
}

/** Show next-singer + big QR for 10s, then start playback. */
function playAfterBetweenSongs(item) {
  if (!item) return;
  clearBetweenSongsTimer();
  const singer = String(item.singer || item.requester || '').trim();
  const title = displayTitle(item);
  sendToPlayers('player-event', {
    type: 'between-songs',
    singer: singer || 'Next up',
    title,
    queue,
    currentIndex: queueIndex,
  });
  notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
  notifyPlayerQueue();
  betweenSongsTimer = setTimeout(() => {
    betweenSongsTimer = null;
    sendPlay(item.videoId, item.title, item.singer || item.requester);
    notifyPlayerQueue();
  }, BETWEEN_SONGS_MS);
}

function advanceQueue(direction) {
  if (queue.length === 0) return;
  skipRequested = true;
  queueIndex = (queueIndex + direction + queue.length) % queue.length;
  const item = queue[queueIndex];
  saveState();
  playAfterBetweenSongs(item);
}

// Send queue state to player window whenever it changes
function notifyPlayerQueue() {
  sendToPlayers('player-event', {
    type: 'queue-update', queue: queue, currentIndex: queueIndex,
  });
}

function notifyCtrl(ch, data) {
  if (ctrlWin && !ctrlWin.isDestroyed()) ctrlWin.webContents.send(ch, data);
}
function notifyPlayer(msg) {
  sendToPlayers('player-event', msg);
}

// ── App ──
app.whenReady().then(async () => {
  console.log('[karol] Karol Electron');
  console.log('[karol] Displays:', screen.getAllDisplays().map(d => ({
    id: d.id, label: d.label, primary: d.id === screen.getPrimaryDisplay().id, bounds: d.bounds,
  })));

  // Hot-plug HDMI / external: move player onto the new screen automatically
  screen.on('display-added', (_e, display) => {
    console.log('[karol] Display added:', display.label || display.id, display.bounds);
    if (playWin && !playWin.isDestroyed()) {
      placePlayerOnExternalDisplay('display-added');
    } else {
      createPlayer();
    }
    updateKaraokePowerPolicy('display-added');
  });
  screen.on('display-removed', (_e, display) => {
    console.log('[karol] Display removed:', display.label || display.id);
    updateKaraokePowerPolicy('display-removed');
  });
  screen.on('display-metrics-changed', () => {
    placePlayerOnExternalDisplay('display-metrics-changed');
    updateKaraokePowerPolicy('display-metrics-changed');
  });
  powerMonitor.on('on-ac', () => {
    console.log('[karol] External power connected');
    updateKaraokePowerPolicy('on-ac');
  });
  powerMonitor.on('on-battery', () => {
    console.log('[karol] Running on battery');
    updateKaraokePowerPolicy('on-battery');
  });

  // Load library cache
  if (library && typeof library.init === 'function') {
    await library.init();
    console.log('[karol] Library ready');
  }

  // Restore persistent state
  loadState();

  // Heal any queue entries persisted with bare-id titles (older sessions):
  // resolve from library / MySQL catalog / oEmbed and notify all surfaces.
  setTimeout(() => {
    fixBareIdQueueTitles('startup').catch((e) => console.error('[karol] Title heal failed:', e.message));
  }, 4000);

  // Reclaim durable karaoke jobs from MySQL / local fallback: resume or
  // retry anything unfinished, mark jobs whose outputs already exist as done.
  setTimeout(() => {
    reclaimKaraokeJobs().catch((e) => console.error('[karol] Job reclaim failed:', e.message));
  }, 8000);

  // Run health check
  const health = await runHealthCheck();
  console.log('[karol] Health check:', JSON.stringify(health));
  notifyCtrl('health-report', health);

  // ── YouTube cookie refresh: once at startup, then every 2 hours ──
  // Exports Chrome's logged-in session into .karol/yt-cookies.txt for yt-dlp.
  function refreshYtCookies() {
    const cookiesPath = path.join('/Users/macdonk/Documents/GitHub/Karol', '.karol', 'yt-cookies.txt');
    try { fs.mkdirSync(path.dirname(cookiesPath), { recursive: true }); } catch {}
    const proc = spawn('/opt/homebrew/bin/yt-dlp', [
      '--cookies-from-browser', 'chrome',
      '--cookies', cookiesPath,
      '-s', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    ], { timeout: 60_000 });
    proc.on('close', (code) => {
      console.log('[karol] YouTube cookie refresh done (exit', code, ') →', cookiesPath);
    });
    proc.on('error', (e) => console.error('[karol] Cookie refresh error:', e.message));
  }
  refreshYtCookies();
  setInterval(refreshYtCookies, 2 * 60 * 60 * 1000);

  // ── Start API server for public domain access (with auto-respawn) ──
function startApiServer() {
  // Kill any orphan process on port 3131 from a previous crashed session
  try {
    const { execFileSync } = require('child_process');
    const pids = execFileSync('/usr/sbin/lsof', ['-tiTCP:3131', '-sTCP:LISTEN'], { timeout: 3000 })
      .toString().trim().split('\n').filter(Boolean);
    pids.forEach(pid => {
      try { process.kill(parseInt(pid), 'SIGKILL'); console.log('[karol] Killed orphan on port 3131, pid', pid); } catch {}
    });
  } catch { /* no process on port */ }

  const apiServerPath = path.join(process.resourcesPath, 'api-server', 'index.js');
  if (!fs.existsSync(apiServerPath)) {
    console.log('[karol] API server not found at', apiServerPath);
    return;
  }
  const nodeBin = process.execPath;
  apiServerProcess = fork(apiServerPath, [], {
    execPath: nodeBin,
    env: { ...process.env, PORT: '3131', ELECTRON_RUN_AS_NODE: '1' },
    silent: true,
    cwd: path.join(process.resourcesPath, 'api-server'),
  });
  // Don't let the API server prevent the app from exiting
  apiServerProcess.unref();
  apiServerProcess.stdout.on('data', (d) => console.log('[api-server]', d.toString().trim()));
  apiServerProcess.stderr.on('data', (d) => console.error('[api-server]', d.toString().trim()));
  
  // IPC message handlers (shared with respawn)
  const reactionTimes = []; // global flood guard: max 10 reactions/sec to the screen
  const handleApiMessage = (msg) => {
    if (msg && msg.type === 'crowd-reaction') {
      const now = Date.now();
      while (reactionTimes.length && now - reactionTimes[0] > 1000) reactionTimes.shift();
      if (reactionTimes.length < 10) {
        reactionTimes.push(now);
        notifyPlayer({ type: 'reaction', emoji: String(msg.emoji || '❤️').slice(0, 8) });
      }
    }
    if (msg && msg.type === 'web-karaoke-status') {
      const { videoId, requestId } = msg;
      const job = processingJobs[videoId] || null;
      apiServerProcess.send({
        type: 'web-karaoke-status-reply',
        videoId,
        requestId,
        job: job ? JSON.parse(JSON.stringify(job)) : null,
      });
    }
    if (msg && msg.type === 'dj-api') {
      const { requestId, action, payload } = msg;
      let result = { ok: false };
      try {
        result = handleDjApi(action, payload || {});
      } catch (e) {
        result = { ok: false, error: e.message };
      }
      try {
        apiServerProcess.send({ type: 'dj-api-reply', requestId, result });
      } catch (e) {
        console.error('[karol] dj-api reply failed:', e.message);
      }
    }
    if (msg && msg.type === 'web-karaoke-request') {
      const { videoId, url, requester, title, mysqlRequestId } = msg;
      console.log('[karol] Web karaoke request:', videoId, requester);
      // Also reserve a queue slot so the singer sees their place while it processes.
      // Each MySQL request id gets its own playback slot — several people may
      // request the same song; generation is deduped, slots are not.
      const baseId = String(videoId || '').replace(/-karaoke$/, '');
      const placeholderTitle = bestTitleFor(videoId, title);
      const slotForThisRequest = mysqlRequestId
        ? queue.find(item => item.mysqlRequestId === mysqlRequestId)
        : queue.find(item =>
            item.videoId === baseId || item.videoId === baseId + '-karaoke' || item.videoId === resolveVid(baseId));
      if (!slotForThisRequest && requester) {
        queue.push({
          videoId: baseId,
          title: placeholderTitle,
          singer: requester,
          requester,
          pendingKaraoke: true,
          mysqlRequestId: mysqlRequestId || null,
        });
        saveState();
        notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
        notifyPlayerQueue();
      }
      // ACK: durably accepted — MySQL row moves claimed → preparing
      if (mysqlRequestId) updateMysqlRequestStatus({ mysqlRequestId }, 'preparing');
      enqueueKaraokeJob(videoId, url, requester, mysqlRequestId || null);
    }
    if (msg && msg.type === 'web-queue-request') {
      const { videoId, title, requester, url, karaokeify, requestType, mysqlRequestId } = msg;
      const baseId = String(videoId || '').replace(/-karaoke$/, '');
      const vid = resolveVid(videoId);
      // Real title (never URL / bare id): supplied → info.json/tags → async heal
      const cleanTitle = bestTitleFor(vid, title);

      // A MySQL-backed request gets its own playback slot (multiple singers may
      // request the same song). Requests without a MySQL id dedupe by videoId.
      const slotForThisRequest = mysqlRequestId
        ? queue.find(item => item.mysqlRequestId === mysqlRequestId)
        : queue.find(item =>
            item.videoId === vid || item.videoId === baseId || item.videoId === baseId + '-karaoke');
      if (!slotForThisRequest) {
        queue.push({
          videoId: vid,
          title: cleanTitle,
          singer: requester || '',
          requester: requester || '',
          mysqlRequestId: mysqlRequestId || null,
        });
        saveState();
        if (queueIndex < 0) { queueIndex = queue.length - 1; sendPlay(vid, cleanTitle, requester); }
        notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
        notifyPlayerQueue();
        console.log('[karol] Web request queued:', vid, cleanTitle, requester);
      } else {
        // Fix title if queue still has a URL / bare-id placeholder
        const item = slotForThisRequest;
        if (item && looksLikeBareIdTitle(item.title, item.videoId)
            && !looksLikeBareIdTitle(cleanTitle, item.videoId)) {
          item.title = cleanTitle;
          item.videoId = resolveVid(item.videoId);
          saveState();
          notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
          notifyPlayerQueue();
        }
      }
      // ACK: durably accepted — MySQL row moves claimed → preparing
      if (mysqlRequestId) updateMysqlRequestStatus({ mysqlRequestId }, 'preparing');

      // Missing local file: karaoke only if the requester opted in; otherwise plain download.
      // Library picks that already exist never hit this branch (zero processing).
      const filePath = library && typeof library.getFilePath === 'function'
        ? library.getFilePath(vid)
        : null;
      const basePath = library && typeof library.getFilePath === 'function'
        ? library.getFilePath(baseId)
        : null;
      if (!filePath && !basePath) {
        const ytUrl = url || ('https://www.youtube.com/watch?v=' + baseId);
        const cloudResolve = library && typeof library.resolveFilePath === 'function'
          ? library.resolveFilePath(vid).then((p) => p || library.resolveFilePath(baseId))
          : Promise.resolve(null);
        cloudResolve.then((resolvedPath) => {
          if (resolvedPath) return;
          if (karaokeify || requestType === 'karaokify') {
            console.log('[karol] Web request missing cached media — karaoke pipeline (karaokify):', baseId);
            enqueueKaraokeJob(baseId, ytUrl, requester || '');
          } else if (requestType === 'yt_karaoke') {
            // Already a karaoke video on YouTube — direct download, tagged karaoke
            console.log('[karol] Web request missing cached media — direct download (yt_karaoke):', baseId);
            startDirectDownload(baseId, ytUrl, 'karaoke');
          } else {
            // jukebox (or legacy non-karaokeify): play-as-is music video
            console.log('[karol] Web request missing cached media — direct download (jukebox):', baseId);
            startDirectDownload(baseId, ytUrl, 'music');
          }
        }).catch((e) => console.error('[media-cache] playback resolve failed:', e.message));
      }
    }
    if (msg && msg.type === 'web-play-now') {
      const { videoId, title, requester } = msg;
      const vid = resolveVid(videoId);
      const cleanTitle = bestTitleFor(vid, title);
      const existingIdx = queue.findIndex(item => item.videoId === vid);
      let carriedMysqlId = null;
      if (existingIdx >= 0) {
        carriedMysqlId = queue[existingIdx].mysqlRequestId || null;
        queue.splice(existingIdx, 1);
      }
      queue.push({ videoId: vid, title: cleanTitle, singer: requester || '', requester: requester || '', mysqlRequestId: carriedMysqlId });
      saveState();
      skipRequested = true;
      queueIndex = queue.length - 1;
      sendPlay(vid, cleanTitle, requester);
      notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
      notifyPlayerQueue();
    }
    if (msg && msg.type === 'library-rescan') {
      console.log('[karol] Web-triggered library rescan:', msg.videoId);
      if (library && typeof library.init === 'function') {
        library.init(true).then(() => {
          notifyCtrl('library-scan-progress', { videoId: msg.videoId, status: 'done' });
        });
      }
    }
  };
  
  apiServerProcess.on('message', handleApiMessage);
  
  // Auto-respawn on crash (with 5s delay, max 3 attempts in 60s)
  let respawnCount = 0;
  let respawnWindow = Date.now();
  apiServerProcess.on('exit', (code) => {
    console.log('[api-server] exited with code', code);
    const now = Date.now();
    if (now - respawnWindow > 60000) { respawnCount = 0; respawnWindow = now; }
    respawnCount++;
    if (respawnCount > 3) {
      console.error('[karol] API server crashed 3+ times in 60s — giving up');
      apiServerProcess = null;
      return;
    }
    console.log('[karol] Respawning API server in 5s (attempt ' + respawnCount + ')...');
    setTimeout(() => {
      startApiServer();
    }, 5000);
  });
  
  apiServerProcess.on('error', (e) => console.error('[api-server] spawn error:', e.message));
  console.log('[karol] API server started on port 3131');
}

try { startApiServer(); } catch (e) { console.error('[karol] Failed to start API server:', e.message); }

  // ── Allow all device permissions (speaker/camera selection, etc.) ──
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    // This is a local karaoke app — grant all hardware access
    callback(true);
  });

  // Serve local media. stream:true privilege (registered above) is required so
  // Chromium can range-request large MP4s; without it playback stalls at t=0.
  // Prefer registerFileProtocol over protocol.handle(net.fetch) — the latter
  // has been observed to hard-crash this Electron build on external-drive files.
  protocol.registerFileProtocol('karol-file', (request, callback) => {
    try {
      let filePath = decodeURIComponent(String(request.url || '').replace(/^karol-file:\/\//i, ''));
      if (!filePath.startsWith('/')) filePath = '/' + filePath;
      filePath = filePath.replace(/^\/+/, '/');
      callback({ path: filePath });
    } catch (e) {
      console.error('[karol-file] Error:', request.url, e && e.message);
      callback({ error: -6 }); // FILE_NOT_FOUND
    }
  });

  // ── IPC ──

  ipcMain.on('player-state-report', (_e, s) => {
    if (!s) return;
    // Monitor is a muted mirror — ignore its reports so queue advance / UI status
    // stay driven by the crowd (HDMI) player only.
    if (s.role === 'monitor') return;

    if (s.videoId) playback.videoId = s.videoId;
    if (s.currentTime !== undefined) playback.currentTime = s.currentTime;
    if (s.duration) playback.duration = s.duration;
    if (s.state) playback.state = s.state;

    // Keep singer monitor locked to crowd player clock
    if (monitorWin && !monitorWin.isDestroyed() && typeof s.currentTime === 'number') {
      try {
        monitorWin.webContents.send('player-event', {
          type: 'sync-clock',
          time: s.currentTime,
          state: s.state || playback.state,
        });
      } catch (e) {}
    }

    if (s.state === 'ended') {
      if (skipRequested) {
        skipRequested = false;
      } else {
        if (queue.length > 0) {
          updateMysqlRequestStatus(queue[queueIndex], 'ended');
          queueIndex = (queueIndex + 1) % queue.length;
          // Guard: if queue was modified and index is now invalid, clamp
          if (queueIndex < 0 || queueIndex >= queue.length) queueIndex = 0;
          const item = queue[queueIndex];
          if (item) {
            saveState();
            playAfterBetweenSongs(item);
          }
        }
      }
    }
    if (s.state === 'error') {
      updateMysqlRequestStatus(queue[queueIndex], 'error', 'player reported error');
    }
    if (s.state === 'playing') {
      // The player ACTUALLY started — this is the only place a request is
      // marked `playing` in MySQL (never on IPC handoff).
      const current = queue[queueIndex];
      if (current && current.mysqlRequestId && !current.mysqlMarkedPlaying) {
        current.mysqlMarkedPlaying = true;
        updateMysqlRequestStatus(current, 'playing');
        saveState();
      }
    }
    if (s.state === 'playing' || s.state === 'error') {
      // New video started (or failed) — clear any stale skip flag
      skipRequested = false;
    }
    notifyCtrl('player-status', s);
  });

  ipcMain.handle('library-list', (_e, opts) => library ? library.list(opts || {}) : { ok: false });
  ipcMain.handle('library-metadata', (_e, vid) => library ? library.getMetadata(vid) : null);
  ipcMain.handle('library-tags', () => library ? library.getTags() : {});
  // Resolve display titles for remote-only library entries and persist them
  // into tags.json so each id is resolved only once. Local lookup first, then
  // concurrent oEmbed (no per-id MySQL round-trips — those made the original
  // sequential version take 30s+ per batch and the UI never caught up).
  ipcMain.handle('library-resolve-titles', async (_e, videoIds) => {
    const titles = {};
    const unavailable = [];
    const persist = {};
    const ids = (Array.isArray(videoIds) ? videoIds.slice(0, 25) : [])
      .filter((id) => /^[A-Za-z0-9_-]{11}(-karaoke)?$/.test(String(id || '')));
    const needNet = [];
    for (const id of ids) {
      const local = resolveTitleLocal(id);
      if (local) { titles[id] = local; persist[id] = { title: local }; }
      else needNet.push(id);
    }
    const CONC = 8;
    for (let i = 0; i < needNet.length; i += CONC) {
      const batch = needNet.slice(i, i + CONC);
      const results = await Promise.all(batch.map((id) =>
        fetchYoutubeOembedInfo(id).then((r) => ({ id, ...r })).catch(() => ({ id, title: '', status: 0 }))));
      for (const r of results) {
        if (r.title && !looksLikeBareIdTitle(r.title, r.id)) {
          titles[r.id] = r.title;
          persist[r.id] = { title: r.title };
        } else if (r.status >= 400 && r.status < 500) {
          // Deleted/private video — remember so we never retry.
          unavailable.push(r.id);
          persist[r.id] = { title_unavailable: true };
        }
      }
    }
    try {
      if (library && typeof library.mergeTagMetaBatch === 'function' && Object.keys(persist).length) {
        library.mergeTagMetaBatch(persist);
      }
    } catch {}
    return { titles, unavailable };
  });
  ipcMain.handle('library-set-tag', (_e, { videoId, tag, source }) => {
    if (!library) return { ok: false, error: 'library unavailable' };
    // Reclassify (tag AND source overwritten) when source is provided;
    // plain tag-only calls keep the legacy merge-preserving behavior.
    if (source !== undefined && typeof library.reclassify === 'function') {
      return library.reclassify(videoId, { tag, source });
    }
    library.setTag(videoId, tag);
    return { ok: true };
  });
  ipcMain.handle('library-status', (_e, vid) => library ? library.getStatus(vid) : { exists: false });
  ipcMain.handle('library-lyrics', (_e, vid) => library ? library.getLyrics(vid) : null);
  ipcMain.handle('library-file-path', async (_e, vid) => {
    if (!library) return null;
    return typeof library.resolveFilePath === 'function'
      ? library.resolveFilePath(vid)
      : library.getFilePath(vid);
  });
  ipcMain.handle('library-scan', async () => {
    if (library) await library.init(true);
    return { ok: true };
  });

  ipcMain.handle('queue-get', () => {
    var taggedQueue = queue.map(function(item) {
      var karaoke = false;
      var isCustom = false;
      var lyricSource = '';
      var lyricLabel = '';
      var hasLyrics = false;
      var vid = item.videoId;
      var lookupId = String(vid || '').replace(/-karaoke$/, '');
      try {
        var tags = library.getTags();
        karaoke = tags[lookupId]?.tag === 'karaoke' || tags[lookupId + '-karaoke']?.tag === 'karaoke';
        isCustom = tags[lookupId]?.source === 'karaoke-maker' || tags[lookupId + '-karaoke']?.source === 'karaoke-maker';
      } catch(e) { /* ignore */ }
      try {
        if (library && typeof library.getLyricProvenance === 'function') {
          var prov = library.getLyricProvenance(vid);
          if (!prov || !prov.hasLyrics) prov = library.getLyricProvenance(lookupId + '-karaoke');
          if (!prov || !prov.hasLyrics) prov = library.getLyricProvenance(lookupId);
          if (prov) {
            hasLyrics = !!prov.hasLyrics;
            lyricSource = prov.source || '';
            lyricLabel = prov.label || '';
          }
        }
      } catch(e) { /* ignore */ }
      return Object.assign({}, item, {
        karaoke: karaoke,
        isCustom: isCustom,
        hasLyrics: hasLyrics,
        lyricSource: lyricSource,
        lyricLabel: lyricLabel,
      });
    });
    return { ok: true, queue: taggedQueue, currentIndex: queueIndex };
  });

  ipcMain.handle('queue-add', (_e, { videoId, title, requester }) => {
    const vid = resolveVid(videoId);
    const cleanTitle = bestTitleFor(vid, title);
    queue.push({ videoId: vid, title: cleanTitle, singer: requester || '', requester: requester || '' });
    if (queueIndex < 0) { queueIndex = queue.length - 1; sendPlay(vid, cleanTitle, requester); }
    saveState();
    notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
    notifyPlayerQueue();
    return { ok: true };
  });

  ipcMain.handle('queue-play-now', (_e, { videoId, title, requester }) => {
    const vid = resolveVid(videoId);
    const cleanTitle = bestTitleFor(vid, title);
    const existingIdx = queue.findIndex(item => item.videoId === vid);
    if (existingIdx >= 0) {
      queue.splice(existingIdx, 1);
    }
    queue.push({ videoId: vid, title: cleanTitle, singer: requester || '', requester: requester || '' });
    skipRequested = true;
    queueIndex = queue.length - 1;
    saveState();
    sendPlay(vid, cleanTitle, requester);
    notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
    notifyPlayerQueue();
    return { ok: true };
  });

  ipcMain.handle('queue-remove', (_e, index) => {
    if (index < 0 || index >= queue.length) return { ok: false };
    updateMysqlRequestStatus(queue[index], 'ended', 'removed from queue');
    if (index === queueIndex) {
      queue.splice(index, 1);
      if (queue.length === 0) { queueIndex = -1; notifyPlayer({ type: 'stop' }); notifyPlayerQueue(); saveState(); }
      else { queueIndex = queueIndex >= queue.length ? 0 : queueIndex; sendPlay(queue[queueIndex].videoId, queue[queueIndex].title, queue[queueIndex].singer); }
    } else {
      queue.splice(index, 1);
      if (index < queueIndex) queueIndex--;
    }
    saveState();
    notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
    notifyPlayerQueue();
    return { ok: true };
  });

  ipcMain.handle('queue-clear', () => {
    for (const item of queue) updateMysqlRequestStatus(item, 'ended', 'queue cleared');
    queue = []; queueIndex = -1;
    playback = { videoId: null, currentTime: 0, duration: 0, state: 'idle' };
    saveState();
    notifyPlayer({ type: 'stop' });
    notifyCtrl('queue-update', { queue: [], currentIndex: -1 });
    notifyPlayerQueue();
    return { ok: true };
  });

  ipcMain.handle('queue-reorder', (_e, { from, to }) => {
    if (from < 0 || from >= queue.length || to < 0 || to >= queue.length) return { ok: false };
    const [item] = queue.splice(from, 1);
    queue.splice(to, 0, item);
    if (from === queueIndex) queueIndex = to;
    else if (from < queueIndex && to >= queueIndex) queueIndex--;
    else if (from > queueIndex && to <= queueIndex) queueIndex++;
    saveState();
    notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
    notifyPlayerQueue();
    return { ok: true };
  });

  ipcMain.handle('queue-skip-to', (_e, idx) => {
    if (idx < 0 || idx >= queue.length) return { ok: false };
    skipRequested = true;
    queueIndex = idx;
    saveState();
    sendPlay(queue[idx].videoId, queue[idx].title, queue[idx].singer || queue[idx].requester);
    notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
    notifyPlayerQueue();
    return { ok: true };
  });

  ipcMain.handle('status-get', () => ({
    ok: true, djActive: true, queueLength: queue.length,
    currentTitle: queue[queueIndex]?.title || '',
    currentTime: playback.currentTime, duration: playback.duration, state: playback.state,
  }));
  ipcMain.handle('now-playing', () => {
    if (queueIndex >= 0 && queueIndex < queue.length) {
      const item = queue[queueIndex];
      return { title: displayTitle(item), videoId: item.videoId, requester: item.singer, currentTime: playback.currentTime, duration: playback.duration, state: playback.state === 'playing' ? 1 : 2 };
    }
    return { title: '', state: -2 };
  });

  ipcMain.on('transport-play', () => { doTransportPlay(); });
  ipcMain.on('transport-pause', () => { doTransportPause(); });
  ipcMain.on('transport-skip', () => advanceQueue(1));
  ipcMain.on('transport-prev', () => advanceQueue(-1));
  ipcMain.on('transport-seek', (_e, t) => notifyPlayer({ type: 'seek', time: t }));
  ipcMain.on('transport-volume', (_e, l) => notifyPlayer({ type: 'volume', level: l }));
  ipcMain.on('fx-trigger', (_e, name) => notifyPlayer({ type: 'fx', name: String(name || '').slice(0, 24) }));
  ipcMain.on('toggle-lyric-slider', (_e, active) => {
    notifyPlayer({ type: 'toggle-lyric-slider', active });
  });
  ipcMain.on('toggle-full-lyrics', (_e, { videoId, show }) => {
    if (!show) {
      notifyPlayer({ type: 'toggle-full-lyrics', active: false, lines: null, title: '' });
      return;
    }
    try {
      var karaokeId = (videoId || '').replace(/-karaoke$/, '') + '-karaoke';
      var lyricsData = library ? library.getLyrics(karaokeId) : null;
      var lines = lyricsData && lyricsData.lines ? lyricsData.lines : [];
      var title = resolveTitleLocal(videoId) || '';
      notifyPlayer({ type: 'toggle-full-lyrics', active: true, lines: lines, title: title || 'Full Lyrics' });
    } catch(e) {
      console.error('[karol] toggle-full-lyrics error:', e.message);
      notifyPlayer({ type: 'toggle-full-lyrics', active: true, lines: [], title: 'Error loading lyrics' });
    }
  });

  ipcMain.on('launch-player', () => createPlayer());
  ipcMain.on('close-player', () => { if (playWin && !playWin.isDestroyed()) playWin.close(); });
  ipcMain.handle('monitor-mode-get', () => ({ enabled: !!(monitorModeEnabled && monitorWin && !monitorWin.isDestroyed()) }));
  ipcMain.handle('monitor-mode-set', (_e, { enabled }) => setMonitorMode(!!enabled));
  ipcMain.on('launch-monitor', () => setMonitorMode(true));
  ipcMain.on('close-monitor', () => setMonitorMode(false));

  ipcMain.handle('app-version', () => '3.1.0');
  ipcMain.handle('display-info', () => screen.getAllDisplays().map(d => ({ id: d.id, label: d.label, bounds: d.bounds, isPrimary: d.id === screen.getPrimaryDisplay().id })));
  ipcMain.handle('connection-info', () => {
    const lanIp = getLanIp();
    const port = 3131;
    const url = 'http://' + lanIp + ':' + port + '/dj-controller/';
    let qrDataUrl = '';
    try {
      const { execFileSync } = require('child_process');
      const out = path.join('/tmp', 'karol-phone-connect-qr.png');
      execFileSync('/opt/homebrew/bin/qrencode', ['-s', '8', '-m', '2', '-o', out, url], { timeout: 5000 });
      qrDataUrl = 'data:image/png;base64,' + fs.readFileSync(out).toString('base64');
    } catch (e) {
      console.warn('[karol] QR generate failed:', e.message);
    }
    return { ok: true, url, lanIp, port, qrDataUrl };
  });
  ipcMain.handle('karaoke-power-status', () => ({ ok: true, ...getKaraokePowerStatus() }));

  // ── Download / Request handlers ──
  ipcMain.handle('download-start', (_e, { videoId, karaoke, url, requestType }) => {
    if (processingJobs[videoId] && processingJobs[videoId].status !== 'error') {
      return { ok: false, error: 'Already processing' };
    }
    const ytUrl = url || 'https://www.youtube.com/watch?v=' + videoId;
    if (requestType === 'yt_karaoke') {
      startDirectDownload(videoId, ytUrl, 'karaoke');
    } else if (requestType === 'jukebox' || karaoke === false) {
      startDirectDownload(videoId, ytUrl, 'music');
    } else {
      startKaraokePipeline(videoId, ytUrl);
    }
    return { ok: true };
  });

  ipcMain.handle('download-status', (_e, videoId) => {
    if (processingJobs[videoId]) return processingJobs[videoId];
    if (downloads) {
      const ds = downloads.getStatus(videoId);
      return { downloading: ds.downloading, exists: ds.exists, status: ds.exists ? 'done' : 'idle', progress: ds.exists ? 100 : 0 };
    }
    return { downloading: false, exists: false, status: 'idle' };
  });

  ipcMain.handle('jobs-list', () => JSON.parse(JSON.stringify(processingJobs)));

  ipcMain.handle('request-add', (_e, { videoId, requester, title, url, karaoke, requestType }) => {
    if (!videoId) return { ok: false, error: 'No video ID' };
    const ytUrl = url || 'https://www.youtube.com/watch?v=' + videoId;
    // request_type wins when present; legacy boolean keeps old behavior
    // (karaoke === false → direct download, default → karaoke pipeline)
    if (requestType === 'yt_karaoke') {
      startDirectDownload(videoId, ytUrl, 'karaoke');
      return { ok: true, message: 'Direct download started — karaoke video will appear in library when ready' };
    }
    if (requestType === 'jukebox' || karaoke === false) {
      startDirectDownload(videoId, ytUrl, 'music');
      return { ok: true, message: 'Direct download started — video will appear in library when ready' };
    }
    startKaraokePipeline(videoId, ytUrl, requester || '');
    return { ok: true, message: 'Processing started — song will appear in library when ready' };
  });

  ipcMain.handle('request-list', () => {
    return [];
  });

  // ── By-name request matching (DJ attaches a video to a needs_match row) ──
  ipcMain.handle('queue-needs-match', async () => {
    if (!mysql) return { ok: false, error: 'MySQL unavailable', rows: [] };
    try {
      const rows = await mysql.requestListNeedsMatch(100);
      return { ok: true, rows: rows || [] };
    } catch (e) {
      return { ok: false, error: e.message, rows: [] };
    }
  });

  ipcMain.handle('queue-fill-match', async (_e, { id, videoId, url, requestType, title }) => {
    if (!mysql) return { ok: false, error: 'MySQL unavailable' };
    try {
      const result = await mysql.requestFillMatch(Number(id), {
        videoId: videoId || '',
        url: url || '',
        requestType: requestType || 'karaokify',
        title: title || '',
      });
      if (!result || result.ok === false) {
        return { ok: false, error: result?.error || 'fill_match failed' };
      }
      // Nudge the api-server claim loop so the matched request is picked up
      // immediately instead of waiting for the next 10s poll.
      if (apiServerProcess) {
        try { apiServerProcess.send({ type: 'trigger-request-sync' }); } catch {}
      }
      return { ok: true, id: Number(id), videoId: result.videoId || videoId || '', request_type: result.request_type || requestType };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── Health ──
  ipcMain.handle('health-check', async () => await runHealthCheck());

  // ── Retry failed pipeline job ──
  ipcMain.handle('retry-job', (_e, { videoId }) => {
    if (!processingJobs[videoId] || processingJobs[videoId].status !== 'error') {
      return { ok: false, error: 'Job not in error state' };
    }
    const url = processingJobs[videoId].url || 'https://www.youtube.com/watch?v=' + videoId;
    const karaokify = processingJobs[videoId].karaokify !== false;
    const requester = processingJobs[videoId].requester || '';
    const retryTag = processingJobs[videoId].tag || 'music';
    delete processingJobs[videoId];
    if (karaokify === false) {
      startDirectDownload(videoId, url, retryTag);
    } else {
      enqueueKaraokeJob(videoId, url, requester);
    }
    return { ok: true };
  });

  // ── Clear error jobs ──
  ipcMain.handle('clear-errors', () => {
    const toRemove = [];
    for (const [vid, job] of Object.entries(processingJobs)) {
      if (job.status === 'error') toRemove.push(vid);
    }
    for (const vid of toRemove) delete processingJobs[vid];
    // Also clear error entries from the queue
    for (let i = karaokeQueue.length - 1; i >= 0; i--) {
      if (toRemove.includes(karaokeQueue[i].videoId)) karaokeQueue.splice(i, 1);
    }
    broadcastJobProgress();
    return { ok: true, cleared: toRemove.length };
  });

  // ── Library rescan ──
  ipcMain.handle('library-rescan', async () => {
    if (library && typeof library.init === 'function') {
      // Delete the disk cache so init() rebuilds from scratch
      try { require('fs').unlinkSync('/tmp/karol-library-cache.json'); } catch(e) {}
      await library.init(true);
    }
    return { ok: true };
  });

  // ── Lyric reprocessing ──
  ipcMain.handle('reprocess-lyrics', (_e, { videoId, forceWhisper, lyricsText, whisperModel }) => {
    console.log('[karol] IPC: reprocess-lyrics received for:', videoId, 'forceWhisper:', forceWhisper, 'model:', whisperModel, 'lyrics:', lyricsText ? lyricsText.length + ' chars' : 'none');
    const karaokeId = videoId.replace(/-karaoke$/, '');
    const ytUrl = 'https://www.youtube.com/watch?v=' + karaokeId;

    // Already queued or processing (done/error are fine to replace)
    const checkId = karaokeId;
    const existing = processingJobs[checkId];
    if (existing && existing.status !== 'error' && existing.status !== 'done') {
      return { ok: false, error: 'Already in progress (' + existing.status + ')' };
    }
    if (karaokeQueue.some(e => e.videoId === checkId)) {
      return { ok: false, error: 'Already in progress (queued)' };
    }
    // Clear stale done/error entry so UI shows a fresh Re-Lyric job
    if (existing) delete processingJobs[checkId];

    console.log('[karol] Reprocessing lyrics for:', karaokeId, whisperModel ? '(model: ' + whisperModel + ')' : '', lyricsText ? '(custom lyrics: ' + lyricsText.length + ' chars)' : '');
    processingJobs[checkId] = { status: 'queued', progress: 0, label: 'Re-Lyric: ' + karaokeId + (whisperModel ? ' [' + whisperModel + ']' : '') + (lyricsText ? ' [+lyrics]' : ''), karaokify: true, isReLyric: true, queuePosition: karaokeQueue.length + 1 };
    broadcastJobProgress();

    // Queue reprocess as a special job (downloads.js handles --reprocess flag)
    karaokeQueue.push({
      videoId: karaokeId,
      url: ytUrl,
      requester: '',
      isReLyric: true,
      forceWhisper: !!forceWhisper,
      lyricsText: lyricsText || null,
      whisperModel: whisperModel || null,
    });
    const queuePos = karaokeQueue.length;
    const startedImmediately = !karaokeRunning;
    processNextKaraokeJob();
    return {
      ok: true,
      message: startedImmediately
        ? 'Re-lyric started'
        : ('Reprocessing queued (position: ' + queuePos + ')'),
    };
  });

  // ── Lyric offset persistence ──
  const TAGS_JSON = '/Volumes/maxone/Deskreen/tags.json';

  ipcMain.handle('get-lyric-provenance', (_e, videoId) => {
    if (!library || typeof library.getLyricProvenance !== 'function') {
      return { hasLyrics: false, label: 'No lyrics' };
    }
    const vid = String(videoId || '');
    const base = vid.replace(/-karaoke$/, '');
    return (
      library.getLyricProvenance(vid) ||
      library.getLyricProvenance(base + '-karaoke') ||
      library.getLyricProvenance(base) ||
      { hasLyrics: false, label: 'No lyrics' }
    );
  });

  ipcMain.handle('save-lyrics-lines', (_e, { videoId, lines }) => {
    if (!library || typeof library.saveLyricsLines !== 'function') {
      return { ok: false, error: 'Library unavailable' };
    }
    const result = library.saveLyricsLines(videoId, lines);
    if (result && result.ok) {
      // If this track is currently playing / loaded, push updated lyrics to player+monitor
      try {
        const ly = library.getLyrics(videoId);
        if (ly && ly.lines) {
          notifyPlayer({
            type: 'toggle-full-lyrics',
            active: true,
            lines: ly.lines,
            title: ly.title || videoId,
          });
          // Also nudge player to reload lyric engine on next progress tick via seek-noop
          if (playback.videoId && String(playback.videoId).replace(/-karaoke$/, '') === String(videoId).replace(/-karaoke$/, '')) {
            notifyPlayer({ type: 'lyrics-reload', videoId });
          }
        }
      } catch (e) {
        console.warn('[karol] lyrics reload notify failed:', e.message);
      }
      notifyCtrl('lyrics-updated', { videoId, provenance: result.provenance });
    }
    return result;
  });

  ipcMain.handle('get-lyric-offset', (_e, { videoId }) => {
    try {
      if (fs.existsSync(TAGS_JSON)) {
        const tags = JSON.parse(fs.readFileSync(TAGS_JSON, 'utf8'));
        const entry = tags[videoId] || tags[videoId + '-karaoke'] || {};
        return { ok: true, offset: entry.lyricOffset || 0 };
      }
    } catch (e) { console.error('[karol] get-lyric-offset error:', e.message); }
    return { ok: true, offset: 0 };
  });

  ipcMain.handle('save-lyric-offset', (_e, { videoId, offset }) => {
    try {
      // Update tags.json
      let tags = {};
      if (fs.existsSync(TAGS_JSON)) {
        tags = JSON.parse(fs.readFileSync(TAGS_JSON, 'utf8'));
      }
      const key = tags[videoId] ? videoId : (videoId + '-karaoke');
      if (!tags[key]) tags[key] = {};
      tags[key].lyricOffset = offset;
      fs.writeFileSync(TAGS_JSON, JSON.stringify(tags, null, 2));

      // Shift the LRC JSON timestamps if offset is non-zero
      if (Math.abs(offset) > 0.1) {
        const lrcPath = '/Volumes/maxone/Deskreen/karaoke/' + videoId.replace(/-karaoke$/, '') + '-karaoke.lrc.json';
        if (fs.existsSync(lrcPath)) {
          const lrc = JSON.parse(fs.readFileSync(lrcPath, 'utf8'));
          if (lrc.lines && Array.isArray(lrc.lines)) {
            for (const line of lrc.lines) {
              line.startTime = Math.max(0, (line.startTime || 0) + offset);
              line.endTime = Math.max(0.1, (line.endTime || 0) + offset);
              if (line.words) {
                for (const w of line.words) {
                  w.startTime = Math.max(0, (w.startTime || 0) + offset);
                  w.endTime = Math.max(0.01, (w.endTime || 0) + offset);
                }
              }
            }
            fs.writeFileSync(lrcPath, JSON.stringify(lrc, null, 2));
            console.log('[karol] Saved lyric offset', offset, 'for', videoId, '— LRC timestamps shifted');
          }
        }
      }

      // Notify player to reload lyrics with new offset
      if (playWin && !playWin.isDestroyed()) {
        playWin.webContents.send('player-event', { type: 'lyric-offset-updated', videoId, offset });
      }
      return { ok: true };
    } catch (e) {
      console.error('[karol] save-lyric-offset error:', e.message);
      return { ok: false, error: e.message };
    }
  });

  // ── DeepSeek / pipeline diagnosis ──
  ipcMain.handle('diagnose-lyrics', async (_e, { videoId }) => {
    try {
      const pyPath = '/opt/homebrew/bin/python3';
      const script = path.join(__dirname, '..', 'tools', 'make-karaoke-video.py');
      if (!require('fs').existsSync(script)) {
        return { ok: false, error: 'Pipeline script not found: ' + script };
      }

      const childCp = require('child_process');
      const proc = childCp.spawn(pyPath, [
        script,
        '--diagnose-only',
        videoId,
      ], {
        env: { ...process.env, PATH: process.env.PATH },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      return new Promise((resolve) => {
        proc.on('close', (code) => {
          const output = stdout + '\n' + stderr;
          console.log('[karol] diagnose-lyrics result:', output.slice(-500));

          // Try to read cached diagnosis from tags.json
          try {
            const tagsData = JSON.parse(require('fs').readFileSync(TAGS_JSON, 'utf8'));
            const entry = tagsData[videoId] || tagsData[videoId + '-karaoke'] || {};
            const diagnosis = entry.deepseek_diagnosis;
            if (diagnosis) {
              resolve({ ok: true, diagnosis, ruleBased: true });
              return;
            }
          } catch (_) {}

          resolve({ ok: true, output, code });
        });
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── Karaoke version search ──
  ipcMain.handle('find-karaoke', async (_e, { videoId }) => {
    try {
      // Search YouTube for karaoke versions directly via yt-dlp
      const childCp = require('child_process');

      // Resolve artist/title from tags.json or info.json
      let searchArtist = videoId;
      let searchTitle = videoId;
      try {
        if (fs.existsSync(TAGS_JSON)) {
          const tags = JSON.parse(fs.readFileSync(TAGS_JSON, 'utf8'));
          const entry = tags[videoId] || tags[videoId + '-karaoke'] || {};
          searchArtist = entry.artist || searchArtist;
          searchTitle = entry.title || searchTitle;
        }
      } catch (_) {}

      // Check for cached match first
      try {
        if (fs.existsSync(TAGS_JSON)) {
          const tags = JSON.parse(fs.readFileSync(TAGS_JSON, 'utf8'));
          const entry = tags[videoId] || tags[videoId + '-karaoke'] || {};
          if (entry.karaoke_video_id) {
            return { ok: true, matchedKaraokeId: entry.karaoke_video_id, introOffset: entry.karaoke_intro_offset || null };
          }
        }
      } catch (_) {}

      const searchQuery = 'ytsearch5:"' + searchArtist + ' ' + searchTitle + ' karaoke"';
      console.log('[karol] find-karaoke search:', searchQuery);

      const cookiesPath = path.join('/Users/macdonk/Documents/GitHub/Karol', '.karol', 'yt-cookies.txt');
      const authArgs = (fs.existsSync(cookiesPath) && fs.statSync(cookiesPath).size > 100)
        ? ['--cookies', cookiesPath]
        : ['--cookies-from-browser', 'chrome'];
      const proc = childCp.spawn('/opt/homebrew/bin/yt-dlp', [
        '--flat-playlist', '--dump-json', '--no-playlist',
        ...authArgs,
        searchQuery,
      ], {
        env: { ...process.env, PATH: process.env.PATH },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000,
      });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      return new Promise((resolve) => {
        proc.on('close', (code) => {
          const candidates = [];
          for (const raw of stdout.split('\n')) {
            const line = raw.trim();
            if (!line) continue;
            try {
              const info = JSON.parse(line);
              const vid = info.id || '';
              if (vid === videoId) continue;
              const vidTitle = info.title || '';
              const titleLower = vidTitle.toLowerCase();
              let score = 0;
              if (titleLower.includes('karaoke')) score += 10;
              if (titleLower.includes('instrumental')) score += 5;
              if (searchArtist.toLowerCase() !== videoId.toLowerCase()) {
                if (titleLower.includes(searchArtist.toLowerCase())) score += 3;
              }
              if (searchTitle.toLowerCase() !== videoId.toLowerCase()) {
                if (titleLower.includes(searchTitle.toLowerCase())) score += 3;
              }
              candidates.push({
                video_id: vid,
                title: vidTitle,
                duration: info.duration || null,
                channel: info.channel || info.uploader || '',
                score: score,
              });
            } catch (_) {}
          }
          candidates.sort((a, b) => b.score - a.score);
          console.log('[karol] find-karaoke found:', candidates.length, 'candidates');
          resolve({ ok: true, candidates: candidates.slice(0, 3) });
        });
        proc.on('error', (e) => {
          resolve({ ok: false, error: e.message });
        });
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('save-karaoke-match', async (_e, { videoId, karaokeVideoId }) => {
    try {
      let tags = {};
      if (require('fs').existsSync(TAGS_JSON)) {
        tags = JSON.parse(require('fs').readFileSync(TAGS_JSON, 'utf8'));
      }
      const key = tags[videoId] ? videoId : (videoId + '-karaoke');
      if (!tags[key]) tags[key] = {};
      tags[key].karaoke_video_id = karaokeVideoId;
      require('fs').writeFileSync(TAGS_JSON, JSON.stringify(tags, null, 2));
      console.log('[karol] Saved karaoke match:', karaokeVideoId, 'for', videoId);

      // Queue reprocess with the karaoke match
      const karaokeId = videoId.replace(/-karaoke$/, '');
      const ytUrl = 'https://www.youtube.com/watch?v=' + karaokeId;
      if (processingJobs[karaokeId] && processingJobs[karaokeId].status !== 'error' && processingJobs[karaokeId].status !== 'done') {
        return { ok: true, message: 'Match saved. Track is already processing.' };
      }

      processingJobs[karaokeId] = { status: 'queued', progress: 0, label: 'Re-Lyric+Scrape: ' + karaokeId, karaokify: true, isReLyric: true, queuePosition: karaokeQueue.length + 1, useKaraokeMatch: true };
      broadcastJobProgress();

      karaokeQueue.push({
        videoId: karaokeId,
        url: ytUrl,
        requester: '',
        isReLyric: true,
        forceWhisper: false,
        karaokeMatch: karaokeVideoId,
      });
      processNextKaraokeJob();
      return { ok: true, message: 'Match saved. Reprocessing queued.' };
    } catch (e) {
      console.error('[karol] save-karaoke-match error:', e.message);
      return { ok: false, error: e.message };
    }
  });

  // ── Create controller window ──
  const primary = screen.getPrimaryDisplay();
  ctrlWin = new BrowserWindow({
    width: 1200, height: 900, x: primary.workArea.x, y: primary.workArea.y,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
    title: 'Karol DJ Controller', backgroundColor: '#0a0a14',
  });
  ctrlWin.webContents.on('console-message', (e, l, m) => console.log('[ctrl]', m));
  ctrlWin.webContents.on('crashed', () => { console.error('[karol] Controller CRASHED'); ctrlWin = null; });
  ctrlWin.on('close', onWindowClose);
  ctrlWin.on('closed', () => { ctrlWin = null; });
  ctrlWin.loadFile(CTRL_HTML);

  console.log('[karol] Ready.');
});

app.on('window-all-closed', () => {
  if (apiServerProcess && !apiServerProcess.killed) {
    apiServerProcess.kill();
  }
  app.exit(0);
});

app.on('before-quit', () => {
  if (karaokePowerBlockerId !== null && powerSaveBlocker.isStarted(karaokePowerBlockerId)) {
    powerSaveBlocker.stop(karaokePowerBlockerId);
    karaokePowerBlockerId = null;
  }
  if (apiServerProcess && !apiServerProcess.killed) {
    apiServerProcess.kill();
    console.log('[karol] API server stopped');
  }
  app.exit(0);
});

app.on('activate', () => {
  // Recreate controller (and player if needed) when Dock icon is clicked
  if (!ctrlWin || ctrlWin.isDestroyed()) {
    const primary = screen.getPrimaryDisplay();
    ctrlWin = new BrowserWindow({
      width: 1200, height: 900, x: primary.workArea.x, y: primary.workArea.y,
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
      title: 'Karol DJ Controller', backgroundColor: '#0a0a14',
    });
    ctrlWin.on('close', onWindowClose);
    ctrlWin.on('closed', () => { ctrlWin = null; });
    ctrlWin.loadFile(CTRL_HTML);
  }
  if (!playWin || playWin.isDestroyed()) {
    createPlayer();
  }
});