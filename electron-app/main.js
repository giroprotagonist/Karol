// Karol Electron — Stable Architecture
// Absolute paths for modules, preload, and HTML to avoid resolution issues.

const { app, BrowserWindow, ipcMain, screen, protocol, session, powerSaveBlocker, powerMonitor, nativeImage, shell, desktopCapturer, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, fork } = require('child_process');
const os = require('os');
let apiServerProcess = null;

const APP_ICON_PATH = [
  path.join(__dirname, 'icon.png'),
  path.join(__dirname, 'build', 'icon.icns'),
  path.join(__dirname, 'build', 'icon-1024.png'),
].find((p) => fs.existsSync(p));
const APP_ICON = APP_ICON_PATH ? nativeImage.createFromPath(APP_ICON_PATH) : null;

/** Load translation / LLM keys into process.env if missing (LaunchAgent + .karol). */
function loadKarolSecretEnv() {
  const want = ['DEEPL_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_BASE', 'DEEPL_API_URL'];
  function applyFromPlist(plistPath) {
    try {
      if (!fs.existsSync(plistPath)) return;
      const { execFileSync } = require('child_process');
      for (const key of want) {
        if (process.env[key]) continue;
        try {
          const val = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :EnvironmentVariables:' + key, plistPath], { encoding: 'utf8' }).trim();
          if (val && val !== 'Print: Entry, :EnvironmentVariables:' + key + ', Does Not Exist') {
            process.env[key] = val;
          }
        } catch (_) {}
      }
    } catch (_) {}
  }
  applyFromPlist(path.join(os.homedir(), 'Library/LaunchAgents/com.rideyrbike.dispatch-local.plist'));
  applyFromPlist(path.join(os.homedir(), 'Library/LaunchAgents/com.karol-api.plist'));
  // Optional dotenv-style file: KEY=value lines
  const envFiles = [
    path.join(os.homedir(), '.karol', 'secrets.env'),
    path.resolve(__dirname, '..', '.karol', 'secrets.env'),
  ];
  for (const envFile of envFiles) {
    try {
      if (!fs.existsSync(envFile)) continue;
      const text = fs.readFileSync(envFile, 'utf8');
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        if (!process.env[m[1]] && want.includes(m[1])) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch (_) {}
  }
}
loadKarolSecretEnv();

/** Audio chain setup (BlackHole 44100 / output routing). */
let karolAudio = null;
try {
  const audioSetupPaths = [
    path.join(process.resourcesPath, 'scripts', 'karol-audio-setup.js'),
    path.resolve(__dirname, '..', 'scripts', 'karol-audio-setup.js'),
  ];
  for (const p of audioSetupPaths) {
    if (fs.existsSync(p)) {
      karolAudio = require(p);
      break;
    }
  }
} catch (e) {
  console.warn('[karol-audio] setup module failed:', e && e.message);
}

/** GUI/Dock launches omit Homebrew from PATH — fix once for all child processes. */
(function ensureHomebrewOnPath() {
  const hb = '/opt/homebrew/bin';
  const cur = process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin';
  if (!cur.split(':').includes(hb)) {
    process.env.PATH = hb + ':' + cur;
  }
})();

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
  if (playWin) { playWin.show(); }
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

// ── Gap Phone Mirror (USB scrcpy + BlackHole audio) ──
let phoneMirror = null;
try { phoneMirror = require(path.join(BASE, 'phone-mirror')); }
catch (e) { console.error('[karol] phone-mirror FAIL:', e.message); }

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
const BIRTHDAY_PLAYLIST_FILE = path.join('/Users/macdonk/Documents/GitHub/Karol', '.karol', 'birthday-playlist.json');

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
  const { videoId, url, requester, isReLyric, forceWhisper, karaokeMatch, lyricsText, whisperModel, lyricsTrack, mode, language, romanize } = entry;
  const isRetime = mode === 'retime' || !!entry.retimeKeepText;
  const isStems = mode === 'stems' || !!entry.rebuildStemsOnly;

  karaokeRunning = true;
  console.log('[karol] Karaoke queue: starting', videoId, '(remaining:', karaokeQueue.length, ')', isRetime ? '[retime]' : (isStems ? '[stems]' : ''));
  if (!isReLyric) {
    upsertLocalJob(videoId, { status: 'running', stage: 'downloading' });
    syncJobToMysql(videoId, { status: 'downloading', stage: 'downloading', progress: 0 });
  }

  const effectiveWhisperModel = whisperModel || ((isReLyric || isRetime) && !isStems ? 'large-v3' : null);
  const startLabel = isStems
    ? ('Rebuild stems: ' + videoId)
    : (isRetime
      ? ('Re-time: ' + videoId + (effectiveWhisperModel ? ' [' + effectiveWhisperModel + ']' : ''))
      : (isReLyric
        ? ('Re-Lyric: ' + videoId + (effectiveWhisperModel ? ' [' + effectiveWhisperModel + ']' : '') + (lyricsText ? ' [+lyrics]' : ''))
        : (requester ? requester + ': ' + (url || videoId) : (url || videoId))));
  processingJobs[videoId] = { status: isStems ? 'demucs' : (isRetime ? 'aligning' : 'downloading'), progress: 0, label: startLabel, url: url, karaokify: true, requester: requester, isReLyric: !!isReLyric, mode: mode || null };
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

  downloads.start(videoId, true, url, {
    isReLyric: entry.isReLyric,
    forceWhisper: entry.forceWhisper,
    karaokeMatch: karaokeMatch,
    lyricsText: lyricsText,
    whisperModel: effectiveWhisperModel,
    lyricsTrack: lyricsTrack || (entry.isReLyric ? 'sung' : 'sung'),
    mode: mode || (isRetime ? 'retime' : (isStems ? 'stems' : 'rebuild')),
    retimeKeepText: isRetime,
    rebuildStemsOnly: isStems,
    language: language || null,
    romanize: romanize || null,
  })
    .then((result) => {
      if (result.karaokeDone) {
        const doneLabel = isStems
          ? ('Stems done: ' + videoId)
          : (isRetime
            ? ('Re-time done: ' + videoId)
            : (isReLyric ? ('Re-Lyric done: ' + videoId) : videoId));
        processingJobs[videoId] = { status: 'done', progress: 100, label: doneLabel, url: url, karaokify: true, requester: requester, isReLyric: !!isReLyric, mode: mode || null };
        console.log('[karol] Pipeline complete:', videoId, result.message || '');
        if (isReLyric || isRetime || isStems) {
          try { notifyPlayer({ type: 'lyrics-reload', videoId }); } catch (_) {}
          if (isStems) {
            try { notifyPlayer({ type: 'stems-ready', videoId }); } catch (_) {}
            try { notifyCtrl('stems-ready', { videoId }); } catch (_) {}
          }
        }
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
          try { onMediaBecameReady(playId); } catch (e) {
            console.warn('[karol] onMediaBecameReady after karaoke failed:', e && e.message);
          }
        }
        // One new karaoke file must NOT force a full ExFAT library walk —
        // that looked like "why is it rescanning?" mid-show and dual-scanned
        // with the API worker until the Mac crawled. Instead, upsert just this
        // track into the library cache so the Custom tab shows it immediately.
        try {
          if (library && typeof library.upsertLibraryCacheEntry === 'function') {
            library.upsertLibraryCacheEntry(videoId);
          }
        } catch (e) {
          console.warn('[karol] Cache upsert after karaoke failed:', e && e.message);
        }
        notifyCtrl('library-scan-progress', { videoId, status: 'done' });
        try {
          if (library && typeof library.list === 'function') {
            const cur = library.list({}) || {};
            if (!cur.ok && typeof library.init === 'function') library.init(false);
          }
        } catch (_) {}
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
        try { invalidateMusicBrollPool(); } catch (_) {}
        // Promote any deferred play / idle queue row now that the file exists.
        try {
          onMediaBecameReady(videoId);
        } catch (e) {
          console.warn('[karol] onMediaBecameReady after download failed:', e && e.message);
        }
        try {
          const cur = queueIndex >= 0 && queue[queueIndex] ? queue[queueIndex] : null;
          const curId = cur ? String(cur.videoId || '') : '';
          const baseCur = curId.replace(/-karaoke$/, '');
          if (cur && (curId === videoId || baseCur === videoId || curId === videoId + '-karaoke')) {
            if (!mediaWait) {
              console.log('[karol] Re-playing after download:', videoId);
              sendPlay(cur.videoId, cur.title, cur.singer || cur.requester || '');
            }
          }
        } catch (e) {}
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
        // Same as karaoke-done: do not force a full USB rescan per download;
        // upsert the new file into the library cache instead.
        try {
          if (library && typeof library.upsertLibraryCacheEntry === 'function') {
            library.upsertLibraryCacheEntry(videoId);
          }
        } catch (e) {
          console.warn('[karol] Cache upsert after download failed:', e && e.message);
        }
        try {
          if (isBirthdayJukebox()) refreshBirthdayDeckLocals();
        } catch (_) {}
        notifyCtrl('library-scan-progress', { videoId, status: 'done' });
        try {
          if (library && typeof library.list === 'function') {
            const cur = library.list({}) || {};
            if (!cur.ok && typeof library.init === 'function') library.init(false);
          }
        } catch (_) {}
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
let queueShuffle = false;
let shufflePlayedIds = new Set(); // no-repeat within a shuffle cycle
/** Lightweight music-video radio — ids/titles only. Keeps the interactive karaoke
 *  queue small so 600+ MVs don't blow up IPC/DOM/lyric scans. */
let jukebox = null; // { items: [{videoId,title}], index, shuffle, kind?: 'birthday'|'music', name?: string }
let jukeboxPlayHistory = []; // deck indices for jukebox Prev (shuffle-safe)
const JUKEBOX_HISTORY_MAX = 120;
let playback = { videoId: null, currentTime: 0, duration: 0, state: 'idle' };
const DEFAULT_VOLUME = 0.55;
let volumeLevel = DEFAULT_VOLUME;
let vocalMixLevel = 0;
const DEFAULT_EQ = Object.freeze({ low: 0, mid: 0, high: 0 });
let musicEq = { low: 0, mid: 0, high: 0 };
let vocalEq = { low: 0, mid: 0, high: 0 };

function clampEqBand(n) {
  const v = Number(n);
  if (!isFinite(v)) return 0;
  return Math.max(-12, Math.min(12, v));
}

function normalizeEq(eq) {
  const src = eq && typeof eq === 'object' ? eq : {};
  return {
    low: clampEqBand(src.low),
    mid: clampEqBand(src.mid),
    high: clampEqBand(src.high),
  };
}
const DEFAULT_DJ_NAME = 'Naynay/Karolpdx';

/** Active filler DJ credit for empty / legacy DJ slots. */
function activeDjName() {
  return DEFAULT_DJ_NAME;
}

/** Show Naynay/Karolpdx whenever the singer slot is empty or the legacy "DJ" placeholder. */
function displaySingerName(raw) {
  const s = String(raw || '').trim();
  // Do not remap a real person named Naynay — only blanks / legacy DJ / retired Xtina.
  if (!s || /^dj$/i.test(s) || /^xtina$/i.test(s)) return DEFAULT_DJ_NAME;
  return s;
}

function healQueueSingerNames() {
  let changed = false;
  for (const item of queue) {
    if (!item) continue;
    const dj = DEFAULT_DJ_NAME;
    const singer = String(item.singer || '').trim();
    const requester = String(item.requester || '').trim();
    // Only fill blanks / legacy placeholders — never overwrite a real singer name.
    if (!singer || /^dj$/i.test(singer) || /^xtina$/i.test(singer)) {
      item.singer = dj;
      changed = true;
    }
    if (!requester || /^dj$/i.test(requester) || /^xtina$/i.test(requester)) {
      item.requester = dj;
      changed = true;
    }
  }
  return changed;
}

function normalizeQueueSinger(requester) {
  return displaySingerName(requester);
}
let skipRequested = false;
/** Suppress duplicate natural-end advances (destroyVideo / gap teardown can re-fire ended). */
let lastAdvanceAtMs = 0;
const ADVANCE_DEBOUNCE_MS = 1800;
/** True once the current feature track has reported real progress (t >= 1s). */
let featureTrackEverProgressed = false;
/** Absolute ms — ignore player `ended` until this time (teardown / play-now races). */
let ignoreEndedUntilMs = 0;
/** Bumps on every sendPlay so delayed error→advance timers cannot skip a newer track. */
let playEpoch = 0;

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
      if (healQueueSingerNames()) saveState();
      console.log('[karol] Loaded state: ' + queue.length + ' queued, index ' + queueIndex);
      // Don't auto-collapse large queues anymore — Queue All uses a real playlist.
      // Don't reload processingJobs from old session — they may not be running
    }
  } catch (e) { console.error('[karol] State load failed:', e.message); }
}

// ── Health check ──
async function runHealthCheck() {
  const results = {};
  try {
    // External drive — must be a real mount, not a ghost /Volumes folder
    const drivePath = (library && library.EXTERNAL_DRIVE)
      || process.env.KAROL_EXTERNAL_DRIVE
      || '/Volumes/maxone';
    results.drivePath = drivePath;
    if (library && typeof library.probeDrive === 'function') {
      const probe = library.probeDrive();
      results.drive = !!probe.mounted;
      results.driveReadable = !!probe.readable;
      results.driveGhost = !!probe.ghost;
      results.driveError = probe.error || '';
    } else {
      results.drive = fs.existsSync(drivePath);
      results.driveReadable = false;
      if (results.drive) {
        try {
          fs.accessSync(path.join(drivePath, 'Deskreen'), fs.constants.R_OK);
          results.driveReadable = true;
        } catch {
          results.driveReadable = false;
        }
      }
    }
  } catch { results.drive = false; results.driveReadable = false; }
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
  // Library count + live scan/disk status
  try {
    const cachePath = '/tmp/karol-library-cache.json';
    if (fs.existsSync(cachePath)) {
      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      results.libraryCount = cache.count || (cache.videos ? cache.videos.length : 0) || 0;
    } else { results.libraryCount = 0; }
  } catch { results.libraryCount = 0; }
  try {
    if (library && typeof library.refreshDiskStats === 'function') {
      results.libraryScan = library.refreshDiskStats({ recount: false });
      // Never scheduleDiskCount here — USB readdir freezes IPC.
    } else if (library && typeof library.getScanStatus === 'function') {
      results.libraryScan = library.getScanStatus();
    }
    if (results.libraryScan && results.libraryScan.catalogCount != null) {
      results.libraryCount = results.libraryScan.catalogCount || results.libraryCount;
    }
    if (results.libraryScan) {
      results.diskMediaCount = results.libraryScan.diskMediaCount || 0;
      results.diskByFolder = results.libraryScan.diskByFolder || {};
      results.scanning = results.libraryScan.status === 'scanning';
    }
  } catch (e) {
    results.libraryScan = { status: 'error', error: e.message };
  }
  // API server health
  results.apiServer = (apiServerProcess && apiServerProcess.connected) ? true : false;

  // UMC404HD + USB keep-awake (hub must stay powered for drive + interface)
  try {
    const { execFileSync } = require('child_process');
    const sas = process.env.SWITCH_AUDIO_SOURCE || '/opt/homebrew/bin/SwitchAudioSource';
    let umc = false;
    try {
      if (fs.existsSync(sas)) {
        const out = execFileSync(sas, ['-a'], { encoding: 'utf8', timeout: 3000 });
        umc = /UMC404HD/i.test(out);
      }
    } catch (_) {}
    results.umc = umc;
  } catch { results.umc = false; }
  try {
    const statusPath = '/tmp/karol-usb-keepawake.status';
    results.usbKeepAwakeAgent = false;
    results.usbKeepAwakeStatus = null;
    if (fs.existsSync(statusPath)) {
      const st = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      results.usbKeepAwakeStatus = st;
      const ageMs = Date.now() - Date.parse(st.ts || 0);
      results.usbKeepAwakeAgent = Number.isFinite(ageMs) && ageMs < 60_000;
    }
    results.usbKeepAwakeApp = usbKeepAwakeBlockerId !== null
      && powerSaveBlocker.isStarted(usbKeepAwakeBlockerId);
  } catch {
    results.usbKeepAwakeAgent = false;
    results.usbKeepAwakeApp = false;
  }

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
/** Thin screen-saver-level strip covering the macOS menu bar on the HDMI display.
 *  Needed when the player drops alwaysOnTop for scrcpy overlay (menu bar would otherwise show). */
let menuBarCoverWin = null;
let monitorModeEnabled = false;
let karaokePowerBlockerId = null;
let usbKeepAwakeBlockerId = null;
let usbKeepAwakeTimer = null;
let driveWatchTimer = null;
let lastDriveMounted = null;

let pendingPlay = null;
let isQuitting = false;

function getExternalDrivePath() {
  return (library && library.EXTERNAL_DRIVE)
    || process.env.KAROL_EXTERNAL_DRIVE
    || '/Volumes/maxone';
}

function isExternalDriveMounted() {
  if (library && typeof library.isDriveMounted === 'function') {
    return library.isDriveMounted();
  }
  try {
    const drivePath = getExternalDrivePath();
    if (!fs.existsSync(drivePath)) return false;
    return fs.statSync(drivePath).dev !== fs.statSync('/Volumes').dev;
  } catch {
    return false;
  }
}

/** Keep the Mac / USB bus from idling out the hub + external drive (+ UMC on that hub). */
function startUsbKeepAwake() {
  if (usbKeepAwakeBlockerId === null
      || !powerSaveBlocker.isStarted(usbKeepAwakeBlockerId)) {
    usbKeepAwakeBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    console.log('[karol] USB/system keep-awake started', usbKeepAwakeBlockerId);
  }
  if (usbKeepAwakeTimer) return;
  usbKeepAwakeTimer = setInterval(() => {
    try {
      const drivePath = getExternalDrivePath();
      if (!isExternalDriveMounted()) return;
      // Light I/O only — never readdir (ExFAT scandir can freeze the main process).
      fs.statSync(drivePath);
      const deskreen = path.join(drivePath, 'Deskreen');
      const tagsPath = path.join(deskreen, 'tags.json');
      const keepalivePath = path.join(deskreen, '.karol-keepawake');
      if (fs.existsSync(tagsPath)) {
        const fd = fs.openSync(tagsPath, 'r');
        const buf = Buffer.alloc(64);
        fs.readSync(fd, buf, 0, 64, 0);
        fs.closeSync(fd);
      }
      // Karol.app usually has Removable Volumes TCC; LaunchAgent often does not.
      try {
        fs.writeFileSync(keepalivePath, new Date().toISOString() + '\n', 'utf8');
      } catch (_) {
        try { fs.utimesSync(keepalivePath, new Date(), new Date()); } catch (_) {}
      }
    } catch (e) {
      // Drive may have been unplugged mid-interval
    }
  }, 15_000);
  if (typeof usbKeepAwakeTimer.unref === 'function') usbKeepAwakeTimer.unref();
}

function stopUsbKeepAwake() {
  if (usbKeepAwakeTimer) {
    clearInterval(usbKeepAwakeTimer);
    usbKeepAwakeTimer = null;
  }
  if (usbKeepAwakeBlockerId !== null && powerSaveBlocker.isStarted(usbKeepAwakeBlockerId)) {
    powerSaveBlocker.stop(usbKeepAwakeBlockerId);
    console.log('[karol] USB/system keep-awake stopped');
  }
  usbKeepAwakeBlockerId = null;
}

async function onExternalDriveAppeared() {
  console.log('[karol] External drive mounted:', getExternalDrivePath());
  try {
    if (library && typeof library.ensureLibraryDirs === 'function') {
      library.ensureLibraryDirs();
    }
    if (library && typeof library.invalidateListCache === 'function') {
      library.invalidateListCache();
    }
    try { fs.unlinkSync('/tmp/karol-library-cache.json'); } catch {}
    if (library && typeof library.init === 'function') {
      await library.init(true);
    }
    notifyCtrl('drive-status', { mounted: true, path: getExternalDrivePath() });
    const health = await runHealthCheck();
    notifyCtrl('health-report', health);
  } catch (e) {
    console.error('[karol] Drive remount rescan failed:', e.message);
  }
}

function onExternalDriveGone() {
  console.log('[karol] External drive missing:', getExternalDrivePath());
  if (library && typeof library.invalidateListCache === 'function') {
    library.invalidateListCache();
  }
  notifyCtrl('drive-status', { mounted: false, path: getExternalDrivePath() });
}

function maybePromptRemovableVolumeAccess() {
  try {
    const probe = (library && typeof library.probeDrive === 'function')
      ? library.probeDrive()
      : { mounted: isExternalDriveMounted(), readable: false, ghost: false, error: '' };
    if (probe.ghost) {
      console.warn('[karol] Ghost folder at', getExternalDrivePath(), '— remove it and remount the drive');
      return;
    }
    if (probe.mounted && !probe.readable) {
      console.warn('[karol] Drive mounted but not readable — grant Removable Volumes access');
      shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_RemovableVolumes'
      ).catch(() => {});
    }
  } catch {}
}

function startExternalDriveWatch() {
  if (driveWatchTimer) return;
  lastDriveMounted = isExternalDriveMounted();
  console.log('[karol] External drive watch:', lastDriveMounted ? 'mounted' : 'NOT mounted', getExternalDrivePath());
  // Skip ensureLibraryDirs here — USB mkdir can hang the main process.
  maybePromptRemovableVolumeAccess();
  if (lastDriveMounted && library && typeof library.list === 'function') {
    try {
      const cur = library.list({}) || {};
      if (!cur.ok && typeof library.refreshDiskStats === 'function') {
        library.refreshDiskStats({ recount: false });
      }
    } catch (_) {}
  }
  driveWatchTimer = setInterval(() => {
    const mounted = isExternalDriveMounted();
    if (mounted === lastDriveMounted) return;
    lastDriveMounted = mounted;
    if (mounted) onExternalDriveAppeared();
    else onExternalDriveGone();
  }, 5_000);
  if (typeof driveWatchTimer.unref === 'function') driveWatchTimer.unref();
}

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

function resolveVid(videoId, opts) {
  // Strip existing -karaoke suffix so we can re-check cleanly
  const raw = String(videoId || '');
  const baseId = raw.replace(/-karaoke$/, '');
  if (!baseId) return raw;
  const preferMusic = !!(opts && opts.preferMusic);

  // Explicit karaoke id → keep karaoke (Custom / singer queue), unless caller
  // forced a Music Video play.
  if (/-karaoke$/.test(raw) && !preferMusic) return raw;

  // Music Videos / DJ B-roll: if tags say music/song and songs/ (or a
  // non-karaoke local MV) exists, do NOT remap to the instrumental karaoke.
  // Dual-presence tracks (MV in songs/ + karaoke/{id}-karaoke.mp4) used to
  // always play the karaoke when opened from the Music Videos tab.
  try {
    if (library) {
      let tag = '';
      let source = '';
      try {
        const tags = typeof library.getTags === 'function' ? (library.getTags() || {}) : {};
        const entry = tags[baseId];
        if (typeof entry === 'string') tag = entry;
        else if (entry && typeof entry === 'object') {
          tag = entry.tag || '';
          source = entry.source || '';
        }
      } catch (_) { /* ignore */ }
      const isMusic = preferMusic
        || ((tag === 'music' || tag === 'song') && source !== 'karaoke-maker');
      if (isMusic) {
        const songsDir = library.LIBRARY_SONGS_DIR;
        const songsMp4 = songsDir ? path.join(songsDir, baseId + '.mp4') : null;
        if (songsMp4 && fs.existsSync(songsMp4) && fs.statSync(songsMp4).size >= 50_000) {
          return baseId;
        }
        // Fallback: any non-karaoke path (getVideoPath prefers songs/ now)
        try {
          const p = typeof library.getVideoPath === 'function' ? library.getVideoPath(baseId) : null;
          if (p && fs.existsSync(p) && fs.statSync(p).size >= 50_000
              && !/-karaoke\.mp4$/i.test(p)) {
            return baseId;
          }
        } catch (_) { /* ignore */ }
        if (preferMusic) return baseId;
      }
    }
  } catch (_) { /* ignore */ }

  // Default for singing: prefer pipeline karaoke when present.
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
            const row = queue[queueIndex];
            const karaoke = isKaraokeQueueItem(row);
            sendToPlayers('player-event', {
              type: 'play', videoId: row.videoId,
              isYouTube: false, title: displayTitle(row),
              requester: row.singer || row.requester,
              queue: queue, currentIndex: queueIndex,
              karaoke,
              fromJukebox: !karaoke,
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

/** Height of the menu-bar region on a display (bounds vs workArea). */
function menuBarHeightForDisplay(display) {
  if (!display || !display.bounds) return 0;
  const b = display.bounds;
  const wa = display.workArea || b;
  // Menu bar sits at the top of the display when workArea.y is below bounds.y
  const top = Math.max(0, Math.round((wa.y || 0) - (b.y || 0)));
  if (top > 0) return Math.min(48, top);
  // Some arrangements report equal y but a shorter workArea height
  const bottomDock = Math.max(0, Math.round((b.y + b.height) - (wa.y + wa.height)));
  const inferred = Math.max(0, Math.round(b.height - wa.height - bottomDock));
  return Math.min(48, inferred);
}

/**
 * Legacy black "menu cover" strip caused a visible top bar once menu-bar
 * auto-hide was enabled. Keep the helper as a destroy-only no-op so callers
 * don't recreate it; HDMI uses autohide + exact display.bounds instead.
 * Never toggles setSimpleFullScreen / setFullScreen for phone mirror.
 */
function destroyMenuBarCoverWindow() {
  if (!menuBarCoverWin || menuBarCoverWin.isDestroyed()) {
    menuBarCoverWin = null;
    return;
  }
  try { menuBarCoverWin.destroy(); } catch (_) {}
  menuBarCoverWin = null;
}

function ensureMenuBarCover(reason) {
  if (menuBarCoverWin && !menuBarCoverWin.isDestroyed()) {
    destroyMenuBarCoverWindow();
    if (reason) console.log('[karol] Menu bar cover removed', reason || '');
  }
  return false;
}

let menuBarCoverTimer = null;
/** Previous System Events "autohide menu bar" value — restore on quit. */
let savedMenuBarAutohide = null;
let menuBarAutohideApplied = false;

function setSystemMenuBarAutohide(hide) {
  try {
    const { execFileSync } = require('child_process');
    if (savedMenuBarAutohide === null) {
      try {
        const cur = execFileSync('/usr/bin/osascript', [
          '-e', 'tell application "System Events" to get autohide menu bar of dock preferences',
        ], { encoding: 'utf8', timeout: 4000 }).trim().toLowerCase();
        savedMenuBarAutohide = cur === 'true';
      } catch (_) {
        savedMenuBarAutohide = false;
      }
    }
    execFileSync('/usr/bin/osascript', [
      '-e', `tell application "System Events" to set autohide menu bar of dock preferences to ${hide ? 'true' : 'false'}`,
    ], { encoding: 'utf8', timeout: 4000 });
    return true;
  } catch (e) {
    console.warn('[karol] menu bar autohide failed:', e && e.message);
    return false;
  }
}

function enableKaraokeMenuBarHide() {
  if (menuBarAutohideApplied) return;
  if (setSystemMenuBarAutohide(true)) menuBarAutohideApplied = true;
}

function restoreKaraokeMenuBarHide() {
  if (savedMenuBarAutohide === null) return;
  try {
    const { execFileSync } = require('child_process');
    execFileSync('/usr/bin/osascript', [
      '-e', `tell application "System Events" to set autohide menu bar of dock preferences to ${savedMenuBarAutohide ? 'true' : 'false'}`,
    ], { encoding: 'utf8', timeout: 4000 });
  } catch (_) {}
  savedMenuBarAutohide = null;
  menuBarAutohideApplied = false;
}

function startMenuBarCoverWatch() {
  // Keep autohide on once; never recreate the black cover strip or spam Dock prefs.
  if (menuBarCoverTimer) return;
  destroyMenuBarCoverWindow();
  enableKaraokeMenuBarHide();
  menuBarCoverTimer = setInterval(() => {
    if (!playWin || playWin.isDestroyed()) {
      stopMenuBarCoverWatch();
      destroyMenuBarCoverWindow();
      return;
    }
    if (!getExternalDisplay()) return;
    destroyMenuBarCoverWindow();
  }, 30000);
}
function stopMenuBarCoverWatch() {
  if (menuBarCoverTimer) {
    clearInterval(menuBarCoverTimer);
    menuBarCoverTimer = null;
  }
}

function destroyMenuBarCover() {
  stopMenuBarCoverWatch();
  destroyMenuBarCoverWindow();
}

let placePlayerLockUntilMs = 0;
let placePlayerDebounceTimer = null;
let lastPlacedDisplayKey = '';

function displayBoundsKey(bounds) {
  if (!bounds) return '';
  return [bounds.x, bounds.y, bounds.width, bounds.height].join(',');
}

function boundsMatchExact(a, b, tol) {
  const t = tol == null ? 2 : tol;
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) <= t
    && Math.abs(a.y - b.y) <= t
    && Math.abs(a.width - b.width) <= t
    && Math.abs(a.height - b.height) <= t;
}

/** HDMI player stays above show content on the external display only.
 *  'floating' keeps it under macOS Cmd+Tab / Mission Control on the MacBook. */
const PLAYER_HDMI_AOT_LEVEL = 'floating';
let playerHdmiPresentationReady = false;

function setPlayerHdmiPresentation(reason, force) {
  if (!playWin || playWin.isDestroyed()) return;
  if (phoneMirrorOverlayActive) return;
  if (!getExternalDisplay()) return;
  if (playerHdmiPresentationReady && !force) return;
  try {
    playWin.setAlwaysOnTop(true, PLAYER_HDMI_AOT_LEVEL);
  } catch (_) {
    try { playWin.setAlwaysOnTop(true); } catch (__) {}
  }
  try {
    playWin.setVisibleOnAllWorkspaces(false);
  } catch (_) {}
  playerHdmiPresentationReady = true;
  if (reason) console.log('[karol] Player presentation', PLAYER_HDMI_AOT_LEVEL, reason);
}

function getControllerWindowBounds() {
  const primary = screen.getPrimaryDisplay();
  const wa = primary.workArea || primary.bounds;
  const width = Math.max(640, Math.min(1200, Math.round(wa.width * 0.52)));
  const height = Math.max(700, Math.round(wa.height * 0.94));
  return {
    width,
    height,
    x: wa.x,
    y: wa.y,
  };
}

function createControllerWindow() {
  const bounds = getControllerWindowBounds();
  const win = new BrowserWindow({
    ...windowIconOpts(),
    ...bounds,
    minWidth: 560,
    minHeight: 640,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
    title: 'Karol DJ Controller', backgroundColor: '#0a0a14',
  });
  win.webContents.on('console-message', (e, l, m) => console.log('[ctrl]', m));
  win.webContents.on('crashed', () => { console.error('[karol] Controller CRASHED'); ctrlWin = null; });
  win.on('close', onWindowClose);
  win.on('closed', () => { ctrlWin = null; });
  wireControllerFocusHandlers(win);
  win.loadFile(CTRL_HTML);
  return win;
}

function wireControllerFocusHandlers(win) {
  if (!win || win.__karolFocusWired) return;
  win.__karolFocusWired = true;
  win.on('focus', () => {
    setPlayerHdmiPresentation('controller-focus');
  });
}

function playerCenterOnDisplay(win, display) {
  if (!win || !display || !display.bounds) return false;
  try {
    const b = win.getBounds();
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const d = display.bounds;
    return cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height;
  } catch (_) {
    return false;
  }
}

/**
 * Cover the dedicated HDMI karaoke display edge-to-edge using full
 * display.bounds (not workArea). Avoid macOS simpleFullscreen / Spaces
 * fullscreen — on arranged externals those can seat the window with a
 * Y offset (wallpaper peek). Never toggle FS modes from phone-mirror paths.
 */
function placePlayerOnExternalDisplay(reason) {
  if (!playWin || playWin.isDestroyed()) return false;
  const now = Date.now();
  // Our own setBounds can fire display-metrics-changed on macOS.
  if (now < placePlayerLockUntilMs && reason === 'display-metrics-changed') {
    return false;
  }
  const ext = getExternalDisplay();
  if (!ext) {
    console.log('[karol] No external display for player' + (reason ? ` (${reason})` : ''));
    return false;
  }
  const target = {
    x: Math.round(ext.bounds.x),
    y: Math.round(ext.bounds.y),
    width: Math.round(ext.bounds.width),
    height: Math.round(ext.bounds.height),
  };
  const key = String(ext.id) + '@' + displayBoundsKey(target);
  let cur;
  try { cur = playWin.getBounds(); } catch (_) { cur = null; }
  const alreadyThere = playerCenterOnDisplay(playWin, ext) && boundsMatchExact(cur, target);
  if (alreadyThere && (reason === 'display-metrics-changed' || key === lastPlacedDisplayKey)) {
    lastPlacedDisplayKey = key;
    return true;
  }
  try {
    placePlayerLockUntilMs = now + 2500;
    // Exit leftover FS/SFS from older builds once, then pin exact bounds.
    // Do not re-enter FS — frameless + exact bounds covers HDMI flush.
    if (playWin.isFullScreen && playWin.isFullScreen()) {
      try { playWin.setFullScreen(false); } catch (_) {}
    }
    if (typeof playWin.isSimpleFullScreen === 'function' && playWin.isSimpleFullScreen()) {
      try { playWin.setSimpleFullScreen(false); } catch (_) {}
    }
    playWin.setBounds(target, false);
    try {
      // Content bounds = full display (frameless). Re-assert both APIs —
      // setBounds alone can leave a 1–2px wallpaper hairline on arranged HDMI.
      if (typeof playWin.setContentBounds === 'function') {
        playWin.setContentBounds(target);
      }
    } catch (_) {}
    // Keep always-on-top off while HDMI phone overlay is active so scrcpy stays visible
    setPlayerHdmiPresentation(reason || 'place-player');
    playWin.show();
    // Cover menu bar on HDMI (player AOT may be dropped during phone overlay)
    ensureMenuBarCover(reason || 'place-player');
    enableKaraokeMenuBarHide();
    startMenuBarCoverWatch();
    // Re-assert after macOS settles (SFS exit / multi-display arrange).
    setTimeout(() => {
      if (!playWin || playWin.isDestroyed()) return;
      try {
        const b = playWin.getBounds();
        if (!boundsMatchExact(b, target)) {
          playWin.setBounds(target, false);
          if (typeof playWin.setContentBounds === 'function') {
            try { playWin.setContentBounds(target); } catch (_) {}
          }
          console.log('[karol] Player bounds re-asserted', target);
        }
      } catch (_) {}
      ensureMenuBarCover('re-assert');
      enableKaraokeMenuBarHide();
    }, 350);
    lastPlacedDisplayKey = key;
    console.log('[karol] Player → external display', ext.label || ext.id,
      `${target.width}x${target.height} @${target.x},${target.y}` + (reason ? ` (${reason})` : ''));
    return true;
  } catch (e) {
    console.error('[karol] placePlayerOnExternalDisplay failed:', e.message);
    return false;
  }
}

function schedulePlacePlayerOnExternalDisplay(reason) {
  if (placePlayerDebounceTimer) clearTimeout(placePlayerDebounceTimer);
  placePlayerDebounceTimer = setTimeout(() => {
    placePlayerDebounceTimer = null;
    placePlayerOnExternalDisplay(reason);
  }, reason === 'display-metrics-changed' ? 1000 : 50);
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
    ...windowIconOpts(),
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
      const karaoke = isKaraokeQueueItem(item);
      monitorWin.webContents.send('player-event', {
        type: 'play', videoId: resolved, isYouTube: false,
        title: displayTitle(item), requester: item.singer || item.requester,
        queue, currentIndex: queueIndex,
        karaoke,
        fromJukebox: !karaoke,
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
    return;
  }

  console.log('[karol] Creating player window...');
  const ext = getExternalDisplay();
  const bounds = ext
    ? {
        x: Math.round(ext.bounds.x),
        y: Math.round(ext.bounds.y),
        width: Math.round(ext.bounds.width),
        height: Math.round(ext.bounds.height),
      }
    : { x: 0, y: 0, width: 1280, height: 720 };
  try {
    playWin = new BrowserWindow({
      ...windowIconOpts(),
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
      title: 'Karol Player', backgroundColor: '#000000', show: true,
      // Frameless edge-to-edge on HDMI — no title bar inset, no Spaces fullscreen.
      frame: !ext,
      fullscreen: false,
      fullscreenable: false,
      enableLargerThanScreen: true,
      hasShadow: false,
      alwaysOnTop: !!ext,
    });
  } catch (e) {
    console.error('[karol] createPlayer BrowserWindow failed:', e && e.message);
    return;
  }
  try {
    if (ext && typeof playWin.setWindowButtonVisibility === 'function') {
      playWin.setWindowButtonVisibility(false);
    }
  } catch (_) {}
  updateKaraokePowerPolicy('player-opened');

  playWin.webContents.on('console-message', (event, level, message) => {
    const msg = (typeof message === 'string' && message)
      || (event && typeof event.message === 'string' && event.message)
      || '';
    if (msg) console.log('[player]', msg);
  });
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
        karaoke: !!p.karaoke,
        fromJukebox: !p.karaoke,
      });
    } else if (betweenSongsPendingItem && isKaraokeQueueItem(betweenSongsPendingItem)) {
      // Player reloaded mid timed Gap — restore Up next + B-roll
      const pending = betweenSongsPendingItem;
      const wasHeld = betweenSongsHeld;
      playAfterBetweenSongs(pending);
      if (wasHeld) holdBetweenSongs();
    } else if (
      isHomeInterstitial()
      || pauseInterstitialLive
      || (
        (!queue.length || queueIndex < 0)
        && !jukeboxActive()
        && (playback.state === 'idle' || playback.state === 'interstitial' || !playback.state)
      )
    ) {
      enterHomeInterstitial({ force: true });
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

/** Phone QR URL — public HTTPS tunnel by default (S24 often can't reach LAN IP). */
function getPhoneControllerUrl() {
  if (String(process.env.KAROL_PHONE_URL_MODE || '').toLowerCase() === 'lan') {
    return 'http://' + getLanIp() + ':3131/dj-controller/';
  }
  const raw = (process.env.KAROL_PUBLIC_URL || 'https://request.rideyrbike.com').replace(/\/+$/, '');
  return raw + '/dj-controller/';
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
    fromJukebox: !!item.fromJukebox,
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
    shuffleEnabled: !!queueShuffle,
    jukebox: jukeboxSummary(),
    ...showModePayload(),
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
        ...getInterstitialState(),
        ...showModePayload(),
        interstitialMessage: (betweenSongsTimer || betweenSongsHeld || betweenSongsPendingItem)
          ? 'Gap & HOLD: use the laptop controller'
          : (showMode() === 'dj'
            ? 'DJ mode — singers join at next Gap'
            : null),
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
      const r = enqueueKaraokeItem({
        videoId: payload.videoId || videoId,
        title: payload.title,
        requester,
      });
      if (!r.ok) return r;
      return { ok: true, videoId: r.videoId, state: buildPhoneQueueState(), ...showModePayload() };
    }
    case 'play-now': {
      const vid = resolveVid(payload.videoId);
      if (!vid) return { ok: false, error: 'No videoId' };
      const title = bestTitleFor(vid, payload.title);
      const who = normalizeQueueSinger(payload.requester || '');
      const existingIdx = queue.findIndex((item) => item.videoId === vid);
      let carriedMysqlId = null;
      if (existingIdx >= 0) {
        carriedMysqlId = queue[existingIdx].mysqlRequestId || null;
        queue.splice(existingIdx, 1);
      }
      queue.push({ videoId: vid, title, singer: who, requester: who, mysqlRequestId: carriedMysqlId });
      skipRequested = true;
      clearBetweenSongsTimer();
      queueIndex = queue.length - 1;
      saveState();
      sendPlay(vid, title, who, { force: true });
      notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
      notifyPlayerQueue();
      return { ok: true, state: buildPhoneQueueState() };
    }
    case 'queue-remove': {
      let idx = payload.index;
      if (idx == null && payload.id != null) idx = findQueueIndexById(payload.id);
      return removeFromShowQueue(idx);
    }
    case 'queue-clear':
      for (const item of queue) updateMysqlRequestStatus(item, 'ended', 'queue cleared');
      stopJukebox();
      queue = [];
      queueIndex = -1;
      shufflePlayedIds.clear();
      clearMediaWait();
      saveSettings();
      saveState();
      enterHomeInterstitial({ force: true });
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
      return skipToShowQueue(idx);
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
    case 'queue-shuffle-set': {
      const enabled = payload.enabled != null ? !!payload.enabled : true;
      setQueueShuffle(enabled, { reshuffleUpcoming: payload.reshuffleUpcoming !== false });
      return { ok: true, state: buildPhoneQueueState(), shuffleEnabled: !!queueShuffle };
    }
    case 'queue-shuffle-upcoming': {
      setQueueShuffle(true, { reshuffleUpcoming: true });
      return { ok: true, state: buildPhoneQueueState(), shuffleEnabled: true };
    }
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
      const level = Number(payload.level ?? payload.volume ?? DEFAULT_VOLUME);
      volumeLevel = Math.max(0, Math.min(1, Number.isFinite(level) ? level : DEFAULT_VOLUME));
      saveSettings();
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

let lastSendPlayAtMs = 0;
let lastSendPlayId = '';

/** Pending play deferred until the MP4 exists on disk (no audience download spinner). */
let mediaWait = null; // { videoId, title, requester, opts }
let mediaWaitTimer = null;

const MIN_PLAYABLE_BYTES = 50_000;

/** True when a playable local file exists for this id (karaoke or base). */
function isMediaReadyOnDisk(videoId) {
  const raw = String(videoId || '');
  if (!raw || !library) return false;
  const resolved = resolveVid(raw);
  const baseId = String(resolved || '').replace(/-karaoke$/, '');
  const candidates = [];
  if (resolved) candidates.push(resolved);
  if (baseId && baseId !== resolved) candidates.push(baseId);
  if (raw && raw !== resolved && raw !== baseId) candidates.push(raw);
  for (const id of candidates) {
    try {
      if (typeof library.getFilePath === 'function') {
        const p = library.getFilePath(id);
        if (p && fs.existsSync(p) && fs.statSync(p).size >= MIN_PLAYABLE_BYTES) return true;
      }
    } catch (_) { /* ignore */ }
    try {
      if (typeof library.getVideoPath === 'function') {
        const p = library.getVideoPath(id);
        if (p && fs.existsSync(p) && fs.statSync(p).size >= MIN_PLAYABLE_BYTES) return true;
      }
    } catch (_) { /* ignore */ }
  }
  return false;
}

function isQueueItemMediaReady(item) {
  return !!(item && item.videoId && isMediaReadyOnDisk(item.videoId));
}

/** Ensure a download/pipeline is running so a queued item can become playable. */
function ensureDownloadForPlay(videoId, opts) {
  const raw = String(videoId || '');
  const baseId = raw.replace(/-karaoke$/, '');
  if (!/^[A-Za-z0-9_-]{11}$/.test(baseId)) return;
  const job = processingJobs[baseId] || processingJobs[raw] || processingJobs[baseId + '-karaoke'];
  if (job && job.status !== 'error' && job.status !== 'done') return;
  // Karaoke pipeline jobs are already enqueued via requests.add — only start a
  // plain download when nothing is in flight for this id.
  const wantKaraoke = !!(opts && opts.karaoke) || /-karaoke$/.test(raw);
  if (wantKaraoke && karaokeQueue.some((e) => e.videoId === baseId)) return;
  if (wantKaraoke && karaokeRunning) {
    // Another karaoke job may be this one — avoid duplicate plain download.
    const running = processingJobs[baseId];
    if (running && running.karaokify) return;
  }
  const tag = wantKaraoke ? 'karaoke' : 'music';
  console.log('[karol] ensureDownloadForPlay:', baseId, 'tag=', tag);
  startDirectDownload(baseId, 'https://www.youtube.com/watch?v=' + baseId, tag);
}

function clearMediaWait() {
  mediaWait = null;
  if (mediaWaitTimer) {
    clearInterval(mediaWaitTimer);
    mediaWaitTimer = null;
  }
}

/**
 * Hold the show until media lands: keep Gap / previous surface, never entrance
 * or player download spinner. Flushes via poll + download-complete hooks.
 */
function armMediaWait(spec) {
  if (!spec || !spec.videoId) return;
  mediaWait = {
    videoId: String(spec.videoId),
    title: spec.title || '',
    requester: spec.requester || '',
    opts: spec.opts || {},
  };
  ensureDownloadForPlay(mediaWait.videoId, mediaWait.opts);
  // Keep audience on Gap B-roll ("Up next") rather than singer entrance.
  try {
    const curItem = (queueIndex >= 0 && queueIndex < queue.length) ? queue[queueIndex] : null;
    const asKaraoke = mediaWait.opts.karaoke != null
      ? !!mediaWait.opts.karaoke
      : !!(curItem && isKaraokeQueueItem(curItem));
    if (asKaraoke) {
      const item = curItem && (String(curItem.videoId) === mediaWait.videoId
        || String(curItem.videoId).replace(/-karaoke$/, '') === mediaWait.videoId.replace(/-karaoke$/, ''))
        ? curItem
        : {
          videoId: mediaWait.videoId,
          title: mediaWait.title,
          singer: mediaWait.requester,
          requester: mediaWait.requester,
        };
      // Home Gap or cold idle → promote to timed Gap with this Up next
      if (isHomeInterstitial() || !isGapInterstitialActive()) {
        playAfterBetweenSongs(item);
      }
      holdBetweenSongs();
    }
  } catch (e) {
    console.warn('[karol] armMediaWait gap hold failed:', e && e.message);
  }
  if (!mediaWaitTimer) {
    mediaWaitTimer = setInterval(() => {
      try { flushMediaWaitIfReady('poll'); } catch (e) {
        console.warn('[karol] mediaWait poll failed:', e && e.message);
      }
    }, 1000);
  }
  console.log('[karol] Waiting for media before play/entrance:', mediaWait.videoId);
}

/** If armed wait's file is ready, clear hold and present on the player. */
function flushMediaWaitIfReady(reason) {
  if (!mediaWait) return false;
  const w = mediaWait;
  if (!isMediaReadyOnDisk(w.videoId)) {
    ensureDownloadForPlay(w.videoId, w.opts);
    return false;
  }
  console.log('[karol] Media ready — starting deferred play:', w.videoId, '(' + (reason || 'ok') + ')');
  clearMediaWait();
  // Drop Gap hold so sendPlay can tear down cleanly
  betweenSongsHeld = false;
  betweenSongsPendingItem = null;
  clearBetweenSongsTimer();
  sendPlay(w.videoId, w.title, w.requester, Object.assign({}, w.opts || {}, { force: true }));
  notifyPlayerQueue();
  return true;
}

/** After a download/pipeline finishes, promote that queue row if it was waiting. */
function onMediaBecameReady(videoId) {
  const base = String(videoId || '').replace(/-karaoke$/, '');
  if (mediaWait) {
    const waitBase = String(mediaWait.videoId || '').replace(/-karaoke$/, '');
    if (waitBase === base || mediaWait.videoId === videoId || mediaWait.videoId === base + '-karaoke') {
      flushMediaWaitIfReady('download-done');
      return;
    }
  }
  // Idle show with this row next / only: start when file lands (queued while downloading).
  try {
    if (queueIndex < 0 && queue.length > 0) {
      const first = queue[0];
      const fb = String(first.videoId || '').replace(/-karaoke$/, '');
      if ((fb === base || first.videoId === videoId) && isQueueItemMediaReady(first)) {
        queueIndex = 0;
        saveState();
        playShowItem(first);
        notifyShowUpdate();
      }
    }
  } catch (e) {
    console.warn('[karol] onMediaBecameReady idle promote failed:', e && e.message);
  }
}

function sendPlay(videoId, title, requester, opts) {
  const force = !!(opts && opts.force);
  const resolvedEarly = resolveVid(videoId);
  // Never bounce a healthy in-progress track back to 0 (retry storms looked like
  // "random restarts"). Explicit force=true for real Play Now / skip targets.
  if (!force && featureTrackEverProgressed && playback.state === 'playing') {
    const cur = resolveVid(playback.videoId || '');
    if (cur && resolvedEarly && cur === resolvedEarly && (playback.currentTime || 0) >= 1) {
      console.warn('[karol] Ignoring redundant sendPlay for in-progress', resolvedEarly, 't=', playback.currentTime);
      return;
    }
  }
  // Debounce duplicate play of the same id (async player races looked like fighting).
  const now = Date.now();
  if (!force && resolvedEarly && resolvedEarly === lastSendPlayId && (now - lastSendPlayAtMs) < 2500) {
    console.warn('[karol] Ignoring debounced sendPlay for', resolvedEarly);
    return;
  }

  // Upstream gate: never send play/entrance to the audience until the file is local.
  // Queue can still list the singer; Gap "Up next" / previous track stays up.
  const resolvedGate = resolvedEarly || String(videoId || '');
  if (!isMediaReadyOnDisk(resolvedGate)) {
    console.log('[karol] sendPlay deferred — media not ready:', resolvedGate);
    armMediaWait({
      videoId: resolvedGate,
      title,
      requester,
      opts: opts || {},
    });
    return;
  }
  clearMediaWait();

  lastSendPlayAtMs = now;
  lastSendPlayId = resolvedEarly || String(videoId || '');
  clearBetweenSongsTimer();
  // Tear down phone mirror before feature track (restore BlackHole → Ableton path).
  try { if (phoneMirror && phoneMirror.isRunning()) phoneMirror.stopPhoneMirror(); } catch (_) {}
  try { sendToPlayers('player-event', { type: 'phone-mirror-capture-stop' }); } catch (_) {}
  featureTrackEverProgressed = false;
  skipRequested = true;
  playEpoch += 1;
  // Teardown of the previous <video> can emit ended/paused under the new id.
  // Hold the gate long enough that those cannot cascade into advanceShow.
  ignoreEndedUntilMs = Date.now() + 5000;
  playback.currentTime = 0;
  playback.duration = 0;
  playback.state = 'playing';
  playback.videoId = resolvedEarly || String(videoId || '');
  if (!playWin || playWin.isDestroyed()) {
    const curItem = (queueIndex >= 0 && queueIndex < queue.length) ? queue[queueIndex] : null;
    const karaoke = !!(opts && opts.karaoke != null)
      ? !!opts.karaoke
      : !!(curItem && isKaraokeQueueItem(curItem));
    pendingPlay = { videoId, title, requester, karaoke };
    createPlayer();
    return;
  }
  // Resolve to the best available file (karaoke vs regular)
  const resolved = resolvedEarly || resolveVid(videoId);
  // If the resolved ID differs from what's in the queue, update the queue entry
  if (resolved !== videoId && queueIndex >= 0 && queueIndex < queue.length) {
    const item = queue[queueIndex];
    if (item.videoId === videoId) {
      item.videoId = resolved;
      saveState();
    }
  }
  // Karaoke flag drives singer entrance only — jukebox/DJ never gets "give it up for"
  const curItem = (queueIndex >= 0 && queueIndex < queue.length) ? queue[queueIndex] : null;
  const karaoke = !!(opts && opts.karaoke != null)
    ? !!opts.karaoke
    : !!(curItem && isKaraokeQueueItem(curItem));
  // Send play + full queue snapshot so player + monitor can render immediately
  const birthdayPlay = !karaoke && isBirthdayJukebox();
  const playRequester = birthdayPlay ? DEFAULT_DJ_NAME : (requester || '');
  sendToPlayers('player-event', {
    type: 'play', videoId: resolved, isYouTube: false,
    title: displayTitle({ title, videoId: resolved }),
    requester: playRequester,
    volumeLevel: volumeLevel,
    musicEq: normalizeEq(musicEq),
    vocalEq: normalizeEq(vocalEq),
    vocalMixLevel: Math.max(0, Math.min(1, Number(vocalMixLevel) || 0)),
    queue: queue, currentIndex: queueIndex,
    karaoke,
    fromJukebox: !karaoke,
    isBirthday: birthdayPlay,
  });
}

let betweenSongsTimer = null;
let betweenSongsMs = 15000; // default 15s — controllable from DJ controller
let betweenSongsHeld = false;
let betweenSongsRemainingMs = 0;
let betweenSongsDeadline = 0;
let betweenSongsPendingItem = null;
let betweenSongsHandoffPending = false;
let betweenSongsHandoffTimer = null;
/** Now Spinning B-roll id/title during Gap / pause interstitial (shared with controller). */
let currentGapBrollId = null;
let currentGapBrollTitle = '';
/** True while the player is showing the Pause interstitial (not the timed Gap). */
let pauseInterstitialLive = false;
/** True while showing the idle/home Gap (empty queue — no pending singer, no countdown). */
let homeInterstitialLive = false;
let gapEpoch = 0;
/** Gap interstitial content: random Music Videos B-roll vs S24 USB mirror vs both. */
let gapContent = 'music-broll'; // 'music-broll' | 'phone-mirror' | 'both'
/**
 * Phone USB mirror (scrcpy/adb) is parked for now — Gap/pause always use Music Videos.
 * Keep phone-mirror.js + UI hooks; flip this true when S24 is rewired.
 */
const PHONE_MIRROR_GAP_ENABLED = false;
/** Independent Gap mix levels (0–1), applied on top of master Out. */
let gapBrollLevel = 0.85;
let gapPhoneLevel = 0.85;

const SETTINGS_FILE = path.join('/tmp', 'karol-settings.json');

function normalizeGapContent(v) {
  // Phone / Both parked — coerce any saved phone modes to MVs.
  if (!PHONE_MIRROR_GAP_ENABLED) return 'music-broll';
  if (v === 'phone-mirror' || v === 'both') return v;
  return 'music-broll';
}

function getGapContent() {
  return normalizeGapContent(gapContent);
}

function gapNeedsPhone(c) {
  if (!PHONE_MIRROR_GAP_ENABLED) return false;
  const x = c || getGapContent();
  return x === 'phone-mirror' || x === 'both';
}

/** Quiet status when mirror is parked — never probe adb / nag about S24. */
function phoneMirrorStatusQuiet() {
  if (!PHONE_MIRROR_GAP_ENABLED) {
    return {
      disabled: true,
      adbOk: false,
      adbCount: 0,
      scrcpyRunning: false,
      scrcpyInstalled: false,
      mode: 'off',
      error: '',
    };
  }
  return phoneMirror ? phoneMirror.getStatus() : { error: 'unavailable', adbOk: false, scrcpyRunning: false };
}

function gapNeedsBroll(c) {
  const x = c || getGapContent();
  return x === 'music-broll' || x === 'both';
}

function clamp01(n, fallback) {
  const v = Number(n);
  if (!isFinite(v)) return fallback;
  return Math.max(0, Math.min(1, v));
}

function getGapMix() {
  return {
    gapBrollLevel: clamp01(gapBrollLevel, 0.85),
    gapPhoneLevel: clamp01(gapPhoneLevel, 0.85),
  };
}

function loadSettings() {
  let migratedGap = false;
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (typeof s.betweenSongsMs === 'number' && isFinite(s.betweenSongsMs)) {
        betweenSongsMs = s.betweenSongsMs;
      }
      if (s.gapContent === 'phone-mirror' || s.gapContent === 'music-broll' || s.gapContent === 'both') {
        const raw = s.gapContent;
        gapContent = normalizeGapContent(raw);
        if (!PHONE_MIRROR_GAP_ENABLED && (raw === 'phone-mirror' || raw === 'both')) {
          migratedGap = true;
          console.log('[karol] Migrated gapContent', raw, '→ music-broll (phone mirror parked)');
        }
      }
      if (typeof s.gapBrollLevel === 'number') gapBrollLevel = clamp01(s.gapBrollLevel, 0.85);
      if (typeof s.gapPhoneLevel === 'number') gapPhoneLevel = clamp01(s.gapPhoneLevel, 0.85);
      if (typeof s.volumeLevel === 'number' && isFinite(s.volumeLevel)) {
        volumeLevel = Math.max(0, Math.min(1, s.volumeLevel));
      }
      if (typeof s.vocalMixLevel === 'number' && isFinite(s.vocalMixLevel)) {
        vocalMixLevel = Math.max(0, Math.min(1, s.vocalMixLevel));
      }
      if (s.musicEq) musicEq = normalizeEq(s.musicEq);
      if (s.vocalEq) vocalEq = normalizeEq(s.vocalEq);
      if (typeof s.queueShuffle === 'boolean') {
        queueShuffle = s.queueShuffle;
      }
      // Sticky DJ deck for the night — armed until Stop / Clear All
      if (s.jukebox && Array.isArray(s.jukebox.items) && s.jukebox.items.length) {
        const items = s.jukebox.items
          .map((it) => ({
            videoId: String(it.videoId || ''),
            title: String(it.title || ''),
          }))
          .filter((it) => it.videoId);
        if (items.length) {
          const idx = Math.max(0, Math.min(items.length - 1, Number(s.jukebox.index) || 0));
          jukebox = {
            items,
            index: idx,
            shuffle: !!s.jukebox.shuffle,
            kind: s.jukebox.kind === 'birthday' ? 'birthday' : 'music',
            name: String(s.jukebox.name || '') || (s.jukebox.kind === 'birthday' ? 'Birthday Playlist' : 'Music Jukebox'),
          };
          console.log('[karol] Restored DJ deck:', jukebox.name || 'Music Jukebox', items.length, 'tracks, index', idx);
        }
      }
    }
  } catch (e) {
    console.warn('[karol] settings load failed:', e.message);
  }
  if (!PHONE_MIRROR_GAP_ENABLED) gapContent = 'music-broll';
  if (migratedGap) {
    try { saveSettings(); } catch (_) {}
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
      betweenSongsMs: getBetweenSongsMs(),
      gapContent: getGapContent(),
      gapBrollLevel: getGapMix().gapBrollLevel,
      gapPhoneLevel: getGapMix().gapPhoneLevel,
      volumeLevel: Math.max(0, Math.min(1, Number(volumeLevel) || DEFAULT_VOLUME)),
      vocalMixLevel: Math.max(0, Math.min(1, Number(vocalMixLevel) || 0)),
      musicEq: normalizeEq(musicEq),
      vocalEq: normalizeEq(vocalEq),
      queueShuffle: !!queueShuffle,
      jukebox: jukeboxActive() ? {
        items: jukebox.items.map((it) => ({
          videoId: it.videoId,
          title: it.title || '',
        })),
        index: jukebox.index,
        shuffle: !!jukebox.shuffle,
        kind: jukebox.kind || 'music',
        name: jukebox.name || '',
      } : null,
    }, null, 2));
  } catch (e) {
    console.warn('[karol] settings save failed:', e.message);
  }
}

function playerBoundsForMirror() {
  try {
    if (playWin && !playWin.isDestroyed()) {
      const b = playWin.getBounds();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    }
  } catch (_) {}
  return null;
}

/** True while scrcpy is composited as an always-on-top window over the HDMI phone slot. */
let phoneMirrorOverlayActive = false;

function getScreenCaptureAccessStatus() {
  try {
    if (systemPreferences && typeof systemPreferences.getMediaAccessStatus === 'function') {
      return systemPreferences.getMediaAccessStatus('screen') || 'unknown';
    }
  } catch (_) {}
  return 'unknown';
}

/** Fit a true 9:19.5 portrait rect inside the given box.
 *  align: 'center' | 'right' (Dual Gap overlays the hard right edge of the MV). */
function clampPortraitPhoneSlot(slot, opts) {
  if (!slot || !(Number(slot.width) > 40) || !(Number(slot.height) > 40)) return slot;
  opts = opts || {};
  const align = opts.align === 'right' ? 'right' : 'center';
  const aspect = 9 / 19.5; // width/height
  const boxX = Number(slot.x) || 0;
  const boxY = Number(slot.y) || 0;
  const boxW = Number(slot.width);
  const boxH = Number(slot.height);
  let ph = boxH;
  let pw = ph * aspect;
  if (pw > boxW) {
    pw = boxW;
    ph = pw / aspect;
  }
  // Hard ceiling: never wider than ~36% of a 1080p panel unless the box forces it
  if (pw > 420 && boxW > 420) {
    pw = 420;
    ph = pw / aspect;
    if (ph > boxH) {
      ph = boxH;
      pw = ph * aspect;
    }
  }
  const x = align === 'right'
    ? Math.round(boxX + boxW - pw)
    : Math.round(boxX + (boxW - pw) / 2);
  const y = Math.round(boxY + (boxH - ph) / 2);
  return {
    x,
    y,
    width: Math.max(140, Math.round(pw)),
    height: Math.max(280, Math.round(ph)),
  };
}

/** Estimate Dual-Gap / Phone pane rect in screen coords from the player window.
 *  Dual Gap: full-bleed MV; portrait phone on the hard right edge above the marquee. */
function phoneSlotBoundsFromPlayer() {
  const b = playerBoundsForMirror();
  if (!b || !(b.width > 200) || !(b.height > 200)) return null;
  const dual = getGapContent() === 'both';
  const phoneAspect = 9 / 19.5; // width/height
  if (dual) {
    const marquee = Math.round(Math.min(120, Math.max(80, b.height * 0.09)));
    const padTop = Math.round(b.height * 0.014);
    const padRight = Math.round(b.width * 0.006);
    const padBot = marquee + Math.round(b.height * 0.01);
    const phoneH = Math.max(280, b.height - padTop - padBot);
    let phoneW = Math.round(phoneH * phoneAspect);
    const maxW = Math.round(Math.min(b.width * 0.28, 380));
    if (phoneW > maxW) {
      phoneW = maxW;
    }
    return {
      x: Math.round(b.x + b.width - padRight - phoneW),
      y: Math.round(b.y + padTop),
      width: phoneW,
      height: Math.round(phoneW / phoneAspect),
    };
  }
  const padX = Math.round(b.width * 0.012);
  const padTop = Math.round(b.height * 0.14);
  const padBot = Math.round(b.height * 0.20);
  // Phone-only: centered portrait
  const colH = Math.max(240, b.height - padTop - padBot);
  let ph = colH;
  let pw = Math.round(ph * phoneAspect);
  const maxW = Math.round(b.width * 0.36);
  if (pw > maxW) {
    pw = maxW;
    ph = Math.round(pw / phoneAspect);
  }
  return clampPortraitPhoneSlot({
    x: b.x + (b.width - pw) / 2,
    y: b.y + padTop + (colH - ph) / 2,
    width: pw,
    height: ph,
  });
}

/**
 * Fallback when Screen Recording / desktopCapturer is unavailable:
 * host scrcpy directly in the HDMI phone slot (always-on-top), with the
 * player dropped from 'screen-saver' level. Never toggles fullscreen.
 */
function startHdmiPhoneOverlay(reason) {
  if (!phoneMirror) {
    return { ok: false, error: 'phone-mirror module unavailable', routing: { mode: 'off' } };
  }
  const slot = phoneSlotBoundsFromPlayer();
  console.log('[karol] HDMI phone overlay', reason || '', slot);
  let result;
  try {
    result = phoneMirror.startPhoneMirror(playerBoundsForMirror(), {
      playWin,
      hostOnPrimary: false,
      slotBounds: slot,
      fullscreenDisplay: false,
      forceRestart: true,
      noAudio: getGapMix().gapPhoneLevel < 0.02,
      audioLevel: getGapMix().gapPhoneLevel,
    });
  } catch (e) {
    console.error('[karol] HDMI overlay start threw:', e && e.message);
    return { ok: false, error: e.message || 'overlay start failed', routing: { mode: 'off' } };
  }
  if (!result.ok) return result;
  phoneMirrorOverlayActive = true;
  try {
    if (playWin && !playWin.isDestroyed()) playWin.setAlwaysOnTop(false);
  } catch (_) {}
  // Player AOT dropped for scrcpy — keep menu bar covered
  ensureMenuBarCover('hdmi-overlay');
  startMenuBarCoverWatch();
  sendToPlayers('player-event', {
    type: 'phone-mirror-overlay',
    active: true,
  });
  sendToPlayers('player-event', {
    type: 'phone-mirror-capture-status',
    ok: true,
    reason: 'hdmi-overlay',
    message: '',
  });
  notifyCtrl('phone-mirror-status', {
    ...(result.status || phoneMirror.getStatus()),
    overlay: true,
    screenStatus: getScreenCaptureAccessStatus(),
  });
  return result;
}

function stopHdmiPhoneOverlayFlag() {
  phoneMirrorOverlayActive = false;
  playerHdmiPresentationReady = false;
  sendToPlayers('player-event', { type: 'phone-mirror-overlay', active: false });
}

/** Start or stop phone mirror for Gap/Pause.
 *  Prefer laptop scrcpy + desktopCapturer when Screen Recording is granted;
 *  otherwise place scrcpy on the HDMI phone slot (no TCC needed).
 *  Never toggles player fullscreen (crashes macOS NSWindow setStyleMask). */
function ensurePhoneMirrorForGap(wantOn) {
  if (!PHONE_MIRROR_GAP_ENABLED) {
    // Parked: never spawn scrcpy/adb — Gap uses Music Videos only.
    try {
      stopHdmiPhoneOverlayFlag();
      if (phoneMirror && phoneMirror.isRunning()) phoneMirror.stopPhoneMirror();
      sendToPlayers('player-event', { type: 'phone-mirror-capture-stop' });
    } catch (_) {}
    return { ok: true, routing: { mode: 'off' }, status: phoneMirrorStatusQuiet(), parked: true };
  }
  if (!phoneMirror) {
    return { ok: false, error: 'phone-mirror module unavailable', routing: { mode: 'off' } };
  }
  if (!wantOn) {
    stopHdmiPhoneOverlayFlag();
    try { phoneMirror.stopPhoneMirror(); } catch (_) {}
    sendToPlayers('player-event', { type: 'phone-mirror-capture-stop' });
    return { ok: true, routing: { mode: 'off' }, status: phoneMirror.getStatus() };
  }

  const screenStatus = getScreenCaptureAccessStatus();
  console.log('[karol] phone mirror screen access:', screenStatus);

  // No Screen Recording → skip capturer entirely (empty source list / TCC false negative)
  if (screenStatus !== 'granted') {
    const overlay = startHdmiPhoneOverlay('screen-status=' + screenStatus);
    notifyCtrl('phone-mirror-status', overlay.status || phoneMirror.getStatus());
    return overlay;
  }

  let result;
  try {
    result = phoneMirror.startPhoneMirror(playerBoundsForMirror(), {
      playWin,
      hostOnPrimary: true,
      fullscreenDisplay: false,
      // Direct scrcpy→BlackHole can't be ducked; mute at near-zero phone fader
      noAudio: getGapMix().gapPhoneLevel < 0.02,
      audioLevel: getGapMix().gapPhoneLevel,
    });
  } catch (e) {
    console.error('[karol] phone mirror start threw:', e && e.message);
    return { ok: false, error: e.message || 'mirror start failed', routing: { mode: 'off' } };
  }
  notifyCtrl('phone-mirror-status', result.status || phoneMirror.getStatus());
  if (!result.ok) return result;

  phoneMirrorOverlayActive = false;

  // Wait for scrcpy window, then bind desktopCapturer → player B-roll video
  const tryCapture = (attempt) => {
    if (!phoneMirror.isRunning()) {
      sendToPlayers('player-event', {
        type: 'phone-mirror-capture-status',
        ok: false,
        reason: 'scrcpy-stopped',
        message: 'Phone mirror window closed',
      });
      return;
    }
    if (getScreenCaptureAccessStatus() !== 'granted') {
      console.warn('[karol] screen access lost — falling back to HDMI overlay');
      startHdmiPhoneOverlay('access-lost');
      return;
    }
    desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    }).then((sources) => {
      const list = sources || [];
      const hit = list.find((s) => /Karol Phone Mirror/i.test(s.name || ''))
        || list.find((s) => /scrcpy/i.test(s.name || ''));
      if (!hit) {
        if (attempt < 8) {
          if (attempt === 0 || attempt === 3 || attempt === 6) {
            console.warn('[karol] phone mirror window not in capturer yet (attempt', attempt + ', sources=' + list.length + ')');
            sendToPlayers('player-event', {
              type: 'phone-mirror-capture-status',
              ok: false,
              reason: 'window-missing',
              message: list.length
                ? 'Looking for Karol Phone Mirror…'
                : 'Waiting for screen capture sources…',
              sourceCount: list.length,
            });
          }
          setTimeout(() => tryCapture(attempt + 1), attempt < 4 ? 350 : 600);
          return;
        }
        console.warn('[karol] capture source missing after retries — HDMI overlay fallback; sources=',
          list.slice(0, 12).map((s) => s.name));
        startHdmiPhoneOverlay('capturer-miss');
        return;
      }
      console.log('[karol] Phone mirror capture source:', hit.name, hit.id);
      sendToPlayers('player-event', {
        type: 'phone-mirror-capture',
        sourceId: hit.id,
        sourceName: hit.name,
      });
    }).catch((e) => {
      console.warn('[karol] desktopCapturer failed:', e && e.message);
      if (attempt < 4) {
        setTimeout(() => tryCapture(attempt + 1), 500);
        return;
      }
      startHdmiPhoneOverlay('capturer-error');
    });
  };
  setTimeout(() => tryCapture(0), 700);

  return result;
}

function getBetweenSongsMs() {
  return Math.max(3000, Math.min(120000, Math.round(Number(betweenSongsMs) || 15000)));
}

function clearBetweenSongsHandoff() {
  if (betweenSongsHandoffTimer) {
    clearTimeout(betweenSongsHandoffTimer);
    betweenSongsHandoffTimer = null;
  }
  betweenSongsHandoffPending = false;
}

/** Fade mirror audio then hand off to the pending karaoke row (Gap timer expiry). */
function beginGapHandoff(pending, gapToken) {
  clearBetweenSongsHandoff();
  betweenSongsHandoffPending = true;
  notifyInterstitialState();
  sendToPlayers('player-event', { type: 'phone-mirror-fade-out' });
  betweenSongsHandoffTimer = setTimeout(() => {
    betweenSongsHandoffTimer = null;
    if (gapToken !== gapEpoch) return;
    betweenSongsHandoffPending = false;
    try { if (phoneMirror) phoneMirror.stopPhoneMirror(); } catch (_) {}
    notifyCtrl('phone-mirror-status', phoneMirrorStatusQuiet());
    if (!pending || !isKaraokeQueueItem(pending)) {
      enterHomeInterstitial({ force: true });
      return;
    }
    // Hold Gap B-roll until the file is on disk — never entrance + download spinner.
    if (!isQueueItemMediaReady(pending)) {
      console.log('[karol] Gap handoff deferred — media not ready:', pending.videoId);
      armMediaWait({
        videoId: pending.videoId,
        title: pending.title,
        requester: pending.singer || pending.requester,
        opts: { force: true, karaoke: true },
      });
      // Handoff may have started fading the interstitial — put B-roll / Up next back up.
      playAfterBetweenSongs(pending);
      holdBetweenSongs();
      return;
    }
    sendPlay(pending.videoId, pending.title, pending.singer || pending.requester, {
      force: true,
      karaoke: true,
    });
    notifyPlayerQueue();
  }, 340);
}

function clearBetweenSongsTimer({ keepPending = false } = {}) {
  gapEpoch++;
  if (betweenSongsTimer) {
    clearTimeout(betweenSongsTimer);
    betweenSongsTimer = null;
  }
  clearBetweenSongsHandoff();
  betweenSongsHeld = false;
  betweenSongsRemainingMs = 0;
  betweenSongsDeadline = 0;
  if (!keepPending) betweenSongsPendingItem = null;
  // Timed Gap ended — drop Now Spinning unless a new Gap immediately re-sets it.
  if (!keepPending) {
    homeInterstitialLive = false;
    setCurrentGapBroll(null, '');
  }
  try { if (phoneMirror && phoneMirror.isRunning()) phoneMirror.stopPhoneMirror(); } catch (_) {}
  notifyInterstitialState();
}

function isGapInterstitialActive() {
  return !!(
    betweenSongsTimer
    || betweenSongsHeld
    || betweenSongsPendingItem
    || betweenSongsHandoffPending
    || playback.state === 'interstitial'
  );
}

/** Now Spinning history for Gap Prev (most recent previous at end). */
let gapBrollHistory = [];
const GAP_BROLL_HISTORY_MAX = 40;

function pushGapBrollHistory(videoId) {
  const id = videoId ? String(videoId) : '';
  if (!id) return;
  if (gapBrollHistory[gapBrollHistory.length - 1] === id) return;
  gapBrollHistory.push(id);
  if (gapBrollHistory.length > GAP_BROLL_HISTORY_MAX) {
    gapBrollHistory.splice(0, gapBrollHistory.length - GAP_BROLL_HISTORY_MAX);
  }
}

function setCurrentGapBroll(videoId, title, { recordHistory = true } = {}) {
  const id = videoId ? String(videoId) : null;
  const t = title != null ? String(title) : '';
  const prevId = currentGapBrollId || null;
  const same = prevId === (id || null)
    && (currentGapBrollTitle || '') === (t || (id ? currentGapBrollTitle : ''));
  if (recordHistory && prevId && id && prevId !== id) {
    pushGapBrollHistory(prevId);
  }
  if (!id) gapBrollHistory = [];
  currentGapBrollId = id;
  if (id) {
    if (t) currentGapBrollTitle = t;
    else if (!currentGapBrollTitle) currentGapBrollTitle = resolveTitleLocal(id) || '';
  } else {
    currentGapBrollTitle = '';
  }
  return !same;
}

function resolveGapUpNext() {
  let item = null;
  let index = -1;
  if (betweenSongsPendingItem && isKaraokeQueueItem(betweenSongsPendingItem)) {
    item = betweenSongsPendingItem;
    index = queue.indexOf(item);
    if (index < 0) {
      const vid = item.videoId;
      index = queue.findIndex((row) => row && row.videoId === vid && isKaraokeQueueItem(row));
    }
  }
  if (!item) {
    for (let i = 0; i < queue.length; i++) {
      if (isKaraokeQueueItem(queue[i])) {
        item = queue[i];
        index = i;
        break;
      }
    }
  }
  if (!item) return { index: -1, singer: '', title: '', videoId: null };
  return {
    index,
    singer: displaySingerName(item.singer || item.requester),
    title: displayTitle(item),
    videoId: item.videoId || null,
  };
}

function getInterstitialState() {
  const active = isGapInterstitialActive();
  const home = isHomeInterstitial();
  let remainingMs = 0;
  if (home) remainingMs = 0;
  else if (betweenSongsHeld) remainingMs = Math.max(0, betweenSongsRemainingMs || 0);
  else if (betweenSongsDeadline) remainingMs = Math.max(0, betweenSongsDeadline - Date.now());
  const up = resolveGapUpNext();
  const hasUpNext = !!(up.index >= 0 && up.videoId);
  const controls = !!(active || pauseInterstitialLive || home);
  return {
    interstitialActive: active,
    interstitialHeld: !!betweenSongsHeld,
    interstitialRemainingMs: remainingMs,
    pauseInterstitial: !!pauseInterstitialLive,
    homeInterstitial: home,
    hasUpNext,
    gapControls: controls,
    brollVideoId: currentGapBrollId,
    brollTitle: currentGapBrollTitle || (currentGapBrollId ? (resolveTitleLocal(currentGapBrollId) || '') : ''),
    upNextIndex: up.index,
    upNextSinger: up.singer,
    upNextTitle: up.title,
    upNextVideoId: up.videoId,
  };
}

function isHomeInterstitial() {
  return !!(
    homeInterstitialLive
    && playback.state === 'interstitial'
    && !betweenSongsPendingItem
    && !betweenSongsTimer
    && !betweenSongsHandoffPending
  );
}

/** Pick a different Music Video B-roll and push it to the player. */
function cycleGapBroll() {
  if (!isGapInterstitialActive() && !pauseInterstitialLive) {
    return { ok: false, error: 'Not in interstitial' };
  }
  const nextId = pickRandomMusicBrollId();
  if (!nextId) return { ok: false, error: 'No Music Videos available' };
  const next = sendGapSetBroll(nextId, { fromStart: true });
  return { ok: true, brollVideoId: next.videoId, brollTitle: next.title };
}

/** Go back to the previous Now Spinning Music Video (Gap Prev). */
function prevGapBroll() {
  if (!isGapInterstitialActive() && !pauseInterstitialLive) {
    return { ok: false, error: 'Not in interstitial' };
  }
  while (gapBrollHistory.length) {
    const prevId = gapBrollHistory.pop();
    if (!prevId || prevId === currentGapBrollId) continue;
    // Skip ids no longer local (deleted / refiled away from Music Videos)
    try {
      if (typeof isLocalMusicVideo === 'function' && !isLocalMusicVideo(prevId)) continue;
    } catch (_) {}
    const next = sendGapSetBroll(prevId, { fromStart: true, recordHistory: false });
    if (next && next.videoId) {
      return { ok: true, brollVideoId: next.videoId, brollTitle: next.title };
    }
  }
  return { ok: false, error: 'No previous spin' };
}

/**
 * Home-base Gap: QR + Now Spinning + tips with no pending singer and no countdown.
 * Used when the queue is empty, the show ends, or the player boots idle.
 */
function enterHomeInterstitial({ force = false } = {}) {
  healDjMirrorFlags();
  const karaoke = pendingKaraokeItems();
  if (karaoke.length) {
    queue = karaoke;
    queueIndex = 0;
    homeInterstitialLive = false;
    playAfterBetweenSongs(queue[0]);
    return { ok: true, home: false, pending: true };
  }
  if (jukeboxActive()) {
    const deckItem = jukebox.items[jukebox.index] || selectNextJukeboxItem(1);
    if (deckItem) {
      const row = makeJukeboxQueueRow(deckItem);
      queue = [row];
      queueIndex = 0;
      homeInterstitialLive = false;
      playShowItem(row);
      notifyShowUpdate();
      return { ok: true, home: false, jukebox: true };
    }
  }

  if (!force && isHomeInterstitial() && currentGapBrollId) {
    notifyInterstitialState();
    notifyShowUpdate();
    return { ok: true, home: true, kept: true };
  }

  // Tear down any prior timed Gap / pause chrome without clearing the home flag mid-setup
  gapEpoch++;
  if (betweenSongsTimer) {
    clearTimeout(betweenSongsTimer);
    betweenSongsTimer = null;
  }
  clearBetweenSongsHandoff();
  pauseInterstitialLive = false;
  betweenSongsPendingItem = null;
  betweenSongsHeld = true;
  betweenSongsRemainingMs = 0;
  betweenSongsDeadline = 0;
  homeInterstitialLive = true;

  queue = [];
  queueIndex = -1;
  clearMediaWait();

  if (!playWin || playWin.isDestroyed()) createPlayer();

  let content = getGapContent();
  let brollVideoId = null;
  let mirrorRouting = { mode: 'off' };
  if (gapNeedsPhone(content)) {
    const mir = ensurePhoneMirrorForGap(true);
    if (!mir.ok) {
      content = 'music-broll';
      try { if (phoneMirror) phoneMirror.stopPhoneMirror(); } catch (_) {}
      brollVideoId = pickRandomMusicBrollId();
    } else {
      mirrorRouting = mir.routing || { mode: 'direct' };
      if (gapNeedsBroll(content)) brollVideoId = pickRandomMusicBrollId();
    }
  } else {
    try { if (phoneMirror && phoneMirror.isRunning()) phoneMirror.stopPhoneMirror(); } catch (_) {}
    brollVideoId = pickRandomMusicBrollId();
  }

  const mix = getGapMix();
  playback = {
    videoId: null,
    currentTime: 0,
    duration: 0,
    state: 'interstitial',
  };
  featureTrackEverProgressed = false;
  setCurrentGapBroll(brollVideoId || null, '');
  console.log('[karol] Home interstitial (idle Gap)', content, brollVideoId || '(no broll)');
  sendToPlayers('player-event', {
    type: 'between-songs',
    idleHome: true,
    singer: '',
    title: '',
    label: 'Request a song',
    durationMs: 0,
    gapContent: content,
    brollVideoId,
    mirrorAudioMode: mirrorRouting.mode || 'off',
    mirrorHouseDevice: mirrorRouting.house || null,
    mirrorTapDevice: mirrorRouting.tap || null,
    gapBrollLevel: mix.gapBrollLevel,
    gapPhoneLevel: mix.gapPhoneLevel,
    queue: [],
    currentIndex: -1,
  });
  saveState();
  notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
  notifyPlayerQueue();
  notifyInterstitialState();
  notifyShowUpdate();
  return { ok: true, home: true, brollVideoId };
}

const GAP_RECLASS_BUCKETS = {
  karaoke: { tag: 'karaoke', source: 'manual', label: 'Karaoke' },
  custom: { tag: 'karaoke', source: 'karaoke-maker', label: 'Custom' },
  music: { tag: 'music', source: 'manual', label: 'Music Video' },
};

function sendGapSetBroll(videoId, opts = {}) {
  const id = videoId || null;
  const title = id ? (resolveTitleLocal(id) || '') : '';
  setCurrentGapBroll(id, title, { recordHistory: opts.recordHistory !== false });
  sendToPlayers('player-event', {
    type: 'gap-set-broll',
    brollVideoId: id,
    title,
    fromStart: !!opts.fromStart,
  });
  notifyInterstitialState();
  return { videoId: id, title };
}

function gapRestartBroll() {
  if (!isGapInterstitialActive() && !pauseInterstitialLive) {
    return { ok: false, error: 'Not in interstitial' };
  }
  if (!currentGapBrollId) return { ok: false, error: 'Nothing spinning' };
  sendToPlayers('player-event', {
    type: 'gap-restart-broll',
    brollVideoId: currentGapBrollId,
  });
  return { ok: true, brollVideoId: currentGapBrollId };
}

function gapDeleteSpin() {
  if (!isGapInterstitialActive() && !pauseInterstitialLive) {
    return { ok: false, error: 'Not in interstitial' };
  }
  const videoId = currentGapBrollId;
  if (!videoId) return { ok: false, error: 'No video loaded' };
  if (!library || typeof library.deleteVideo !== 'function') {
    return { ok: false, error: 'library unavailable' };
  }
  const result = library.deleteVideo(videoId, { siblings: true }) || { ok: true };
  if (result.ok === false) return result;
  try { invalidateMusicBrollPool(); } catch (_) {}
  gapBrollHistory = gapBrollHistory.filter((id) => id && id !== videoId);
  const nextId = pickRandomMusicBrollId();
  const next = sendGapSetBroll(nextId, { fromStart: true });
  return { ok: true, deleted: videoId, nextBrollId: next.videoId, nextBrollTitle: next.title, ...result };
}

function gapRemoveUpNext() {
  if (!isGapInterstitialActive() && !pauseInterstitialLive) {
    return { ok: false, error: 'Not in interstitial' };
  }
  const up = resolveGapUpNext();
  if (up.index < 0) return { ok: false, error: 'No up next singer' };
  return removeFromShowQueue(up.index);
}

function gapReclassifySpin(bucket) {
  if (!isGapInterstitialActive() && !pauseInterstitialLive) {
    return { ok: false, error: 'Not in interstitial' };
  }
  const target = GAP_RECLASS_BUCKETS[bucket];
  const videoId = currentGapBrollId;
  if (!target || !videoId) return { ok: false, error: 'No video loaded' };
  if (!library) return { ok: false, error: 'library unavailable' };
  let result;
  if (typeof library.reclassify === 'function') {
    result = library.reclassify(videoId, { tag: target.tag, source: target.source });
  } else {
    library.setTag(videoId, target.tag);
    result = { ok: true };
  }
  if (result && result.ok === false) return result;
  // Keep base / -karaoke siblings in sync (same as player / controller library UI)
  const base = String(videoId).replace(/-karaoke$/, '');
  const sibling = videoId === base ? base + '-karaoke' : base;
  if (sibling !== videoId) {
    try {
      if (typeof library.reclassify === 'function') {
        library.reclassify(sibling, { tag: target.tag, source: target.source });
      } else {
        library.setTag(sibling, target.tag);
      }
    } catch (_) {}
  }
  try { invalidateMusicBrollPool(); } catch (_) {}
  let next = null;
  if (target.tag !== 'music' && target.tag !== 'song') {
    const nextId = pickRandomMusicBrollId();
    next = sendGapSetBroll(nextId, { fromStart: true });
  } else {
    notifyInterstitialState();
  }
  return {
    ok: true,
    bucket: bucket,
    label: target.label,
    moved: !!(result && result.moved),
    nextBrollId: next && next.videoId,
    ...result,
  };
}

/** After a queue edit during Gap, refresh pending singer without starting playback. */
function syncGapPendingAfterQueueEdit(removedItem) {
  if (!isGapInterstitialActive()) return;
  const removedVid = removedItem && removedItem.videoId;
  const pendingVid = betweenSongsPendingItem && betweenSongsPendingItem.videoId;
  const removedPending = !!(removedVid && pendingVid && removedVid === pendingVid);

  let next = null;
  if (!removedPending && betweenSongsPendingItem) {
    const stillQueued = queue.some((row) => row && row.videoId === pendingVid);
    if (stillQueued) next = betweenSongsPendingItem;
  }
  if (!next && queueIndex >= 0 && queueIndex < queue.length) {
    const at = queue[queueIndex];
    if (isKaraokeQueueItem(at)) next = at;
  }
  if (!next) {
    const karaoke = pendingKaraokeItems();
    next = karaoke.length ? karaoke[0] : null;
    if (next) {
      const idx = queue.indexOf(next);
      if (idx >= 0) queueIndex = idx;
    }
  }
  betweenSongsPendingItem = next;

  if (next) {
    const singer = displaySingerName(next.singer || next.requester);
    const title = displayTitle(next);
    sendToPlayers('player-event', {
      type: 'between-songs-update',
      singer,
      title,
      queue,
      currentIndex: queueIndex,
    });
  }
  notifyInterstitialState();
}

/** Shared queue-remove logic (controller IPC + phone API). */
function removeFromShowQueue(index) {
  if (index == null || index < 0 || index >= queue.length) {
    return { ok: false, error: 'Invalid index' };
  }
  const removedItem = queue[index];
  updateMysqlRequestStatus(removedItem, 'ended', 'removed from queue');
  const inGap = isGapInterstitialActive();
  const removingCurrent = index === queueIndex;
  queue.splice(index, 1);
  if (index < queueIndex) queueIndex--;
  else if (removingCurrent && inGap) {
    if (queueIndex >= queue.length) {
      queueIndex = queue.length ? Math.min(queueIndex, queue.length - 1) : -1;
    }
    syncGapPendingAfterQueueEdit(removedItem);
  } else if (removingCurrent) {
    const karaoke = pendingKaraokeItems();
    if (karaoke.length) {
      queue = karaoke;
      queueIndex = 0;
      skipRequested = true;
      clearBetweenSongsTimer();
      sendPlay(queue[0].videoId, queue[0].title, queue[0].singer);
    } else if (jukeboxActive()) {
      const deckItem = selectNextJukeboxItem(1);
      if (deckItem) {
        const row = makeJukeboxQueueRow(deckItem);
        queue = [row];
        queueIndex = 0;
        skipRequested = true;
        clearBetweenSongsTimer();
        sendPlay(row.videoId, row.title, row.singer);
        saveSettings();
      } else {
        idleStopShow();
        return { ok: true, state: buildPhoneQueueState(), ...showModePayload() };
      }
    } else {
      queueIndex = -1;
      idleStopShow();
      return { ok: true, state: buildPhoneQueueState(), ...showModePayload() };
    }
  } else if (inGap) {
    syncGapPendingAfterQueueEdit(removedItem);
  }
  saveState();
  notifyShowUpdate();
  return { ok: true, state: buildPhoneQueueState(), ...showModePayload() };
}

/** Jump to a queue row. During Gap, skip the countdown and enter show mode cleanly. */
function skipGapAndPlayItem(item, index) {
  if (!item) return;
  skipRequested = true;
  clearBetweenSongsTimer();
  queueIndex = index;
  saveState();
  sendPlay(item.videoId, item.title, item.singer || item.requester, {
    force: true,
    karaoke: isKaraokeQueueItem(item),
  });
  notifyShowUpdate();
}

function skipToShowQueue(index) {
  if (index == null || index < 0 || index >= queue.length) {
    return { ok: false, error: 'Invalid index' };
  }
  const item = queue[index];
  if (isGapInterstitialActive()) {
    if (!isKaraokeQueueItem(item)) {
      return { ok: true, state: buildPhoneQueueState(), ...showModePayload() };
    }
    skipGapAndPlayItem(item, index);
    return {
      ok: true,
      state: buildPhoneQueueState(),
      nowPlaying: buildPhoneNowPlaying(),
      ...showModePayload(),
    };
  }
  skipRequested = true;
  clearBetweenSongsTimer();
  queueIndex = index;
  saveState();
  sendPlay(item.videoId, item.title, item.singer || item.requester, { force: true });
  notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
  notifyPlayerQueue();
  return {
    ok: true,
    state: buildPhoneQueueState(),
    nowPlaying: buildPhoneNowPlaying(),
    ...showModePayload(),
  };
}

function notifyInterstitialState() {
  notifyCtrl('interstitial-state', getInterstitialState());
}

/** Payload for pause interstitial — prefer next singer, else current / paused tip. */
function buildPauseInterstitialPayload(mirrorRouting) {
  let singer = '';
  let title = '';
  let label = 'Up next';
  if (queue.length > 1 && queueIndex >= 0) {
    const next = queue[(queueIndex + 1) % queue.length];
    singer = displaySingerName(next.singer || next.requester);
    title = displayTitle(next);
    label = 'Up next';
  } else if (queueIndex >= 0 && queueIndex < queue.length) {
    const cur = queue[queueIndex];
    singer = displaySingerName(cur.singer || cur.requester);
    title = displayTitle(cur);
    label = 'Paused';
  } else {
    singer = DEFAULT_DJ_NAME;
    title = 'Scan QR to request a song';
    label = 'Paused';
  }
  let content = getGapContent();
  let brollVideoId = null;
  let routing = mirrorRouting || { mode: 'off' };
  // Live dual-gap: never demote to MVs-only just because routing mode string is odd
  if (gapNeedsBroll(content)) {
    brollVideoId = pickRandomMusicBrollId();
  } else {
    brollVideoId = null;
  }
  if (gapNeedsPhone(content) && routing && routing.failed) {
    content = 'music-broll';
    brollVideoId = pickRandomMusicBrollId();
  }
  const mix = getGapMix();
  return {
    type: 'pause-interstitial',
    singer: singer || DEFAULT_DJ_NAME,
    title,
    label,
    gapContent: content,
    brollVideoId,
    mirrorAudioMode: routing.mode || 'off',
    mirrorHouseDevice: routing.house || null,
    mirrorTapDevice: routing.tap || null,
    gapBrollLevel: mix.gapBrollLevel,
    gapPhoneLevel: mix.gapPhoneLevel,
    queue,
    currentIndex: queueIndex,
  };
}

/**
 * Interstitial B-roll pool = Music Videos tab (tag music/song), exclusive songs/ folder.
 * Remote-tagged entries are downloaded into LIBRARY_SONGS_DIR in the background so the
 * local pool grows toward the full ~600 catalog; picks are a no-repeat shuffle of locals.
 */
let musicBrollPool = null; // { all: string[], local: string[], remote: string[] }
let musicBrollPoolBuiltAt = 0;
let musicBrollDeck = []; // shuffled local ids; refill when empty
let musicBrollLocalIndex = null; // Set of bases with a local non-karaoke file
let musicBrollLocalIndexAt = 0;
const MUSIC_BROLL_POOL_TTL_MS = 5 * 60 * 1000;
const MUSIC_BROLL_INDEX_TTL_MS = 60 * 1000;
let musicBrollSeedTimer = null;
let musicBrollSeedInFlight = 0;
const MUSIC_BROLL_SEED_CONCURRENCY = 1;
/** Off by default — auto-filling ~600 Music Videos into songs/ flooded the Processing panel.
 *  Interstitial B-roll uses whatever is already local in songs/. Set true only if you want
 *  background downloads of missing tagged music videos. */
let musicBrollAutoSeed = false;

function musicSearchDirs() {
  const dirs = [];
  const seen = new Set();
  const push = (d) => {
    if (!d) return;
    try {
      const abs = path.resolve(d);
      if (seen.has(abs)) return;
      seen.add(abs);
      dirs.push(abs);
    } catch (_) {}
  };
  if (library) {
    // Prefer exclusive USB songs/, then legacy Mac Deskreen songs/, then Deskreen root
    push(library.LIBRARY_SONGS_DIR);
    const legacy = library.LEGACY_SONGS_DIRS || [];
    for (const d of legacy) push(d);
    push(library.LIBRARY_DIR);
  }
  return dirs;
}

/** Local music bases for Gap B-roll — from in-memory library cache only.
 *  Never readdirSync the USB songs/ folder here (ExFAT scandir freezes IPC). */
function rebuildMusicBrollLocalIndex(force) {
  const now = Date.now();
  if (!force && musicBrollLocalIndex && (now - musicBrollLocalIndexAt) < MUSIC_BROLL_INDEX_TTL_MS) {
    return musicBrollLocalIndex;
  }
  const found = new Set();
  try {
    if (library && typeof library.list === 'function') {
      const r = library.list({}) || {};
      for (const v of (r.videos || [])) {
        if (!v) continue;
        const raw = String(v.videoId || v.id || '');
        if (/-karaoke$/i.test(raw)) continue;
        const base = raw.replace(/-karaoke$/i, '');
        if (!/^[A-Za-z0-9_-]{11}$/.test(base)) continue;
        const tag = String(v.tag || '');
        if (tag && tag !== 'music' && tag !== 'song') continue;
        // Prefer rows that already know a path; otherwise still allow tagged music ids
        if (v.path || v.filePath || v.localPath || tag === 'music' || tag === 'song' || !tag) {
          found.add(base);
        }
      }
    }
  } catch (e) {
    console.warn('[karol] B-roll index from cache failed:', e && e.message);
  }
  musicBrollLocalIndex = found;
  musicBrollLocalIndexAt = now;
  return found;
}

function findLocalMusicFile(base) {
  const idx = rebuildMusicBrollLocalIndex(false);
  if (!idx.has(base)) return null;
  const exts = ['.mp4', '.webm', '.mkv', '.m4v'];
  for (const dir of musicSearchDirs()) {
    for (const ext of exts) {
      const p = path.join(dir, base + ext);
      try {
        if (fs.existsSync(p) && fs.statSync(p).size > 1000) return p;
      } catch (_) {}
    }
  }
  return null;
}

function isMusicVideoTagEntry(entry, key, tags) {
  if (!entry) return false;
  const tag = typeof entry === 'object' ? entry.tag : entry;
  const source = typeof entry === 'object' ? entry.source : '';
  if (source === 'karaoke-maker') return false;
  if (tag !== 'music' && tag !== 'song') return false;
  const km = tags && key && tags[key + '-karaoke'];
  if (km && km.source === 'karaoke-maker' && !source) return false;
  return true;
}

function listMusicVideoIds() {
  const all = [];
  const seen = new Set();
  if (!library || typeof library.getTags !== 'function') return all;
  const tags = library.getTags() || {};
  for (const key of Object.keys(tags)) {
    if (/-karaoke$/.test(key)) continue;
    if (!isMusicVideoTagEntry(tags[key], key, tags)) continue;
    const base = String(key).replace(/-karaoke$/, '');
    if (!/^[A-Za-z0-9_-]{11}$/.test(base) || seen.has(base)) continue;
    seen.add(base);
    all.push(base);
  }
  return all;
}

/** Rebuild Music Videos B-roll pools (all tagged + which are on disk in songs/). */
function rebuildMusicBrollPool(force) {
  const now = Date.now();
  if (!force && musicBrollPool && (now - musicBrollPoolBuiltAt) < MUSIC_BROLL_POOL_TTL_MS) {
    return musicBrollPool;
  }
  const localIdx = rebuildMusicBrollLocalIndex(force);
  const all = [];
  const local = [];
  const remote = [];
  try {
    for (const base of listMusicVideoIds()) {
      all.push(base);
      if (localIdx.has(base)) local.push(base);
      else remote.push(base);
    }
  } catch (e) {
    console.warn('[karol] music broll pool rebuild failed:', e && e.message);
  }
  musicBrollPool = { all, local, remote };
  musicBrollPoolBuiltAt = now;
  if (musicBrollDeck.length) {
    const localSet = new Set(local);
    musicBrollDeck = musicBrollDeck.filter((id) => localSet.has(id));
  }
  console.log('[karol] Interstitial music pool:', local.length, 'local /', all.length, 'Music Videos (songs/ + tagged)',
    musicBrollAutoSeed ? '(auto-seed on)' : '(auto-seed off)');
  return musicBrollPool;
}

/** Invalidate B-roll cache when tags/library change. */
function invalidateMusicBrollPool() {
  musicBrollPool = null;
  musicBrollPoolBuiltAt = 0;
  musicBrollDeck = [];
  musicBrollLocalIndex = null;
  musicBrollLocalIndexAt = 0;
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

function refillMusicBrollDeck(local) {
  const copy = local.slice();
  if (pickRandomMusicBrollId._last && copy.length > 1) {
    const filtered = copy.filter((id) => id !== pickRandomMusicBrollId._last);
    musicBrollDeck = shuffleInPlace(filtered.length ? filtered : copy);
  } else {
    musicBrollDeck = shuffleInPlace(copy);
  }
}

/** Queue missing Music Videos into songs/ (opt-in — does not run unless musicBrollAutoSeed). */
function scheduleMusicBrollSeed() {
  if (!musicBrollAutoSeed) return;
  if (musicBrollSeedTimer) return;
  musicBrollSeedTimer = setTimeout(() => {
    musicBrollSeedTimer = null;
    try { seedNextMusicBrollDownloads(); } catch (e) {
      console.warn('[karol] music broll seed failed:', e && e.message);
    }
  }, 4000);
}

function seedNextMusicBrollDownloads() {
  if (!musicBrollAutoSeed) return;
  const pool = rebuildMusicBrollPool(false);
  if (!pool.remote.length) return;
  while (musicBrollSeedInFlight < MUSIC_BROLL_SEED_CONCURRENCY && pool.remote.length) {
    const idx = Math.floor(Math.random() * pool.remote.length);
    const id = pool.remote.splice(idx, 1)[0];
    if (!id) continue;
    if (rebuildMusicBrollLocalIndex(false).has(id)) continue;
    if (processingJobs[id] && processingJobs[id].status !== 'error' && processingJobs[id].status !== 'done') continue;
    musicBrollSeedInFlight++;
    console.log('[karol] Seeding Music Videos → songs/:', id, '(' + pool.remote.length + ' remaining)');
    try {
      if (library && typeof library.setTag === 'function') library.setTag(id, 'music');
    } catch (_) {}
    try {
      startDirectDownload(id, 'https://www.youtube.com/watch?v=' + id, 'music');
    } catch (e) {
      musicBrollSeedInFlight = Math.max(0, musicBrollSeedInFlight - 1);
      console.warn('[karol] music seed start failed:', id, e && e.message);
      continue;
    }
    const watch = setInterval(() => {
      const job = processingJobs[id];
      const localNow = (() => {
        try {
          rebuildMusicBrollLocalIndex(true);
          return rebuildMusicBrollLocalIndex(false).has(id);
        } catch (_) { return false; }
      })();
      const done = localNow || (job && (job.status === 'done' || job.status === 'error'));
      if (!done) return;
      clearInterval(watch);
      musicBrollSeedInFlight = Math.max(0, musicBrollSeedInFlight - 1);
      invalidateMusicBrollPool();
      setTimeout(() => {
        try { rebuildMusicBrollPool(true); } catch (_) {}
        scheduleMusicBrollSeed();
      }, 500);
    }, 5000);
  }
}

/** Uniform random pick from local Music Videos already on disk (no-repeat deck). */
function pickRandomMusicBrollId() {
  try {
    const pool = rebuildMusicBrollPool(false);
    if (!pool.local.length) {
      console.warn('[karol] No local Music Videos in songs/ for interstitial B-roll (', pool.all.length, 'tagged remote — auto-seed is', musicBrollAutoSeed ? 'on' : 'off', ')');
      return null;
    }
    if (!musicBrollDeck.length) refillMusicBrollDeck(pool.local);
    let choice = musicBrollDeck.pop();
    if (!choice || (pool.local.length > 1 && choice === pickRandomMusicBrollId._last && musicBrollDeck.length)) {
      choice = musicBrollDeck.pop() || choice;
    }
    if (!choice) {
      refillMusicBrollDeck(pool.local);
      choice = musicBrollDeck.pop();
    }
    pickRandomMusicBrollId._last = choice || null;
    return choice || null;
  } catch (e) {
    console.warn('[karol] broll pick failed:', e && e.message);
    return null;
  }
}

/** Hold between-songs countdown; B-roll keeps playing on the player. */
function holdBetweenSongs() {
  if (isHomeInterstitial()) return true; // already parked on home Gap
  if (!betweenSongsPendingItem && !betweenSongsTimer) return false;
  if (betweenSongsTimer) {
    clearTimeout(betweenSongsTimer);
    betweenSongsTimer = null;
    betweenSongsRemainingMs = Math.max(1500, betweenSongsDeadline - Date.now());
  }
  betweenSongsHeld = true;
  sendToPlayers('player-event', { type: 'between-songs-hold' });
  console.log('[karol] Interstitial held —', Math.round(betweenSongsRemainingMs / 1000) + 's remaining');
  notifyInterstitialState();
  return true;
}

/** Resume held between-songs countdown. */
function resumeBetweenSongs() {
  if (isHomeInterstitial()) return false; // no countdown on home Gap
  if (!betweenSongsHeld || !betweenSongsPendingItem) return false;
  betweenSongsHeld = false;
  const ms = Math.max(1500, betweenSongsRemainingMs || getBetweenSongsMs());
  betweenSongsDeadline = Date.now() + ms;
  sendToPlayers('player-event', { type: 'between-songs-resume', remainingMs: ms });
  betweenSongsTimer = setTimeout(() => {
    betweenSongsTimer = null;
    const pending = betweenSongsPendingItem;
    betweenSongsPendingItem = null;
    betweenSongsRemainingMs = 0;
    beginGapHandoff(pending, gapEpoch);
  }, ms);
  console.log('[karol] Interstitial resumed —', Math.round(ms / 1000) + 's left');
  notifyInterstitialState();
  return true;
}

/** Dedicated Hold/Resume for the Gap interstitial (controller HOLD button). */
function toggleBetweenSongsHold() {
  if (isHomeInterstitial()) return getInterstitialState();
  if (betweenSongsHeld) {
    resumeBetweenSongs();
  } else if (betweenSongsTimer || betweenSongsPendingItem) {
    holdBetweenSongs();
  }
  return getInterstitialState();
}

function doTransportPause() {
  // Gap hold is HOLD-only — Pause never freezes the between-songs countdown
  if (betweenSongsTimer || betweenSongsHeld || betweenSongsPendingItem) {
    return {
      ok: true,
      ignored: true,
      reason: 'gap_active',
      nowPlaying: buildPhoneNowPlaying(),
      ...getInterstitialState(),
    };
  }
  playback.state = 'paused';
  let mirrorRouting = { mode: 'off' };
  try {
    if (gapNeedsPhone(getGapContent())) {
      const mir = ensurePhoneMirrorForGap(true);
      if (mir && mir.ok) {
        mirrorRouting = mir.routing || { mode: 'direct' };
      } else {
        console.warn('[karol] Pause phone mirror failed — MVs fallback:', mir && mir.error);
        notifyCtrl('phone-mirror-status', {
          ...((mir && mir.status) || {}),
          error: (mir && mir.error) || 'Phone mirror failed',
          fallback: 'music-broll',
        });
        mirrorRouting = { mode: 'off', failed: true };
        try { if (phoneMirror) phoneMirror.stopPhoneMirror(); } catch (_) {}
      }
    } else {
      try { if (phoneMirror && phoneMirror.isRunning()) phoneMirror.stopPhoneMirror(); } catch (_) {}
    }
    const payload = buildPauseInterstitialPayload(mirrorRouting);
    console.log('[karol] Pause interstitial:', payload.gapContent, payload.label, payload.singer);
    pauseInterstitialLive = true;
    setCurrentGapBroll(payload.brollVideoId || null, '');
    sendToPlayers('player-event', payload);
  } catch (e) {
    console.error('[karol] Pause interstitial failed — safe pause only:', e && e.message);
    pauseInterstitialLive = false;
    setCurrentGapBroll(null, '');
    try { if (phoneMirror) phoneMirror.stopPhoneMirror(); } catch (_) {}
    notifyPlayer({ type: 'pause' });
  }
  notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
  notifyInterstitialState();
  return { ok: true, nowPlaying: buildPhoneNowPlaying() };
}

function doTransportPlay() {
  // Gap resume is HOLD/RESUME-only — Play does not unstick a held interstitial
  if (betweenSongsHeld && betweenSongsPendingItem) {
    return {
      ok: true,
      ignored: true,
      reason: 'gap_held',
      nowPlaying: buildPhoneNowPlaying(),
      ...getInterstitialState(),
    };
  }
  // During an active (unheld) gap, skip countdown and start the pending singer
  if (isGapInterstitialActive()) {
    const pending = betweenSongsPendingItem
      || (queueIndex >= 0 && queueIndex < queue.length ? queue[queueIndex] : null);
    if (pending && isKaraokeQueueItem(pending)) {
      skipGapAndPlayItem(pending, queueIndex >= 0 ? queueIndex : 0);
      return { ok: true, nowPlaying: buildPhoneNowPlaying(), ...getInterstitialState() };
    }
    return {
      ok: true,
      ignored: true,
      reason: 'gap_active',
      nowPlaying: buildPhoneNowPlaying(),
      ...getInterstitialState(),
    };
  }
  // Resume same paused track — tear down pause interstitial / phone mirror first
  if (playback.state === 'paused') {
    pauseInterstitialLive = false;
    setCurrentGapBroll(null, '');
    try { if (phoneMirror && phoneMirror.isRunning()) phoneMirror.stopPhoneMirror(); } catch (_) {}
    sendToPlayers('player-event', { type: 'phone-mirror-capture-stop' });
    notifyCtrl('phone-mirror-status', phoneMirrorStatusQuiet());
    sendToPlayers('player-event', { type: 'resume' });
    playback.state = 'playing';
    notifyInterstitialState();
    return { ok: true, nowPlaying: buildPhoneNowPlaying() };
  }
  notifyPlayer({ type: 'play' });
  playback.state = 'playing';
  return { ok: true, nowPlaying: buildPhoneNowPlaying() };
}

/**
 * Start the next show item.
 * Gap interstitial + singer entrance are karaoke-only.
 * Jukebox/DJ advances cut straight to the next track.
 */
function playShowItem(item) {
  if (!item) return;
  if (isKaraokeQueueItem(item)) {
    playAfterBetweenSongs(item);
    return;
  }
  homeInterstitialLive = false;
  clearBetweenSongsTimer();
  betweenSongsPendingItem = null;
  betweenSongsRemainingMs = 0;
  betweenSongsDeadline = 0;
  notifyInterstitialState();
  if (!playWin || playWin.isDestroyed()) createPlayer();
  sendPlay(item.videoId, item.title, item.singer || item.requester, {
    force: true,
    karaoke: false,
  });
  notifyPlayerQueue();
}

/** Show next-singer + big QR + music B-roll (or phone mirror), then start karaoke. */
function playAfterBetweenSongs(item) {
  if (!item) return;
  // Safety: never Gap for DJ/jukebox rows
  if (!isKaraokeQueueItem(item)) {
    playShowItem(item);
    return;
  }
  // Arm pending before teardown so duplicate ended cannot re-advance the last singer.
  betweenSongsPendingItem = item;
  homeInterstitialLive = false;
  clearBetweenSongsTimer({ keepPending: true });
  const ms = getBetweenSongsMs();
  betweenSongsRemainingMs = ms;
  betweenSongsDeadline = Date.now() + ms;
  betweenSongsHeld = false;
  const singer = displaySingerName(item.singer || item.requester);
  const title = displayTitle(item);
  if (!playWin || playWin.isDestroyed()) createPlayer();

  let content = getGapContent();
  let brollVideoId = null;
  let mirrorRouting = { mode: 'off' };
  if (gapNeedsPhone(content)) {
    const mir = ensurePhoneMirrorForGap(true);
    if (!mir.ok) {
      console.warn('[karol] Phone mirror failed — falling back to Music Videos:', mir.error);
      notifyCtrl('phone-mirror-status', {
        ...(mir.status || {}),
        error: mir.error || 'Phone mirror failed',
        fallback: 'music-broll',
      });
      content = 'music-broll';
      try { if (phoneMirror) phoneMirror.stopPhoneMirror(); } catch (_) {}
      brollVideoId = pickRandomMusicBrollId();
    } else {
      mirrorRouting = mir.routing || { mode: 'direct' };
      if (gapNeedsBroll(content)) {
        brollVideoId = pickRandomMusicBrollId();
      }
      console.log('[karol] Interstitial', content, mirrorRouting.mode, 'gap', ms + 'ms', 'singer', singer,
        brollVideoId ? ('broll ' + brollVideoId) : '');
    }
  } else {
    try { if (phoneMirror && phoneMirror.isRunning()) phoneMirror.stopPhoneMirror(); } catch (_) {}
    brollVideoId = pickRandomMusicBrollId();
    console.log('[karol] Interstitial broll pick:', brollVideoId || '(none)', 'gap', ms + 'ms', 'singer', singer);
  }

  const mix = getGapMix();
  // Clear stale feature clock so Gap UI doesn't look like a frozen playing track
  // (and so sendPlay debounce / progress guards don't use leftover times).
  playback = {
    videoId: item.videoId || null,
    currentTime: 0,
    duration: 0,
    state: 'interstitial',
  };
  featureTrackEverProgressed = false;
  pauseInterstitialLive = false;
  setCurrentGapBroll(brollVideoId || null, '');
  sendToPlayers('player-event', {
    type: 'between-songs',
    singer: singer,
    title,
    durationMs: ms,
    gapContent: content,
    brollVideoId,
    mirrorAudioMode: mirrorRouting.mode || 'off',
    mirrorHouseDevice: mirrorRouting.house || null,
    mirrorTapDevice: mirrorRouting.tap || null,
    gapBrollLevel: mix.gapBrollLevel,
    gapPhoneLevel: mix.gapPhoneLevel,
    queue,
    currentIndex: queueIndex,
  });
  notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
  notifyPlayerQueue();
  betweenSongsTimer = setTimeout(() => {
    betweenSongsTimer = null;
    const pending = betweenSongsPendingItem;
    betweenSongsPendingItem = null;
    betweenSongsRemainingMs = 0;
    beginGapHandoff(pending, gapEpoch);
  }, ms);
  notifyInterstitialState();
}

/** DJ mirror row — only explicit fromJukebox stamps (never by videoId match). */
function isDjQueueItem(item) {
  return !!(item && item.fromJukebox);
}

/** Karaoke = singer-queue rows (not the DJ feature track). */
function isKaraokeQueueItem(item) {
  return !!(item && !isDjQueueItem(item));
}

function pendingKaraokeItems() {
  return queue.filter(isKaraokeQueueItem);
}

function pendingKaraokeCount() {
  return pendingKaraokeItems().length;
}

/** Ensure DJ mirrors keep house credit — do NOT reclassify karaoke requests that
 *  happen to share a videoId with the current Music Video. */
function healDjMirrorFlags() {
  if (!jukeboxActive()) return;
  const dj = DEFAULT_DJ_NAME;
  for (const item of queue) {
    if (!item || !item.fromJukebox) continue;
    if (!item.singer || /^dj$/i.test(String(item.singer))) item.singer = dj;
    if (!item.requester || /^dj$/i.test(String(item.requester))) item.requester = dj;
  }
}

/** Derived show mode for UI: KJ interrupt vs DJ default vs idle. */
function showMode() {
  if (betweenSongsPendingItem && isKaraokeQueueItem(betweenSongsPendingItem)) return 'kj';
  const cur = queueIndex >= 0 && queueIndex < queue.length ? queue[queueIndex] : null;
  if (cur && isKaraokeQueueItem(cur) && (playback.state === 'playing' || playback.state === 'paused')) {
    return 'kj';
  }
  if (jukeboxActive()) return 'dj';
  if (pendingKaraokeCount() > 0) return 'kj';
  return 'idle';
}

function showModePayload() {
  return {
    showMode: showMode(),
    pendingKaraoke: pendingKaraokeCount(),
  };
}

function notifyShowUpdate() {
  notifyCtrl('queue-update', {
    queue,
    currentIndex: queueIndex,
    shuffleEnabled: !!queueShuffle,
    jukebox: jukeboxSummary(),
    ...showModePayload(),
  });
  notifyPlayerQueue();
}

function idleStopShow() {
  queue = pendingKaraokeItems(); // drop DJ mirrors
  queueIndex = queue.length ? 0 : -1;
  clearMediaWait();
  saveState();
  enterHomeInterstitial({ force: true });
}

function jukeboxActive() {
  return !!(jukebox && Array.isArray(jukebox.items) && jukebox.items.length);
}

function isBirthdayJukebox() {
  return jukeboxActive() && jukebox.kind === 'birthday';
}

/** Birthday deck + music jukebox: non-karaoke MV file on disk (songs/ or legacy paths). */
function isLocalMusicVideo(videoId) {
  const vid = String(videoId || '').replace(/-karaoke$/, '');
  if (!/^[A-Za-z0-9_-]{11}$/.test(vid)) return false;
  try {
    const p = library && typeof library.getVideoPath === 'function' ? library.getVideoPath(vid) : null;
    return !!(p && fs.existsSync(p) && fs.statSync(p).size >= 50_000 && !/-karaoke\.mp4$/i.test(p));
  } catch (_) {
    return false;
  }
}

/** Merge newly-downloaded birthday manifest tracks into the armed deck. */
function refreshBirthdayDeckLocals() {
  if (!isBirthdayJukebox()) return 0;
  const saved = loadBirthdayPlaylistFile();
  if (!saved || !Array.isArray(saved.tracks)) return 0;
  const seen = new Set(jukebox.items.map((it) => it.videoId));
  let added = 0;
  for (const t of saved.tracks) {
    const vid = String(t.videoId || '').replace(/-karaoke$/, '');
    if (!vid || seen.has(vid) || !isLocalMusicVideo(vid)) continue;
    seen.add(vid);
    jukebox.items.push({
      videoId: vid,
      title: bestTitleFor(vid, t.title || ''),
    });
    added++;
  }
  if (added) console.log('[karol] Birthday deck: +' + added + ' newly local track(s)');
  return added;
}

/** Background downloads for manifest rows not yet on disk — deck stays local-only. */
function seedBirthdayRemoteDownloads() {
  const saved = loadBirthdayPlaylistFile();
  if (!saved || !Array.isArray(saved.tracks)) return 0;
  let n = 0;
  for (const t of saved.tracks) {
    const vid = String(t.videoId || '').replace(/-karaoke$/, '');
    if (!/^[A-Za-z0-9_-]{11}$/.test(vid) || isLocalMusicVideo(vid)) continue;
    startDirectDownload(vid, 'https://www.youtube.com/watch?v=' + vid, 'music');
    n++;
  }
  if (n) console.log('[karol] Birthday playlist: seeding', n, 'background download(s)');
  return n;
}

function jukeboxSummary() {
  if (!jukeboxActive()) return null;
  return {
    active: true,
    count: jukebox.items.length,
    index: jukebox.index,
    shuffle: !!jukebox.shuffle,
    kind: jukebox.kind || 'music',
    name: jukebox.name || (jukebox.kind === 'birthday' ? 'Birthday Playlist' : 'Music Jukebox'),
    current: jukebox.items[jukebox.index] || null,
  };
}

function loadBirthdayPlaylistFile() {
  try {
    if (!fs.existsSync(BIRTHDAY_PLAYLIST_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(BIRTHDAY_PLAYLIST_FILE, 'utf8'));
    if (!data || !Array.isArray(data.tracks)) return null;
    const tracks = data.tracks
      .map((t) => ({
        videoId: String(t.videoId || '').replace(/-karaoke$/, ''),
        title: String(t.title || t.displayTitle || '').trim()
          || [t.artist, t.spotifyTitle || t.title].filter(Boolean).join(' — '),
        artist: String(t.artist || ''),
        spotifyTitle: String(t.spotifyTitle || t.title || ''),
        source: t.source || '',
        local: !!t.local,
      }))
      .filter((t) => /^[A-Za-z0-9_-]{11}$/.test(t.videoId));
    if (!tracks.length) return null;
    const localReady = tracks.filter((t) => isLocalMusicVideo(t.videoId)).length;
    return {
      name: String(data.name || 'Birthday Playlist'),
      spotifyPlaylistId: data.spotifyPlaylistId || '',
      updatedAt: data.updatedAt || '',
      trackCount: tracks.length,
      matchedLocal: localReady,
      tracks,
    };
  } catch (e) {
    console.warn('[karol] birthday playlist load failed:', e.message);
    return null;
  }
}

function makeJukeboxQueueRow(deckItem) {
  const who = activeDjName();
  return {
    videoId: deckItem.videoId,
    title: deckItem.title || bestTitleFor(deckItem.videoId, ''),
    singer: who,
    requester: who,
    fromJukebox: true,
  };
}

/** Move DJ deck index; returns the selected item or null. */
function clearJukeboxPlayHistory() {
  jukeboxPlayHistory = [];
}

function jukeboxGoBack() {
  if (!jukeboxActive()) return null;
  if (!jukeboxPlayHistory.length) {
    // No prior track this session — restart the current MV from the top.
    return jukebox.items[jukebox.index] || null;
  }
  jukebox.index = jukeboxPlayHistory.pop();
  return jukebox.items[jukebox.index] || null;
}

function selectNextJukeboxItem(direction) {
  if (!jukeboxActive()) return null;
  if (isBirthdayJukebox()) refreshBirthdayDeckLocals();
  const n = jukebox.items.length;
  if (n === 0) return null;
  const dir = direction < 0 ? -1 : 1;
  if (dir < 0) return jukeboxGoBack();
  const birthdayLocalOnly = isBirthdayJukebox();

  // Forward — remember the row we're leaving so Prev rewinds shuffle order.
  const curIdx = jukebox.index;
  if (n > 1 && Number.isFinite(curIdx)) {
    if (jukeboxPlayHistory.length >= JUKEBOX_HISTORY_MAX) jukeboxPlayHistory.shift();
    jukeboxPlayHistory.push(curIdx);
  }

  if (jukebox.shuffle && n > 1) {
    const curId = String((jukebox.items[jukebox.index] && jukebox.items[jukebox.index].videoId) || '');
    if (curId) shufflePlayedIds.add(curId);
    let candidates = [];
    for (let i = 0; i < n; i++) {
      if (i === jukebox.index) continue;
      const id = String(jukebox.items[i].videoId || '');
      if (birthdayLocalOnly && !isLocalMusicVideo(id)) continue;
      if (!shufflePlayedIds.has(id)) candidates.push(i);
    }
    if (!candidates.length) {
      shufflePlayedIds.clear();
      if (curId) shufflePlayedIds.add(curId);
      for (let i = 0; i < n; i++) {
        if (i === jukebox.index) continue;
        const id = String(jukebox.items[i].videoId || '');
        if (birthdayLocalOnly && !isLocalMusicVideo(id)) continue;
        candidates.push(i);
      }
    }
    if (!candidates.length) return jukebox.items[jukebox.index] || null;
    jukebox.index = candidates[Math.floor(Math.random() * candidates.length)];
  } else if (birthdayLocalOnly) {
    for (let step = 1; step <= n; step++) {
      const idx = (jukebox.index + dir * step + n) % n;
      const id = String((jukebox.items[idx] && jukebox.items[idx].videoId) || '');
      if (isLocalMusicVideo(id)) {
        jukebox.index = idx;
        break;
      }
    }
  } else {
    jukebox.index = (jukebox.index + dir + n) % n;
  }
  return jukebox.items[jukebox.index] || null;
}

/**
 * Single “what plays next” resolver for natural end + skip/prev.
 * Pending karaoke always wins over the DJ deck; finished karaoke is consumed.
 */
function advanceShow({ direction = 1, fromEnded = false } = {}) {
  const now = Date.now();
  if (fromEnded && lastAdvanceAtMs && (now - lastAdvanceAtMs) < ADVANCE_DEBOUNCE_MS) {
    console.warn('[karol] Ignoring rapid natural-end re-advance (' + (now - lastAdvanceAtMs) + 'ms)');
    skipRequested = true; // absorb further ended noise until next real play
    return;
  }

  healDjMirrorFlags();
  const dir = direction < 0 ? -1 : 1;
  const cur = queueIndex >= 0 && queueIndex < queue.length ? queue[queueIndex] : null;

  // Arm skip guard immediately so gap teardown / duplicate ended cannot cascade
  skipRequested = true;
  lastAdvanceAtMs = now;

  // ── Backward skip ──
  if (dir === -1 && !fromEnded) {
    const karaoke = pendingKaraokeItems();
    if (cur && isKaraokeQueueItem(cur) && karaoke.length > 1) {
      const pos = karaoke.indexOf(cur);
      const prev = karaoke[(pos - 1 + karaoke.length) % karaoke.length];
      queue = karaoke;
      queueIndex = Math.max(0, queue.indexOf(prev));
      saveState();
      playShowItem(queue[queueIndex]);
      notifyShowUpdate();
      return;
    }
    if (jukeboxActive()) {
      const deckItem = selectNextJukeboxItem(-1);
      if (!deckItem) { idleStopShow(); return; }
      const row = makeJukeboxQueueRow(deckItem);
      queue = [row, ...karaoke];
      queueIndex = 0;
      saveSettings();
      saveState();
      playShowItem(row);
      notifyShowUpdate();
      return;
    }
    if (karaoke.length) {
      queue = karaoke;
      queueIndex = karaoke.length - 1;
      saveState();
      playShowItem(queue[queueIndex]);
      notifyShowUpdate();
      return;
    }
    // Empty show / home Gap — Prev walks Now Spinning history (not a random pick)
    if (isHomeInterstitial() || isGapInterstitialActive()) {
      prevGapBroll();
    }
    return;
  }

  // ── Forward / natural end ──
  const wasDj = isDjQueueItem(cur);
  const wasKaraoke = isKaraokeQueueItem(cur);
  if (wasKaraoke) {
    updateMysqlRequestStatus(cur, 'ended', fromEnded ? undefined : 'skipped');
    queue.splice(queueIndex, 1);
  } else if (wasDj) {
    // Drop the DJ mirror; karaoke rows (if any) shift forward
    queue.splice(queueIndex, 1);
    // Pre-advance deck so a later DJ resume doesn't replay this MV
    if (jukeboxActive()) selectNextJukeboxItem(1);
  }

  const karaoke = pendingKaraokeItems();
  if (karaoke.length > 0) {
    queue = karaoke;
    queueIndex = 0;
    // Arm pending before Gap setup so a duplicate ended cannot consume the last singer.
    betweenSongsPendingItem = queue[0];
    saveState();
    playShowItem(queue[0]); // karaoke → Gap + entrance
    notifyShowUpdate();
    return;
  }

  if (jukeboxActive()) {
    // After DJ→DJ: index already advanced above. After karaoke→DJ: play current index.
    let deckItem = null;
    if (wasDj) {
      deckItem = jukebox.items[jukebox.index] || null;
    } else {
      deckItem = wasKaraoke
        ? (jukebox.items[jukebox.index] || null)
        : selectNextJukeboxItem(1);
    }
    if (!deckItem) { idleStopShow(); return; }
    const row = makeJukeboxQueueRow(deckItem);
    queue = [row];
    queueIndex = 0;
    saveSettings();
    saveState();
    playShowItem(row); // jukebox → hard cut, no Gap / entrance
    notifyShowUpdate();
    return;
  }

  // Empty show — Gap interstitial is home base. Skip cycles B-roll; Prev uses history.
  if (isHomeInterstitial()) {
    cycleGapBroll();
    return;
  }
  idleStopShow();
}

function advanceQueue(direction) {
  advanceShow({ direction: direction < 0 ? -1 : 1, fromEnded: false });
}

/** Build / arm DJ deck from music-video rows — skips missing/tiny files unless allowRemote. */
function startJukebox(rawItems, { shuffle = true, play = true, requester, kind = 'music', name, allowRemote = false } = {}) {
  const who = kind === 'birthday' ? DEFAULT_DJ_NAME : normalizeQueueSinger(requester);
  const cleaned = [];
  const seen = new Set();
  const remoteOk = allowRemote;
  for (const raw of rawItems || []) {
    if (!raw) continue;
    // Music jukebox / DJ deck must stay on Music Video ids — never remap to
    // `{id}-karaoke` even when a custom karaoke twin exists on disk.
    const vid = String(raw.videoId || raw.id || '').replace(/-karaoke$/, '');
    if (!vid || seen.has(vid) || !/^[A-Za-z0-9_-]{11}$/.test(vid)) continue;
    let playable = false;
    if (remoteOk) {
      playable = true;
    } else if (isLocalMusicVideo(vid)) {
      playable = true;
    }
    if (!playable) continue;
    seen.add(vid);
    cleaned.push({
      videoId: vid,
      title: bestTitleFor(vid, raw.title || ''),
    });
  }
  if (!cleaned.length) {
    const err = kind === 'birthday'
      ? 'No local birthday MVs ready yet — background downloads are running; try Start again as files land'
      : (remoteOk
        ? 'No jukebox videos with valid YouTube IDs'
        : 'No playable local music videos found');
    return { ok: false, error: err, added: 0 };
  }
  if (shuffle) shuffleInPlace(cleaned);
  const deckName = String(name || '').trim()
    || (kind === 'birthday' ? 'Birthday Playlist' : 'Music Jukebox');
  jukebox = { items: cleaned, index: 0, shuffle: !!shuffle, kind, name: deckName };
  clearJukeboxPlayHistory();
  queueShuffle = !!shuffle;
  shufflePlayedIds.clear();
  // Keep pending karaoke; DJ mirror is only the current feature track
  const karaoke = pendingKaraokeItems();
  const first = cleaned[0];
  const row = {
    videoId: first.videoId,
    title: first.title,
    singer: who,
    requester: who,
    fromJukebox: true,
  };
  queue = [row, ...karaoke];
  queueIndex = 0;
  saveSettings();
  saveState();
  if (play) {
    skipRequested = true;
    sendPlay(first.videoId, first.title, who);
  }
  notifyShowUpdate();
  console.log('[karol] DJ deck armed:', deckName, cleaned.length, 'tracks, shuffle=', !!shuffle, 'singers waiting=', karaoke.length);
  return {
    ok: true,
    added: cleaned.length,
    skipped: (rawItems || []).length - cleaned.length,
    jukebox: jukeboxSummary(),
    shuffleEnabled: !!queueShuffle,
    queueLength: queue.length,
    currentIndex: queueIndex,
    ...showModePayload(),
  };
}

function startBirthdayPlaylist({ shuffle = true, play = true, requester } = {}) {
  const saved = loadBirthdayPlaylistFile();
  if (!saved) {
    return { ok: false, error: 'Birthday playlist not found — run tools/import-spotify-playlist.py first', added: 0 };
  }
  seedBirthdayRemoteDownloads();
  return startJukebox(saved.tracks, {
    shuffle,
    play,
    requester,
    kind: 'birthday',
    name: saved.name || 'Birthday Playlist',
  });
}

function stopJukebox() {
  jukebox = null;
  clearJukeboxPlayHistory();
  // Strip DJ mirrors from the interactive queue; keep karaoke
  const karaoke = pendingKaraokeItems();
  const cur = queueIndex >= 0 && queueIndex < queue.length ? queue[queueIndex] : null;
  const wasDj = cur && cur.fromJukebox;
  queue = karaoke;
  if (wasDj) {
    queueIndex = karaoke.length ? 0 : -1;
  } else if (cur && isKaraokeQueueItem(cur)) {
    queueIndex = queue.indexOf(cur);
    if (queueIndex < 0) queueIndex = karaoke.length ? 0 : -1;
  } else {
    queueIndex = karaoke.length ? Math.min(queueIndex, karaoke.length - 1) : -1;
  }
  saveSettings();
}

function advanceJukebox(direction) {
  advanceShow({ direction: direction < 0 ? -1 : 1, fromEnded: false });
}

/** Append a singer-queue row; DJ stays armed and yields at the next Gap. */
function enqueueKaraokeItem({ videoId, title, requester, mysqlRequestId } = {}) {
  const vid = resolveVid(videoId);
  if (!vid) return { ok: false, error: 'No videoId' };
  const cleanTitle = bestTitleFor(vid, title);
  const who = normalizeQueueSinger(requester);
  const item = {
    videoId: vid,
    title: cleanTitle,
    singer: who,
    requester: who,
  };
  if (mysqlRequestId) item.mysqlRequestId = mysqlRequestId;
  queue.push(item);
  // Idle / home Gap → start timed Gap (or defer until media is on disk).
  if (queueIndex < 0 || isHomeInterstitial()) {
    queueIndex = queue.length - 1;
    if (isQueueItemMediaReady(item)) {
      playAfterBetweenSongs(item);
    } else {
      console.log('[karol] Queued while downloading — deferring play/entrance:', vid);
      ensureDownloadForPlay(vid, { karaoke: true });
      armMediaWait({
        videoId: vid,
        title: cleanTitle,
        requester: who,
        opts: { force: true, karaoke: true },
      });
    }
  }
  saveState();
  notifyShowUpdate();
  return { ok: true, videoId: vid, item, ...showModePayload() };
}

function setQueueShuffle(enabled, { reshuffleUpcoming } = {}) {
  queueShuffle = !!enabled;
  if (!queueShuffle) {
    shufflePlayedIds.clear();
  } else if (jukeboxActive()) {
    jukebox.shuffle = true;
    if (reshuffleUpcoming) {
      const cur = jukebox.items[jukebox.index];
      const rest = jukebox.items.filter((_, i) => i !== jukebox.index);
      shuffleInPlace(rest);
      jukebox.items = cur ? [cur, ...rest] : rest;
      jukebox.index = 0;
      shufflePlayedIds.clear();
      if (cur && cur.videoId) shufflePlayedIds.add(String(cur.videoId));
    }
  } else if (reshuffleUpcoming && queue.length > 1 && queueIndex >= 0) {
    // Physically shuffle items after the current track so the list UI matches
    const head = queue.slice(0, queueIndex + 1);
    const rest = queue.slice(queueIndex + 1);
    shuffleInPlace(rest);
    queue = head.concat(rest);
    shufflePlayedIds.clear();
    if (queue[queueIndex] && queue[queueIndex].videoId) {
      shufflePlayedIds.add(String(queue[queueIndex].videoId));
    }
  }
  saveSettings();
  saveState();
  notifyCtrl('queue-update', {
    queue,
    currentIndex: queueIndex,
    shuffleEnabled: queueShuffle,
    jukebox: jukeboxSummary(),
  });
  notifyPlayerQueue();
  return {
    ok: true,
    shuffleEnabled: queueShuffle,
    queue,
    currentIndex: queueIndex,
    jukebox: jukeboxSummary(),
  };
}

// Send a SLIM upcoming window to the player (marquee). Never ship 600+ full rows.
function notifyPlayerQueue() {
  let slim = queue;
  let idx = queueIndex;
  if (jukeboxActive()) {
    // Synthesize a short upcoming list from the jukebox deck for the marquee
    const items = jukebox.items;
    const cur = jukebox.index;
    const upcoming = [];
    for (let step = 1; step <= 12 && step < items.length; step++) {
      const i = (cur + step) % items.length;
      upcoming.push({
        videoId: items[i].videoId,
        title: items[i].title,
        requester: DEFAULT_DJ_NAME,
      });
    }
    slim = [
      {
        videoId: items[cur].videoId,
        title: items[cur].title,
        requester: DEFAULT_DJ_NAME,
      },
      ...upcoming,
    ];
    idx = 0;
  } else if (queue.length > 40) {
    const start = Math.max(0, queueIndex - 2);
    const end = Math.min(queue.length, start + 25);
    slim = queue.slice(start, end).map((item) => ({
      videoId: item.videoId,
      title: item.title,
      requester: item.requester || item.singer || '',
    }));
    idx = Math.max(0, queueIndex - start);
  }
  sendToPlayers('player-event', {
    type: 'queue-update',
    queue: slim,
    currentIndex: idx,
    queueTotal: jukeboxActive() ? jukebox.items.length : queue.length,
    jukebox: jukeboxSummary(),
  });
}

function notifyCtrl(ch, data) {
  if (ctrlWin && !ctrlWin.isDestroyed()) ctrlWin.webContents.send(ch, data);
}
function notifyPlayer(msg) {
  sendToPlayers('player-event', msg);
}

function windowIconOpts() {
  return APP_ICON && !APP_ICON.isEmpty() ? { icon: APP_ICON } : {};
}

// ── App ──
app.whenReady().then(async () => {
  console.log('[karol] Karol Electron');
  if (process.platform === 'darwin' && app.dock && APP_ICON && !APP_ICON.isEmpty()) {
    app.dock.setIcon(APP_ICON);
  }
  // Allow Web MIDI in the controller (MIDI Mix fader 8 → Out volume).
  try {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      if (permission === 'midi' || permission === 'midiSysex') {
        callback(true);
        return;
      }
      // Unhandled permissions: deny (Karol does not use cam/mic in the controller).
      callback(false);
    });
  } catch (e) {
    console.warn('[karol] MIDI permission hooks failed:', e && e.message);
  }
  console.log('[karol] Displays:', screen.getAllDisplays().map(d => ({
    id: d.id, label: d.label, primary: d.id === screen.getPrimaryDisplay().id, bounds: d.bounds,
  })));

  // Hot-plug HDMI / external: move player onto the new screen automatically
  screen.on('display-added', (_e, display) => {
    console.log('[karol] Display added:', display.label || display.id, display.bounds);
    if (playWin && !playWin.isDestroyed()) {
      schedulePlacePlayerOnExternalDisplay('display-added');
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
    // Debounced + no-op when already correct — raw handler used to exit/enter
    // fullscreen in a loop and freeze the Mac.
    schedulePlacePlayerOnExternalDisplay('display-metrics-changed');
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

  // Restore queue/DJ deck before anything else so IPC/API have real state.
  // Only touch /tmp here — never the USB library drive (can hang for minutes).
  loadState();
  loadSettings();

  setTimeout(() => {
    try {
      if (karolAudio) karolAudio.configureAudioOnStartup();
    } catch (e) {
      console.warn('[karol-audio] startup configure failed:', e && e.message);
    }
  }, 3000);

  // ── Start API server for public domain access (with auto-respawn) ──
  // MUST run before any maxone/USB I/O. library.init / drive watch call
  // sync fs on the external volume and were freezing startup so :3131 never
  // came up (LaunchAgent then filled the gap with a dead no-IPC orphan).
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
        enqueueKaraokeItem({
          videoId: vid,
          title: cleanTitle,
          requester: requester || '',
          mysqlRequestId: mysqlRequestId || null,
        });
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
      console.log('[karol] Web-triggered library refresh (soft):', msg.videoId);
      // Single-video publish used to call init(true) and wipe/rebuild the whole
      // catalog on ExFAT. Prefer the existing cache; only scan if none.
      notifyCtrl('library-scan-progress', { videoId: msg.videoId, status: 'done' });
      if (library && typeof library.init === 'function') {
        const cur = (typeof library.list === 'function' ? library.list({}) : null) || {};
        if (!cur.ok) library.init(false);
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

  // Library cache from /tmp only — never walk maxone on the main thread.
  // (ExFAT readdir was freezing Electron so player IPC died and tracks
  // looked like they were "randomly restarting" / skipping.)
  if (library && typeof library.setScanListener === 'function') {
    library.setScanListener((status) => {
      notifyCtrl('library-scan-progress', status);
    });
  }
  if (library && typeof library.tryLoadCacheFromDisk === 'function') {
    try {
      library.tryLoadCacheFromDisk();
      console.log('[karol] Library cache loaded from /tmp (no USB walk)');
    } catch (_) {}
  }
  // Kick a background scan when maxone is already plugged in (probeDrive is
  // stat-only — safe). list() auto-starts the worker when the drive is readable.
  setTimeout(() => {
    try {
      if (!library || typeof library.list !== 'function') return;
      const cur = library.list({}) || {};
      if (!cur.ok && typeof library.refreshDiskStats === 'function') {
        library.refreshDiskStats({ recount: false });
      }
    } catch (e) {
      console.error('[karol] Deferred library bootstrap failed:', e.message);
    }
  }, 2000);
  // Never warm B-roll / disk counts on startup — ExFAT readdir freezes IPC.
  setTimeout(() => {
    try { startUsbKeepAwake(); } catch (_) {}
  }, 8000);
  setTimeout(() => {
    try { startExternalDriveWatch(); } catch (_) {}
  }, 5000);

  setTimeout(() => {
    fixBareIdQueueTitles('startup').catch((e) => console.error('[karol] Title heal failed:', e.message));
  }, 4000);
  setTimeout(() => {
    reclaimKaraokeJobs().catch((e) => console.error('[karol] Job reclaim failed:', e.message));
  }, 8000);

  function refreshYtCookies() {
    const cookiesPath = path.join('/Users/macdonk/Documents/GitHub/Karol', '.karol', 'yt-cookies.txt');
    try { fs.mkdirSync(path.dirname(cookiesPath), { recursive: true }); } catch {}
    const proc = spawn('/opt/homebrew/bin/yt-dlp', [
      '--ffmpeg-location', '/opt/homebrew/bin',
      '--cookies-from-browser', 'chrome',
      '--cookies', cookiesPath,
      '-s', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    ], { timeout: 60_000 });
    proc.on('close', (code) => {
      console.log('[karol] YouTube cookie refresh done (exit', code, ') →', cookiesPath);
    });
    proc.on('error', (e) => console.error('[karol] Cookie refresh error:', e.message));
  }
  setTimeout(refreshYtCookies, 15_000);
  setInterval(refreshYtCookies, 2 * 60 * 60 * 1000);

  // ── Allow all device permissions (speaker/camera/screen capture) ──
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    // Local karaoke app — grant hardware + display-capture for phone mirror
    callback(true);
  });
  try {
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
      if (permission === 'media' || permission === 'display-capture'
        || permission === 'mediaKeySystem' || permission === 'fullscreen') {
        return true;
      }
      return true;
    });
  } catch (_) {}
  // Electron 28+: route getDisplayMedia / desktop capture explicitly
  try {
    if (typeof session.defaultSession.setDisplayMediaRequestHandler === 'function') {
      session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
        try {
          const sources = await desktopCapturer.getSources({
            types: ['window'],
            thumbnailSize: { width: 0, height: 0 },
          });
          const hit = (sources || []).find((s) => /Karol Phone Mirror/i.test(s.name || ''))
            || (sources || []).find((s) => /scrcpy/i.test(s.name || ''))
            || (sources || [])[0];
          if (hit) callback({ video: hit, audio: false });
          else callback({});
        } catch (e) {
          console.warn('[karol] setDisplayMediaRequestHandler failed:', e && e.message);
          callback({});
        }
      }, { useSystemPicker: false });
    }
  } catch (e) {
    console.warn('[karol] display media handler unavailable:', e && e.message);
  }

  // YouTube Error 153 ("Video player configuration error") — Electron iframes
  // often omit/block Referer. Force a normal browser Referer/Origin on YT requests.
  try {
    session.defaultSession.webRequest.onBeforeSendHeaders(
      {
        urls: [
          'https://www.youtube.com/*',
          'https://www.youtube-nocookie.com/*',
          'https://*.youtube.com/*',
          'https://*.youtube-nocookie.com/*',
          'https://*.googlevideo.com/*',
          'https://*.ytimg.com/*',
        ],
      },
      (details, callback) => {
        const headers = details.requestHeaders || {};
        headers.Referer = 'https://www.youtube.com/';
        headers.Origin = 'https://www.youtube.com';
        callback({ requestHeaders: headers });
      },
    );
    console.log('[karol] YouTube Referer/Origin headers patched (Error 153 mitigation)');
  } catch (e) {
    console.warn('[karol] YouTube header patch failed:', e && e.message);
  }

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
      // Gap/B-roll teardown must never advance the show
      if (isGapInterstitialActive()) {
        console.log('[karol] Ignoring ended during Gap interstitial');
        skipRequested = true;
      } else if (Date.now() < ignoreEndedUntilMs) {
        console.log('[karol] Ignoring ended during post-play grace (' + (ignoreEndedUntilMs - Date.now()) + 'ms left)');
        skipRequested = true;
      } else if (skipRequested) {
        console.log('[karol] Ignoring ended (skip guard armed)');
      } else {
        const reportId = resolveVid(s.videoId || '');
        const expectId = resolveVid(
          (queueIndex >= 0 && queueIndex < queue.length ? queue[queueIndex].videoId : '')
          || playback.videoId
          || ''
        );
        const idMatch = !!(reportId && expectId && (
          reportId === expectId
          || reportId.replace(/-karaoke$/, '') === expectId.replace(/-karaoke$/, '')
        ));
        // Stale ended from a torn-down <video> often arrives under the *new*
        // id (or mismatched id) right after a skip/play-now — that looked like
        // a random mid-song jump to the next DJ track.
        if (!idMatch) {
          console.warn('[karol] Ignoring ended for mismatched id', reportId, '≠', expectId);
          skipRequested = true;
        } else {
          const ct = Number(s.currentTime || playback.currentTime || 0);
          const dur = Number(s.duration || playback.duration || 0);
          const knownCt = Number(playback.currentTime || 0);
          // Reject ended whose clock is far ahead of what we've actually heard
          // for this play (classic teardown: old near-end times + new videoId).
          if (knownCt >= 1 && ct > knownCt + 8) {
            console.warn('[karol] Ignoring ended with stale clock', ct.toFixed(2), 'vs known', knownCt.toFixed(2));
            skipRequested = true;
          } else {
            // Only trust ended near the real end of the file. Spurious mid-song
            // ended events were advancing/restarting the DJ deck.
            // Require a real duration — dur=0/NaN mid-stream must never advance.
            const nearEnd = dur >= 8 && isFinite(dur) && ct >= Math.min(dur - 1.25, dur * 0.9);
            if (!featureTrackEverProgressed || !nearEnd) {
              console.warn('[karol] Ignoring non-terminal ended at', ct.toFixed(2), '/', dur, '(progressed=', featureTrackEverProgressed, ')');
              skipRequested = true;
            } else {
              advanceShow({ direction: 1, fromEnded: true });
            }
          }
        }
      }
    }
    if (s.state === 'error') {
      updateMysqlRequestStatus(queue[queueIndex], 'error', 'player reported error');
      const failedId = String(s.videoId || playback.videoId || '');
      console.warn('[karol] Player error on', failedId, s.error || '', 'progressed=', featureTrackEverProgressed);
      // Mid-song glitches must NOT call sendPlay (that restarts from 0).
      // Only advance when the track never got going.
      if (!featureTrackEverProgressed) {
        skipRequested = true;
        const epochAtError = playEpoch;
        setTimeout(() => {
          if (epochAtError !== playEpoch) return;
          const cur = queueIndex >= 0 && queueIndex < queue.length ? queue[queueIndex] : null;
          if (!cur) return;
          const curId = String(cur.videoId || '');
          const same = curId === failedId
            || curId.replace(/-karaoke$/, '') === failedId.replace(/-karaoke$/, '');
          if (!same) return;
          if (betweenSongsTimer || betweenSongsHeld || betweenSongsPendingItem || betweenSongsHandoffPending || isGapInterstitialActive()) return;
          if (featureTrackEverProgressed) return;
          console.warn('[karol] Initial load failed — advancing once');
          advanceShow({ direction: 1, fromEnded: false });
        }, 1200);
      }
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
      const reportId = String(s.videoId || '');
      const expectId = current ? String(current.videoId || '') : '';
      if (reportId && expectId && (reportId === expectId
        || reportId.replace(/-karaoke$/, '') === expectId.replace(/-karaoke$/, ''))) {
        const ct = Number(s.currentTime || 0);
        // Hold skip guard until ~2.5s into the new track so teardown `ended`
        // from the previous media cannot cascade into another advance.
        if (ct >= 2.5) {
          featureTrackEverProgressed = true;
          skipRequested = false;
        } else if (ct >= 1) {
          featureTrackEverProgressed = true;
        }
      }
    }
    // Progress ticks also count (playing reports sometimes omit currentTime)
    if (typeof s.currentTime === 'number' && s.currentTime >= 1) {
      const current = queue[queueIndex];
      const reportId = String(s.videoId || '');
      const expectId = current ? String(current.videoId || '') : '';
      if (current && reportId && expectId && (reportId === expectId
        || reportId.replace(/-karaoke$/, '') === expectId.replace(/-karaoke$/, ''))) {
        featureTrackEverProgressed = true;
        if ((s.state === 'playing' || playback.state === 'playing') && s.currentTime >= 2.5) {
          skipRequested = false;
        }
      }
    }
    notifyCtrl('player-status', s);
  });

  ipcMain.handle('library-list', (_e, opts) => {
    if (!library) {
      // Last-resort: serve the on-disk cache even if library.js failed to load
      try {
        const cachePath = '/tmp/karol-library-cache.json';
        if (fs.existsSync(cachePath)) {
          const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
          if (cache && cache.ok && cache.count > 0) {
            return {
              ok: true,
              count: cache.count,
              videos: cache.videos || [],
              archiveMtime: cache.archiveMtime || 0,
              fallback: true,
            };
          }
        }
      } catch (e) {
        return { ok: false, error: 'library unavailable: ' + e.message };
      }
      return { ok: false, error: 'library module failed to load' };
    }
    try {
      return library.list(opts || {});
    } catch (e) {
      console.error('[karol] library.list failed:', e.message);
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('library-metadata', (_e, vid) => library ? library.getMetadata(vid) : null);
  ipcMain.handle('library-tags', () => library ? library.getTags() : {});
  ipcMain.handle('library-random-music', () => {
    const videoId = pickRandomMusicBrollId();
    const title = videoId ? (resolveTitleLocal(videoId) || '') : '';
    return { ok: true, videoId, title };
  });
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
    let result;
    if (source !== undefined && typeof library.reclassify === 'function') {
      result = library.reclassify(videoId, { tag, source });
    } else {
      library.setTag(videoId, tag);
      result = { ok: true };
    }
    invalidateMusicBrollPool();
    return result;
  });

  ipcMain.handle('library-delete', (_e, { videoId, siblings } = {}) => {
    if (!library || typeof library.deleteVideo !== 'function') {
      return { ok: false, error: 'library unavailable' };
    }
    const result = library.deleteVideo(videoId, { siblings: siblings !== false });
    // Pull deleted ids out of the live show queue
    try {
      const base = String(videoId || '').replace(/(-karaoke)+$/g, '');
      const drop = new Set([String(videoId || ''), base, base + '-karaoke']);
      let removed = 0;
      let removedPending = null;
      for (let i = queue.length - 1; i >= 0; i--) {
        const qid = String((queue[i] && queue[i].videoId) || '');
        const qBase = qid.replace(/(-karaoke)+$/g, '');
        if (drop.has(qid) || drop.has(qBase) || qBase === base) {
          if (!removedPending) removedPending = queue[i];
          queue.splice(i, 1);
          removed++;
          if (queueIndex >= i) queueIndex = Math.max(-1, queueIndex - 1);
        }
      }
      if (removed) {
        if (queueIndex >= queue.length) queueIndex = queue.length - 1;
        saveState();
        if (isGapInterstitialActive()) syncGapPendingAfterQueueEdit(removedPending);
        notifyShowUpdate();
      }
      result.removedFromQueue = removed;
    } catch (e) {
      result.queueError = e && e.message;
    }
    try { invalidateMusicBrollPool(); } catch (_) {}
    return result;
  });

  ipcMain.handle('library-set-rating', (_e, { videoId, rating }) => {
    if (!library || typeof library.setRating !== 'function') {
      return { ok: false, error: 'library unavailable' };
    }
    return library.setRating(videoId, rating);
  });
  ipcMain.handle('library-get-rating', (_e, videoId) => {
    if (!library || typeof library.getRating !== 'function') {
      return { ok: false, error: 'library unavailable' };
    }
    return library.getRating(videoId);
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
    invalidateMusicBrollPool();
    setTimeout(() => { try { rebuildMusicBrollPool(true); } catch (_) {} }, 500);
    return { ok: true };
  });

  ipcMain.handle('queue-get', () => {
    healDjMirrorFlags();
    // Load tags once — never N× disk hits for lyric provenance on a 600-track queue.
    let tags = {};
    try { tags = (library && library.getTags && library.getTags()) || {}; } catch (_) {}
    const total = queue.length;
    const enrichLo = total > 50 && queueIndex >= 0 ? Math.max(0, queueIndex - 12) : 0;
    const enrichHi = total > 50 && queueIndex >= 0 ? Math.min(total, queueIndex + 28) : total;

    const taggedQueue = queue.map(function(item, i) {
      var vid = item.videoId;
      var lookupId = String(vid || '').replace(/-karaoke$/, '');
      var karaoke = tags[lookupId]?.tag === 'karaoke' || tags[lookupId + '-karaoke']?.tag === 'karaoke';
      // Custom chrome is for karaoke-maker rows only — never for DJ mirrors or
      // Music Video twins that merely have a karaoke-maker sibling.
      var isCustom = false;
      if (!item.fromJukebox) {
        if (/-karaoke$/.test(String(vid || ''))) {
          isCustom = (tags[vid] && tags[vid].source === 'karaoke-maker')
            || (tags[lookupId + '-karaoke'] && tags[lookupId + '-karaoke'].source === 'karaoke-maker');
        } else if (tags[lookupId] && tags[lookupId].source === 'karaoke-maker' && tags[lookupId].tag === 'karaoke') {
          isCustom = true;
        }
      }
      var ratingRaw = (tags[lookupId + '-karaoke'] && tags[lookupId + '-karaoke'].rating)
        || (tags[lookupId] && tags[lookupId].rating)
        || (tags[vid] && tags[vid].rating);
      var ratingNum = Number(ratingRaw);
      var rating = (Number.isFinite(ratingNum) && ratingNum > 0)
        ? Math.max(1, Math.min(5, Math.round(ratingNum)))
        : null;
      var lyricSource = '';
      var lyricLabel = '';
      var hasLyrics = false;
      // Only enrich the visible window — lyric provenance is expensive on USB.
      if (i >= enrichLo && i < enrichHi) {
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
        } catch (e) { /* ignore */ }
      }
      return Object.assign({}, item, {
        karaoke: !!karaoke,
        isCustom: !!isCustom,
        rating: rating,
        hasLyrics: hasLyrics,
        lyricSource: lyricSource,
        lyricLabel: lyricLabel,
      });
    });
    return {
      ok: true,
      queue: taggedQueue,
      currentIndex: queueIndex,
      shuffleEnabled: !!queueShuffle,
      jukebox: jukeboxSummary(),
      ...showModePayload(),
    };
  });

  ipcMain.handle('queue-add', (_e, { videoId, title, requester }) => {
    // Singer queue interrupt — DJ deck stays armed; takeover at next Gap
    return enqueueKaraokeItem({ videoId, title, requester });
  });

  /** Batch-append music videos (or other dumps). Large lists stay in the real queue
   *  as slim rows; UI/player only render a window so memory stays stable. */
  ipcMain.handle('queue-add-many', (_e, { items, requester, playIfIdle, shuffle, asJukebox } = {}) => {
    const list = Array.isArray(items) ? items.slice() : [];
    // Explicit jukebox / DJ arm — never dump hundreds into the singer queue
    if (asJukebox === true) {
      return startJukebox(list, { shuffle: shuffle !== false, play: playIfIdle !== false, requester });
    }

    if (shuffle && list.length > 1) shuffleInPlace(list);
    stopJukebox();
    const who = normalizeQueueSinger(requester);
    const existing = new Set(queue.map((q) => String(q.videoId || '')));
    let added = 0;
    let skipped = 0;
    const wasIdle = queueIndex < 0 || queue.length === 0;
    let firstAdded = null;
    const startLen = queue.length;
    // Resolve playability with a fast path cache — don't thrash USB for every id
    for (const raw of list) {
      if (!raw) continue;
      const vid = resolveVid(raw.videoId || raw.id || '');
      if (!vid) { skipped++; continue; }
      if (existing.has(vid)) { skipped++; continue; }
      try {
        const p = library && library.getVideoPath ? library.getVideoPath(vid) : null;
        if (!p || !fs.existsSync(p) || fs.statSync(p).size < 50_000) { skipped++; continue; }
      } catch (_) { skipped++; continue; }
      const cleanTitle = (raw.title && String(raw.title).trim()) || bestTitleFor(vid, '');
      const item = { videoId: vid, title: cleanTitle, singer: who, requester: who };
      queue.push(item);
      existing.add(vid);
      if (!firstAdded) firstAdded = item;
      added++;
    }
    if (shuffle) {
      queueShuffle = true;
      shufflePlayedIds.clear();
      saveSettings();
    }
    if (added > 0) {
      if (wasIdle && playIfIdle !== false && firstAdded) {
        if (shuffle && added > 1) {
          const pick = startLen + Math.floor(Math.random() * added);
          queueIndex = pick;
          firstAdded = queue[pick];
        } else {
          queueIndex = startLen;
        }
        if (firstAdded && firstAdded.videoId) shufflePlayedIds.add(String(firstAdded.videoId));
        sendPlay(firstAdded.videoId, firstAdded.title, firstAdded.singer);
      }
      saveState();
      notifyCtrl('queue-update', {
        queue,
        currentIndex: queueIndex,
        shuffleEnabled: !!queueShuffle,
        jukebox: jukeboxSummary(),
      });
      notifyPlayerQueue();
    }
    console.log('[karol] queue-add-many: added', added, 'skipped', skipped, 'shuffle', !!shuffle, 'queue now', queue.length);
    return {
      ok: true,
      added,
      skipped,
      queueLength: queue.length,
      currentIndex: queueIndex,
      shuffleEnabled: !!queueShuffle,
      jukebox: jukeboxSummary(),
    };
  });

  ipcMain.handle('jukebox-start', (_e, { items, shuffle, requester } = {}) => {
    return startJukebox(items || [], {
      shuffle: shuffle !== false,
      play: true,
      requester,
    });
  });

  ipcMain.handle('jukebox-stop', () => {
    stopJukebox();
    notifyShowUpdate();
    return { ok: true, jukebox: null, ...showModePayload() };
  });

  ipcMain.handle('birthday-playlist-get', () => {
    const saved = loadBirthdayPlaylistFile();
    return {
      ok: true,
      playlist: saved,
      armed: isBirthdayJukebox(),
      jukebox: jukeboxSummary(),
    };
  });

  ipcMain.handle('birthday-playlist-start', (_e, { shuffle, requester } = {}) => {
    return startBirthdayPlaylist({
      shuffle: shuffle !== false,
      play: true,
      requester,
    });
  });

  ipcMain.handle('birthday-playlist-stop', () => {
    if (!isBirthdayJukebox()) {
      return { ok: true, jukebox: jukeboxSummary(), ...showModePayload() };
    }
    stopJukebox();
    notifyShowUpdate();
    return { ok: true, jukebox: null, ...showModePayload() };
  });

  ipcMain.handle('queue-shuffle-set', (_e, { enabled, reshuffleUpcoming } = {}) => {
    return setQueueShuffle(!!enabled, { reshuffleUpcoming: reshuffleUpcoming !== false });
  });

  ipcMain.handle('queue-shuffle-get', () => ({ ok: true, shuffleEnabled: !!queueShuffle }));

  // Phone DJ API stubs that previously no-oped
  ipcMain.handle('queue-shuffle-upcoming', () => setQueueShuffle(true, { reshuffleUpcoming: true }));

  ipcMain.handle('queue-play-now', (_e, { videoId, title, requester, preferMusic } = {}) => {
    const vid = resolveVid(videoId, { preferMusic: !!preferMusic });
    const cleanTitle = bestTitleFor(vid, title);
    const who = normalizeQueueSinger(requester);
    const existingIdx = queue.findIndex(item => item.videoId === vid);
    let fromJukebox = false;
    if (existingIdx >= 0) {
      fromJukebox = !!queue[existingIdx].fromJukebox;
      queue.splice(existingIdx, 1);
    }
    if (!fromJukebox && jukeboxActive()) {
      const cur = jukebox.items[jukebox.index];
      if (cur && String(cur.videoId) === String(vid)) fromJukebox = true;
    }
    // Playing a Music Video from the Music tab should stay on the DJ/MV path.
    if (preferMusic) fromJukebox = true;
    queue.push({
      videoId: vid,
      title: cleanTitle,
      singer: who,
      requester: who,
      fromJukebox: fromJukebox || undefined,
    });
    skipRequested = true;
    queueIndex = queue.length - 1;
    healDjMirrorFlags();
    saveState();
    sendPlay(vid, cleanTitle, who, { force: true, karaoke: preferMusic ? false : undefined });
    notifyShowUpdate();
    return { ok: true, ...showModePayload() };
  });

  ipcMain.handle('queue-remove', (_e, index) => removeFromShowQueue(index));

  ipcMain.handle('queue-clear', () => {
    for (const item of queue) updateMysqlRequestStatus(item, 'ended', 'queue cleared');
    stopJukebox();
    queue = []; queueIndex = -1;
    shufflePlayedIds.clear();
    clearMediaWait();
    saveSettings();
    saveState();
    enterHomeInterstitial({ force: true });
    return { ok: true, ...showModePayload() };
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

  ipcMain.handle('queue-skip-to', (_e, idx) => skipToShowQueue(idx));

  ipcMain.handle('status-get', () => ({
    ok: true, djActive: true, queueLength: queue.length,
    currentTitle: queue[queueIndex]?.title || '',
    currentTime: playback.currentTime, duration: playback.duration, state: playback.state,
    ...getInterstitialState(),
    ...showModePayload(),
    jukebox: jukeboxSummary(),
  }));
  ipcMain.handle('now-playing', () => {
    if (queueIndex >= 0 && queueIndex < queue.length) {
      const item = queue[queueIndex];
      return { title: displayTitle(item), videoId: item.videoId, requester: item.singer, currentTime: playback.currentTime, duration: playback.duration, state: playback.state === 'playing' ? 1 : 2 };
    }
    return { title: '', state: -2 };
  });

  ipcMain.on('transport-play', () => { doTransportPlay(); notifyInterstitialState(); });
  ipcMain.on('transport-pause', () => { doTransportPause(); notifyInterstitialState(); });
  ipcMain.on('transport-skip', () => advanceQueue(1));
  ipcMain.on('transport-prev', () => advanceQueue(-1));
  ipcMain.on('transport-seek', (_e, t) => notifyPlayer({ type: 'seek', time: t }));
  ipcMain.handle('transport-toggle-gap-hold', () => toggleBetweenSongsHold());
  ipcMain.handle('transport-gap-state', () => getInterstitialState());
  ipcMain.handle('gap-restart-broll', () => gapRestartBroll());
  ipcMain.handle('gap-delete-spin', () => gapDeleteSpin());
  ipcMain.handle('gap-remove-upnext', () => gapRemoveUpNext());
  ipcMain.handle('gap-reclassify-spin', (_e, { bucket } = {}) => gapReclassifySpin(bucket));
  ipcMain.handle('gap-cycle-broll', () => cycleGapBroll());
  ipcMain.handle('gap-prev-broll', () => prevGapBroll());
  ipcMain.on('gap-broll-report', (_e, payload) => {
    if (!payload || typeof payload !== 'object') return;
    // Only crowd player should drive Now Spinning — ignore monitor mirrors
    if (payload.role === 'monitor') return;
    if (!isGapInterstitialActive() && !pauseInterstitialLive) return;
    const id = payload.videoId ? String(payload.videoId) : null;
    const title = payload.title != null ? String(payload.title) : '';
    if (setCurrentGapBroll(id, title)) notifyInterstitialState();
  });
  ipcMain.on('transport-volume', (_e, l) => {
    const level = Math.max(0, Math.min(1, Number(l)));
    volumeLevel = Number.isFinite(level) ? level : DEFAULT_VOLUME;
    saveSettings();
    notifyPlayer({ type: 'volume', level: volumeLevel });
  });
  ipcMain.on('transport-vocal-mix', (_e, l) => {
    const level = Math.max(0, Math.min(1, Number(l)));
    vocalMixLevel = Number.isFinite(level) ? level : 0;
    saveSettings();
    notifyPlayer({ type: 'vocal-mix', level: vocalMixLevel });
  });
  ipcMain.on('transport-music-eq', (_e, eq) => {
    musicEq = normalizeEq(eq);
    saveSettings();
    console.log('[karol] music EQ →', musicEq);
    notifyPlayer({ type: 'music-eq', low: musicEq.low, mid: musicEq.mid, high: musicEq.high });
  });
  ipcMain.on('transport-vocal-eq', (_e, eq) => {
    vocalEq = normalizeEq(eq);
    saveSettings();
    console.log('[karol] vocal EQ →', vocalEq);
    notifyPlayer({ type: 'vocal-eq', low: vocalEq.low, mid: vocalEq.mid, high: vocalEq.high });
  });
  ipcMain.on('meter-levels', (_e, levels) => {
    if (!levels || typeof levels !== 'object') return;
    notifyCtrl('meter-levels', levels);
  });
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
      var secondaryLines = lyricsData && lyricsData.secondaryLines ? lyricsData.secondaryLines : null;
      var tertiaryLines = lyricsData && lyricsData.tertiaryLines ? lyricsData.tertiaryLines : null;
      var title = resolveTitleLocal(videoId) || '';
      notifyPlayer({
        type: 'toggle-full-lyrics',
        active: true,
        lines: lines,
        secondaryLines: secondaryLines,
        tertiaryLines: tertiaryLines,
        title: title || 'Full Lyrics',
      });
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
    const lanUrl = 'http://' + lanIp + ':' + port + '/dj-controller/';
    const url = getPhoneControllerUrl();
    let qrDataUrl = '';
    try {
      const { execFileSync } = require('child_process');
      const out = path.join('/tmp', 'karol-phone-connect-qr.png');
      execFileSync('/opt/homebrew/bin/qrencode', ['-s', '8', '-m', '2', '-o', out, url], { timeout: 5000 });
      qrDataUrl = 'data:image/png;base64,' + fs.readFileSync(out).toString('base64');
    } catch (e) {
      console.warn('[karol] QR generate failed:', e.message);
    }
    return { ok: true, url, lanUrl, lanIp, port, qrDataUrl };
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
  ipcMain.handle('settings-get', () => ({
    ok: true,
    betweenSongsMs: getBetweenSongsMs(),
    gapContent: getGapContent(),
    phoneMirrorGapEnabled: PHONE_MIRROR_GAP_ENABLED,
    ...getGapMix(),
    volumeLevel: Math.max(0, Math.min(1, Number(volumeLevel) || DEFAULT_VOLUME)),
    vocalMixLevel: Math.max(0, Math.min(1, Number(vocalMixLevel) || 0)),
    musicEq: normalizeEq(musicEq),
    vocalEq: normalizeEq(vocalEq),
    ...getInterstitialState(),
    ...showModePayload(),
    jukebox: jukeboxSummary(),
    phoneMirror: phoneMirrorStatusQuiet(),
  }));
  ipcMain.handle('settings-set', (_e, patch) => {
    if (patch && typeof patch.betweenSongsMs === 'number' && isFinite(patch.betweenSongsMs)) {
      betweenSongsMs = Math.max(3000, Math.min(120000, Math.round(patch.betweenSongsMs)));
      console.log('[karol] Interstitial duration set to', getBetweenSongsMs() + 'ms');
    }
    let mixChanged = false;
    if (patch && typeof patch.gapBrollLevel === 'number' && isFinite(patch.gapBrollLevel)) {
      const next = clamp01(patch.gapBrollLevel, gapBrollLevel);
      if (next !== gapBrollLevel) { gapBrollLevel = next; mixChanged = true; }
    }
    if (patch && typeof patch.gapPhoneLevel === 'number' && isFinite(patch.gapPhoneLevel)) {
      const next = clamp01(patch.gapPhoneLevel, gapPhoneLevel);
      if (next !== gapPhoneLevel) { gapPhoneLevel = next; mixChanged = true; }
    }
    if (mixChanged) {
      const mix = getGapMix();
      console.log('[karol] Gap mix levels', mix);
      sendToPlayers('player-event', {
        type: 'gap-mix',
        gapBrollLevel: mix.gapBrollLevel,
        gapPhoneLevel: mix.gapPhoneLevel,
      });
      // Direct/overlay scrcpy audio bypasses Electron — duck via Android media volume
      // (loopback still uses player <audio>.volume from gap-mix above).
      if (PHONE_MIRROR_GAP_ENABLED && phoneMirror && typeof phoneMirror.schedulePhoneAudioLevel === 'function') {
        try {
          const r = phoneMirror.schedulePhoneAudioLevel(mix.gapPhoneLevel, {
            playWin,
            playBounds: playerBoundsForMirror(),
            allowRestart: true,
          });
          console.log('[karol] Phone audio level →', mix.gapPhoneLevel,
            r && r.scheduled ? '(scheduled)' : '',
            phoneMirror.isRunning && phoneMirror.isRunning() ? 'scrcpy-up' : 'scrcpy-down');
        } catch (e) {
          console.warn('[karol] phone audio level failed:', e && e.message);
        }
      }
    }
    if (patch && (patch.gapContent === 'phone-mirror' || patch.gapContent === 'music-broll' || patch.gapContent === 'both')) {
      const prev = getGapContent();
      if (!PHONE_MIRROR_GAP_ENABLED && (patch.gapContent === 'phone-mirror' || patch.gapContent === 'both')) {
        console.log('[karol] Ignoring gapContent', patch.gapContent, '(phone mirror parked)');
      }
      gapContent = normalizeGapContent(patch.gapContent);
      console.log('[karol] Gap content set to', getGapContent());
      // Live-switch during an active Gap / pause interstitial
      const gapLive = !!(betweenSongsTimer || betweenSongsHeld || betweenSongsPendingItem || playback.state === 'paused');
      if (prev !== getGapContent() && gapLive) {
        const mix = getGapMix();
        if (gapNeedsPhone(getGapContent())) {
          const mir = ensurePhoneMirrorForGap(true);
          if (mir.ok) {
            const nextContent = getGapContent();
            sendToPlayers('player-event', {
              type: 'gap-content-switch',
              gapContent: nextContent,
              brollVideoId: gapNeedsBroll(nextContent) ? pickRandomMusicBrollId() : null,
              mirrorAudioMode: (mir.routing && mir.routing.mode) || 'direct',
              mirrorHouseDevice: (mir.routing && mir.routing.house) || null,
              mirrorTapDevice: (mir.routing && mir.routing.tap) || null,
              gapBrollLevel: mix.gapBrollLevel,
              gapPhoneLevel: mix.gapPhoneLevel,
            });
          } else {
            gapContent = 'music-broll';
            notifyCtrl('phone-mirror-status', {
              ...(mir.status || {}),
              error: mir.error || 'Phone mirror failed',
            });
            sendToPlayers('player-event', {
              type: 'gap-content-switch',
              gapContent: 'music-broll',
              brollVideoId: pickRandomMusicBrollId(),
              gapBrollLevel: mix.gapBrollLevel,
              gapPhoneLevel: mix.gapPhoneLevel,
            });
          }
        } else {
          ensurePhoneMirrorForGap(false);
          sendToPlayers('player-event', {
            type: 'gap-content-switch',
            gapContent: 'music-broll',
            brollVideoId: pickRandomMusicBrollId(),
            gapBrollLevel: mix.gapBrollLevel,
            gapPhoneLevel: mix.gapPhoneLevel,
          });
        }
      }
    }
    if (patch && typeof patch.volumeLevel === 'number' && isFinite(patch.volumeLevel)) {
      volumeLevel = Math.max(0, Math.min(1, patch.volumeLevel));
      notifyPlayer({ type: 'volume', level: volumeLevel });
      console.log(
        '[karol] Player volume set to',
        volumeLevel,
        '(UI ~' + (20 * Math.log10(Math.max(0.0001, volumeLevel))).toFixed(1) + ' dB linear;',
        'PA ~' + (20 * Math.log10(Math.max(0.0001, volumeLevel * volumeLevel * 0.28))).toFixed(1) + ' dBFS after taper/trim)'
      );
    }
    if (patch && typeof patch.vocalMixLevel === 'number' && isFinite(patch.vocalMixLevel)) {
      vocalMixLevel = Math.max(0, Math.min(1, patch.vocalMixLevel));
      notifyPlayer({ type: 'vocal-mix', level: vocalMixLevel });
    }
    if (patch && patch.musicEq) {
      musicEq = normalizeEq(patch.musicEq);
      notifyPlayer({ type: 'music-eq', ...musicEq });
    }
    if (patch && patch.vocalEq) {
      vocalEq = normalizeEq(patch.vocalEq);
      notifyPlayer({ type: 'vocal-eq', ...vocalEq });
    }
    saveSettings();
    return {
      ok: true,
      betweenSongsMs: getBetweenSongsMs(),
      gapContent: getGapContent(),
      phoneMirrorGapEnabled: PHONE_MIRROR_GAP_ENABLED,
      ...getGapMix(),
      volumeLevel: Math.max(0, Math.min(1, Number(volumeLevel) || DEFAULT_VOLUME)),
      vocalMixLevel: Math.max(0, Math.min(1, Number(vocalMixLevel) || 0)),
      musicEq: normalizeEq(musicEq),
      vocalEq: normalizeEq(vocalEq),
      phoneMirror: phoneMirrorStatusQuiet(),
    };
  });
  ipcMain.handle('phone-mirror-status', () => phoneMirrorStatusQuiet());
  ipcMain.handle('phone-mirror-stop', () => {
    if (phoneMirror) phoneMirror.stopPhoneMirror();
    return { ok: true, status: phoneMirrorStatusQuiet() };
  });
  ipcMain.handle('phone-mirror-screen-access', () => {
    let status = 'unknown';
    try {
      if (systemPreferences && typeof systemPreferences.getMediaAccessStatus === 'function') {
        status = systemPreferences.getMediaAccessStatus('screen');
      }
    } catch (_) {}
    return { ok: true, status };
  });
  ipcMain.handle('phone-mirror-find-source', async () => {
    let screenStatus = 'unknown';
    try {
      if (systemPreferences && typeof systemPreferences.getMediaAccessStatus === 'function') {
        screenStatus = systemPreferences.getMediaAccessStatus('screen');
      }
    } catch (_) {}
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      });
      const list = sources || [];
      const hit = list.find((s) => /Karol Phone Mirror/i.test(s.name || ''))
        || list.find((s) => /scrcpy/i.test(s.name || ''));
      return {
        ok: !!hit,
        screenStatus,
        sourceCount: list.length,
        sourceId: hit ? hit.id : null,
        sourceName: hit ? hit.name : null,
        names: list.slice(0, 15).map((s) => s.name),
      };
    } catch (e) {
      return {
        ok: false,
        screenStatus,
        error: (e && e.message) || String(e),
        sourceCount: 0,
      };
    }
  });
  ipcMain.on('phone-mirror-slot-bounds', (_e, rel) => {
    if (!phoneMirror || !phoneMirror.isRunning()) return;
    if (!rel || !(Number(rel.width) > 80)) return;
    if (!playWin || playWin.isDestroyed()) return;
    const cb = playWin.getContentBounds();
    let slot = rel;
    if (rel.iw && rel.ih && rel.left != null) {
      const sx = cb.width / Math.max(1, rel.iw);
      const sy = cb.height / Math.max(1, rel.ih);
      slot = {
        x: cb.x + rel.left * sx,
        y: cb.y + rel.top * sy,
        width: rel.width * sx,
        height: rel.height * sy,
      };
    }
    // Keep overlay above player after layout reports
    if (phoneMirrorOverlayActive) {
      try { playWin.setAlwaysOnTop(false); } catch (_) {}
      ensureMenuBarCover('slot-bounds');
    }
    const dual = getGapContent() === 'both';
    phoneMirror.repositionPhoneMirror(clampPortraitPhoneSlot(slot, dual ? { align: 'right' } : null), {
      playWin,
      playBounds: playerBoundsForMirror(),
    });
  });

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
      notifyCtrl('library-scan-progress', {
        status: 'scanning',
        message: 'Rescan requested — scanning maxone…',
        driveMounted: isExternalDriveMounted(),
        drivePath: getExternalDrivePath(),
        catalogCount: 0,
        diskMediaCount: 0,
      });
      // Delete the disk cache so init() rebuilds from scratch
      try { require('fs').unlinkSync('/tmp/karol-library-cache.json'); } catch(e) {}
      const status = await library.init(true);
      const health = await runHealthCheck();
      notifyCtrl('health-report', health);
      return { ok: true, scan: status || (library.getScanStatus && library.getScanStatus()) };
    }
    return { ok: false, error: 'Library module unavailable' };
  });

  ipcMain.handle('library-scan-status', async () => {
    // Non-blocking: never walk the whole drive on the UI status poll
    if (library && typeof library.refreshDiskStats === 'function') {
      const scan = library.refreshDiskStats({ recount: false });
      if (typeof library.scheduleDiskCount === 'function') library.scheduleDiskCount(false);
      return { ok: true, scan };
    }
    if (library && typeof library.getScanStatus === 'function') {
      return { ok: true, scan: library.getScanStatus() };
    }
    return { ok: false, error: 'unavailable' };
  });

  // ── Lyric reprocessing ──
  ipcMain.handle('reprocess-lyrics', (_e, { videoId, forceWhisper, lyricsText, whisperModel, mode, lyricsTrack, language, romanize }) => {
    console.log('[karol] IPC: reprocess-lyrics received for:', videoId, 'mode:', mode || 'rebuild', 'forceWhisper:', forceWhisper, 'model:', whisperModel, 'lang:', language || '-', 'romanize:', romanize || '-', 'lyrics:', lyricsText ? lyricsText.length + ' chars' : 'none');
    const karaokeId = videoId.replace(/-karaoke$/, '');
    const ytUrl = 'https://www.youtube.com/watch?v=' + karaokeId;
    const isRetime = mode === 'retime';
    const isStems = mode === 'stems';

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

    const effectiveModel = isStems ? null : (whisperModel || 'large-v3');
    console.log('[karol] Reprocessing lyrics for:', karaokeId, isStems ? '(stems-only)' : (isRetime ? '(retime-keep-text)' : ''), effectiveModel ? '(model: ' + effectiveModel + ')' : '', lyricsText ? '(custom lyrics: ' + lyricsText.length + ' chars)' : '');
    const jobLabel = isStems
      ? ('Rebuild stems: ' + karaokeId)
      : (isRetime
        ? ('Re-time: ' + karaokeId + ' [' + effectiveModel + ']')
        : ('Re-Lyric: ' + karaokeId + ' [' + effectiveModel + ']' + (lyricsText ? ' [+lyrics]' : '') + (romanize ? ' [romanize:' + romanize + ']' : '')));
    processingJobs[checkId] = { status: 'queued', progress: 0, label: jobLabel, karaokify: true, isReLyric: true, mode: mode || 'rebuild', queuePosition: karaokeQueue.length + 1 };
    broadcastJobProgress();

    karaokeQueue.push({
      videoId: karaokeId,
      url: ytUrl,
      requester: '',
      isReLyric: true,
      forceWhisper: !!forceWhisper,
      lyricsText: (isRetime || isStems) ? null : (lyricsText || null),
      whisperModel: effectiveModel,
      lyricsTrack: lyricsTrack || 'sung',
      mode: mode || 'rebuild',
      retimeKeepText: isRetime,
      rebuildStemsOnly: isStems,
      language: language || null,
      romanize: romanize || null,
    });
    const queuePos = karaokeQueue.length;
    const startedImmediately = !karaokeRunning;
    processNextKaraokeJob();
    const startedMsg = isStems ? 'Stem rebuild started (keeping lyrics)'
      : (isRetime ? 'Re-time started (keeping lyric text)' : 'Re-lyric started');
    const queuedMsg = isStems ? 'Stem rebuild' : (isRetime ? 'Re-time' : 'Reprocessing');
    return {
      ok: true,
      message: startedImmediately
        ? startedMsg
        : (queuedMsg + ' queued (position: ' + queuePos + ')'),
    };
  });

  ipcMain.handle('lyrics-translate-preview', async (_e, { videoId }) => {
    try {
      const translateLyrics = require('./translate-lyrics');
      return await translateLyrics.previewEnglishTranslation(videoId);
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('lyrics-add-english', async (_e, { videoId, lyricsText, replaceEnglish, sourceLang }) => {
    try {
      const translateLyrics = require('./translate-lyrics');
      const result = await translateLyrics.addEnglishTrack(videoId, {
        lyricsText: lyricsText || null,
        replaceEnglish: !!replaceEnglish,
        sourceLang: sourceLang || null,
      });
      if (result && result.ok) {
        // Nudge player if this track is current
        try {
          notifyPlayer({ type: 'lyrics-reload' });
        } catch (_) {}
      }
      return result;
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('lyrics-romanize', async (_e, { videoId, lang }) => {
    try {
      if (!downloads || typeof downloads.romanizeOnly !== 'function') {
        return { ok: false, error: 'Romanize unavailable' };
      }
      const result = await downloads.romanizeOnly(videoId, lang || 'th');
      if (result && result.ok) {
        try { notifyPlayer({ type: 'lyrics-reload', videoId }); } catch (_) {}
      }
      return result;
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
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
      if (library && typeof library.getLyricOffset === 'function') {
        return library.getLyricOffset(videoId);
      }
    } catch (e) { console.error('[karol] get-lyric-offset error:', e.message); }
    return { ok: true, offset: 0 };
  });

  ipcMain.handle('save-lyric-offset', (_e, { videoId, offset }) => {
    try {
      if (!library || typeof library.setLyricOffset !== 'function') {
        return { ok: false, error: 'library unavailable' };
      }
      // Persist offset only — do not bake into LRC (player applies offset at runtime;
      // mutating timestamps + keeping lyricOffset would double-shift on reload).
      const result = library.setLyricOffset(videoId, offset);
      if (!result || !result.ok) return result || { ok: false, error: 'save failed' };

      const savedOffset = result.offset || 0;
      const savedId = result.videoId || videoId;
      console.log('[karol] Saved lyric offset', savedOffset, 'for', savedId);

      // Notify player to apply the durable offset immediately
      if (playWin && !playWin.isDestroyed()) {
        playWin.webContents.send('player-event', {
          type: 'lyric-offset-updated',
          videoId: savedId,
          offset: savedOffset,
        });
      }
      return result;
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
        env: { ...process.env, PATH: '/opt/homebrew/bin:' + (process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'), PYTHONUNBUFFERED: '1' },
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

  // ── YouTube library search (controller YouTube tab) ──
  function pickYoutubeThumbnail(info, id) {
    const thumbs = Array.isArray(info && info.thumbnails) ? info.thumbnails : [];
    let best = '';
    let bestArea = -1;
    for (const t of thumbs) {
      if (!t || !t.url) continue;
      const w = Number(t.width) || 0;
      const h = Number(t.height) || 0;
      const area = w * h;
      if (area >= bestArea) {
        bestArea = area;
        best = String(t.url);
      }
    }
    if (best) return best;
    if (info && info.thumbnail) return String(info.thumbnail);
    if (id) return 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';
    return '';
  }

  ipcMain.handle('youtube-search', async (_e, { query, limit } = {}) => {
    const q = String(query || '').trim();
    if (!q) return { ok: false, error: 'Empty query', results: [] };
    const n = Math.max(1, Math.min(50, Number(limit) || 50));
    try {
      const childCp = require('child_process');
      // Escape quotes inside the ytsearch query string
      const safe = q.replace(/"/g, '');
      const searchQuery = 'ytsearch' + n + ':"' + safe + '"';
      console.log('[karol] youtube-search:', searchQuery);

      const cookiesPath = path.join('/Users/macdonk/Documents/GitHub/Karol', '.karol', 'yt-cookies.txt');
      const authArgs = (fs.existsSync(cookiesPath) && fs.statSync(cookiesPath).size > 100)
        ? ['--cookies', cookiesPath]
        : ['--cookies-from-browser', 'chrome'];
      const proc = childCp.spawn('/opt/homebrew/bin/yt-dlp', [
        '--ffmpeg-location', '/opt/homebrew/bin',
        '--flat-playlist', '--dump-json', '--no-playlist',
        ...authArgs,
        searchQuery,
      ], {
        env: { ...process.env, PATH: '/opt/homebrew/bin:' + (process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      return await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { proc.kill('SIGTERM'); } catch (_) {}
          resolve({ ok: false, error: 'YouTube search timed out', results: [] });
        }, 90000);
        proc.on('close', (code) => {
          clearTimeout(timer);
          const results = [];
          const seen = new Set();
          for (const raw of stdout.split('\n')) {
            const line = raw.trim();
            if (!line) continue;
            try {
              const info = JSON.parse(line);
              const id = String(info.id || '').trim();
              if (!/^[A-Za-z0-9_-]{11}$/.test(id) || seen.has(id)) continue;
              seen.add(id);
              results.push({
                id,
                title: info.title || id,
                channel: info.channel || info.uploader || '',
                duration: (info.duration != null && Number.isFinite(Number(info.duration)))
                  ? Number(info.duration) : null,
                url: 'https://www.youtube.com/watch?v=' + id,
                thumbnail: pickYoutubeThumbnail(info, id),
              });
            } catch (_) {}
          }
          if (!results.length && code !== 0) {
            const errTail = (stderr || '').trim().split('\n').slice(-3).join(' ').slice(0, 240);
            resolve({ ok: false, error: errTail || ('yt-dlp exited ' + code), results: [] });
            return;
          }
          console.log('[karol] youtube-search found:', results.length);
          resolve({ ok: true, results });
        });
        proc.on('error', (e) => {
          clearTimeout(timer);
          resolve({ ok: false, error: e.message, results: [] });
        });
      });
    } catch (e) {
      return { ok: false, error: e.message, results: [] };
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
        '--ffmpeg-location', '/opt/homebrew/bin',
        '--flat-playlist', '--dump-json', '--no-playlist',
        ...authArgs,
        searchQuery,
      ], {
        env: { ...process.env, PATH: '/opt/homebrew/bin:' + (process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin') },
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
  ctrlWin = createControllerWindow();

  // Dedicated HDMI karaoke display — open player after ready settles
  // (sync create here can stall whenReady / IPC on macOS multi-display).
  if (getExternalDisplay()) {
    setTimeout(() => {
      try { createPlayer(); }
      catch (e) { console.error('[karol] startup createPlayer failed:', e && e.message); }
    }, 400);
  }

  console.log('[karol] Ready.');
});

app.on('window-all-closed', () => {
  if (apiServerProcess && !apiServerProcess.killed) {
    apiServerProcess.kill();
  }
  app.exit(0);
});

app.on('before-quit', () => {
  isQuitting = true;
  restoreKaraokeMenuBarHide();
  destroyMenuBarCover();
  try { if (phoneMirror) phoneMirror.stopPhoneMirror(); } catch (_) {}
  if (driveWatchTimer) { clearInterval(driveWatchTimer); driveWatchTimer = null; }
  stopUsbKeepAwake();
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
    ctrlWin = createControllerWindow();
  }
  if (!playWin || playWin.isDestroyed()) {
    createPlayer();
  }
});