// Karol Electron — Stable Architecture
// Absolute paths for modules, preload, and HTML to avoid resolution issues.

const { app, BrowserWindow, ipcMain, screen, protocol, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, fork } = require('child_process');
let apiServerProcess = null;

// Minimal flags — let Chromium handle GPU/audio natively
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

process.on('uncaughtException', (e) => { console.error('[karol] FATAL:', e.message); });
process.on('unhandledRejection', (r) => { console.error('[karol] REJECTION:', r?.message || r); });

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

// ── Processing job tracker ──
// { videoId: { status: 'downloading'|'processing'|'done'|'error', progress: 0-100, label: string, errorMessage: string } }
const processingJobs = {};

// ── Serial karaoke pipeline queue ──
// Ensures only one karaoke job runs at a time to prevent GPU contention
const karaokeQueue = [];
let karaokeRunning = false;

function processNextKaraokeJob() {
  if (karaokeRunning) return;
  if (karaokeQueue.length === 0) {
    console.log('[karol] Karaoke queue empty');
    return;
  }

  // Find the first non-error job
  const entry = karaokeQueue.shift();
  const { videoId, url, requester, isReLyric, forceWhisper, karaokeMatch } = entry;

  karaokeRunning = true;
  console.log('[karol] Karaoke queue: starting', videoId, '(remaining:', karaokeQueue.length, ')');

  processingJobs[videoId] = { status: 'downloading', progress: 0, label: requester ? requester + ': ' + (url || videoId) : (url || videoId), url: url, karaokify: true, requester: requester };
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

  downloads.start(videoId, true, url, { isReLyric: entry.isReLyric, forceWhisper: entry.forceWhisper, karaokeMatch: karaokeMatch })
    .then((result) => {
      if (result.karaokeDone) {
        processingJobs[videoId] = { status: 'done', progress: 100, label: videoId, url: url, karaokify: true, requester: requester };
        console.log('[karol] Pipeline complete:', videoId);
        if (library && typeof library.init === 'function') {
          library.init().then(() => {
            notifyCtrl('library-scan-progress', { videoId, status: 'done' });
          });
        }
      } else if (result.karaokeFailed) {
        processingJobs[videoId] = { status: 'error', progress: 50, label: videoId, errorMessage: 'Karaoke pipeline failed', url: url, karaokify: true, requester: requester };
      } else {
        processingJobs[videoId] = { status: 'done', progress: 100, label: videoId, url: url, karaokify: true, requester: requester };
      }
      broadcastJobProgress();
      karaokeRunning = false;
      processNextKaraokeJob();
    })
    .catch((err) => {
      processingJobs[videoId] = { status: 'error', progress: 0, label: videoId, errorMessage: err.message, url: url, karaokify: true, requester: requester };
      broadcastJobProgress();
      console.error('[karol] Pipeline error for', videoId, ':', err.message);
      karaokeRunning = false;
      processNextKaraokeJob();
    });

  // Simulate progress since downloads.js doesn't emit events we can hook into
  pollDownloadProgress(videoId);
}

function enqueueKaraokeJob(videoId, url, requester) {
  // Already in queue or processing
  if (karaokeQueue.some(e => e.videoId === videoId)) {
    console.log('[karol] Already queued:', videoId);
    return false;
  }
  if (processingJobs[videoId] && processingJobs[videoId].status !== 'error') {
    console.log('[karol] Already processing:', videoId);
    return false;
  }
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
  const STAGE_MAP = {
    'starting': { status: 'downloading', stage: 'Starting pipeline...' },
    'downloading': { status: 'downloading', stage: 'Downloading video' },
    'demucs': { status: 'processing', stage: 'Separating vocals' },
    'whisper': { status: 'processing', stage: 'Transcribing lyrics' },
    'rendering': { status: 'processing', stage: 'Rendering video' },
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

function startDirectDownload(videoId, url) {
  if (processingJobs[videoId] && processingJobs[videoId].status !== 'error') {
    return; // Already processing
  }

  processingJobs[videoId] = { status: 'downloading', progress: 0, label: url || videoId, karaokify: false, url: url };
  broadcastJobProgress();
  console.log('[karol] Starting direct download for:', videoId);

  if (!downloads) {
    processingJobs[videoId] = { status: 'error', progress: 0, label: videoId, errorMessage: 'Download module not available', karaokify: false, url: url };
    broadcastJobProgress();
    return;
  }

  downloads.start(videoId, false, url)
    .then((result) => {
      if (result.ok) {
        // Register in tags.json with a default tag so the library picks it up
        if (library && typeof library.setTag === 'function') {
          library.setTag(videoId, 'music');
        }
        processingJobs[videoId] = { status: 'done', progress: 100, label: videoId, karaokify: false, url: url };
        console.log('[karol] Direct download complete:', videoId);
        if (library && typeof library.init === 'function') {
          library.init().then(() => {
            notifyCtrl('library-scan-progress', { videoId, status: 'done' });
          });
        }
      } else {
        processingJobs[videoId] = { status: 'error', progress: 50, label: videoId, errorMessage: 'Download failed', karaokify: false, url: url };
      }
      broadcastJobProgress();
    })
    .catch((err) => {
      processingJobs[videoId] = { status: 'error', progress: 0, label: videoId, errorMessage: err.message, karaokify: false, url: url };
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
  
  // Exit any quick-start scan workers from previous session
  try {
    const { execSync } = require('child_process');
    execSync('pkill -f "library-scan-worker" 2>/dev/null || true', { timeout: 2000 });
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
let pendingPlay = null;

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

function handlePlayerCrash() {
  const prevPlayWin = playWin;
  playWin = null;

  // Try to destroy the crashed window
  try { if (prevPlayWin && !prevPlayWin.isDestroyed()) prevPlayWin.destroy(); } catch(e) {}

  // Recreate player and resume where we left off
  setTimeout(() => {
    console.log('[karol] Recreating player window after crash...');
    createPlayer();
    // Resume playback from current queue position
    if (queue.length > 0 && queueIndex >= 0 && queueIndex < queue.length) {
      if (playWin && !playWin.isDestroyed()) {
        pendingPlay = null;
        playWin.webContents.once('did-finish-load', () => {
          if (queue.length > 0 && queueIndex >= 0 && queueIndex < queue.length) {
            playWin.webContents.send('player-event', {
              type: 'play', videoId: queue[queueIndex].videoId,
              isYouTube: false, title: queue[queueIndex].title,
              requester: queue[queueIndex].singer || queue[queueIndex].requester,
              queue: queue, currentIndex: queueIndex,
            });
          }
        });
        if (!playWin.webContents.isLoading()) {
          // Already loaded, send immediately
          playWin.webContents.send('player-event', {
            type: 'play', videoId: queue[queueIndex].videoId,
            isYouTube: false, title: queue[queueIndex].title,
            requester: queue[queueIndex].singer || queue[queueIndex].requester,
            queue: queue, currentIndex: queueIndex,
          });
        }
      }
    }
    notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
  }, 2000);
}

function createPlayer() {
  if (playWin && !playWin.isDestroyed()) { playWin.show(); playWin.focus(); return; }

  console.log('[karol] Creating player window...');
  playWin = new BrowserWindow({
    width: 1280, height: 720,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
    title: 'Karol Player', backgroundColor: '#000000', show: true,
  });

  playWin.webContents.on('console-message', (e, l, m) => console.log('[player]', m));
  playWin.webContents.on('did-finish-load', () => {
    console.log('[karol] Player loaded');
    const displays = screen.getAllDisplays();
    const ext = displays.find(d => d.id !== screen.getPrimaryDisplay().id);
    if (ext) { playWin.setBounds(ext.bounds); playWin.setFullScreen(true); }

    // Send initial queue state so marquee renders immediately
    notifyPlayerQueue();

    if (pendingPlay) {
      const p = pendingPlay; pendingPlay = null;
      playWin.webContents.send('player-event', {
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
  playWin.on('closed', () => { playWin = null; });
  playWin.loadFile(PLAY_HTML);
}

function sendPlay(videoId, title, requester) {
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
  // Send play + full queue snapshot so player can render marquee immediately
  playWin.webContents.send('player-event', {
    type: 'play', videoId: resolved, isYouTube: false, title: title || videoId, requester: requester || '',
    queue: queue, currentIndex: queueIndex,
  });
}

// Send queue state to player window whenever it changes
function notifyPlayerQueue() {
  if (playWin && !playWin.isDestroyed()) {
    playWin.webContents.send('player-event', {
      type: 'queue-update', queue: queue, currentIndex: queueIndex,
    });
  }
}

function notifyCtrl(ch, data) {
  if (ctrlWin && !ctrlWin.isDestroyed()) ctrlWin.webContents.send(ch, data);
}
function notifyPlayer(msg) {
  if (playWin && !playWin.isDestroyed()) playWin.webContents.send('player-event', msg);
}

// ── App ──
app.whenReady().then(async () => {
  console.log('[karol] Karol Electron');
  console.log('[karol] Displays:', screen.getAllDisplays().length);

  // Load library cache
  if (library && typeof library.init === 'function') {
    await library.init();
    console.log('[karol] Library ready');
  }

  // Restore persistent state
  loadState();

  // Run health check
  const health = await runHealthCheck();
  console.log('[karol] Health check:', JSON.stringify(health));
  notifyCtrl('health-report', health);

  // ── Periodic YouTube cookie refresh (every 2 hours) ──
  setInterval(() => {
    const cookiesPath = path.join('/Users/macdonk/Documents/GitHub/Karol', '.karol', 'yt-cookies.txt');
    spawn('/opt/homebrew/bin/yt-dlp', ['--cookies-from-browser', 'chrome', '--cookies', cookiesPath, '-s', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'], {
      timeout: 30_000,
    }).on('close', (code) => {
      console.log('[karol] Cookie refresh done (exit', code, ')');
    });
  }, 2 * 60 * 60 * 1000);

  // ── Start API server for public domain access (with auto-respawn) ──
function startApiServer() {
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
  apiServerProcess.stdout.on('data', (d) => console.log('[api-server]', d.toString().trim()));
  apiServerProcess.stderr.on('data', (d) => console.error('[api-server]', d.toString().trim()));
  
  // IPC message handlers (shared with respawn)
  const handleApiMessage = (msg) => {
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
    if (msg && msg.type === 'web-karaoke-request') {
      const { videoId, url, requester } = msg;
      console.log('[karol] Web karaoke request:', videoId, requester);
      enqueueKaraokeJob(videoId, url, requester);
    }
    if (msg && msg.type === 'web-queue-request') {
      const { videoId, title, requester } = msg;
      const vid = resolveVid(videoId);
      const alreadyInQueue = queue.find(item => item.videoId === vid);
      if (!alreadyInQueue) {
        queue.push({ videoId: vid, title: title || vid, singer: requester || '', requester: requester || '' });
        saveState();
        if (queueIndex < 0) { queueIndex = queue.length - 1; sendPlay(vid, title || vid, requester); }
        notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
        notifyPlayerQueue();
        console.log('[karol] Web request queued:', videoId, requester);
      }
    }
    if (msg && msg.type === 'web-play-now') {
      const { videoId, title, requester } = msg;
      const vid = resolveVid(videoId);
      const existingIdx = queue.findIndex(item => item.videoId === vid);
      if (existingIdx >= 0) queue.splice(existingIdx, 1);
      queue.push({ videoId: vid, title: title || vid, singer: requester || '', requester: requester || '' });
      saveState();
      skipRequested = true;
      queueIndex = queue.length - 1;
      sendPlay(vid, title || vid, requester);
      notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
      notifyPlayerQueue();
    }
    if (msg && msg.type === 'library-rescan') {
      console.log('[karol] Web-triggered library rescan:', msg.videoId);
      if (library && typeof library.init === 'function') {
        library.init().then(() => {
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

  // Register media protocol
  protocol.registerFileProtocol('karol-file', (request, callback) => {
    const filePath = decodeURIComponent(request.url.replace('karol-file://', ''));
    callback({ path: filePath });
  });

  // ── IPC ──

  ipcMain.on('player-state-report', (_e, s) => {
    if (!s) return;
    if (s.videoId) playback.videoId = s.videoId;
    if (s.currentTime !== undefined) playback.currentTime = s.currentTime;
    if (s.duration) playback.duration = s.duration;
    if (s.state) playback.state = s.state;

    if (s.state === 'ended') {
      if (skipRequested) {
        skipRequested = false;
      } else {
        if (queue.length > 0) {
          queueIndex = (queueIndex + 1) % queue.length;
          // Guard: if queue was modified and index is now invalid, clamp
          if (queueIndex < 0 || queueIndex >= queue.length) queueIndex = 0;
          const item = queue[queueIndex];
          if (item) {
            saveState();
            sendPlay(item.videoId, item.title, item.singer || item.requester);
            notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
            notifyPlayerQueue();
          }
        }
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
  ipcMain.handle('library-set-tag', (_e, { videoId, tag }) => { if (library) library.setTag(videoId, tag); return { ok: true }; });
  ipcMain.handle('library-status', (_e, vid) => library ? library.getStatus(vid) : { exists: false });
  ipcMain.handle('library-lyrics', (_e, vid) => library ? library.getLyrics(vid) : null);
  ipcMain.handle('library-file-path', (_e, vid) => library ? library.getFilePath(vid) : null);
  ipcMain.handle('library-scan', () => { if (library) library.init(); return { ok: true }; });

  ipcMain.handle('queue-get', () => {
    var taggedQueue = queue.map(function(item) {
      var karaoke = false;
      var isCustom = false;
      var vid = item.videoId;
      try {
        var lookupId = vid.replace(/-karaoke$/, '');
        var tags = library.getTags();
        karaoke = tags[lookupId]?.tag === 'karaoke' || tags[lookupId + '-karaoke']?.tag === 'karaoke';
        isCustom = tags[lookupId]?.source === 'karaoke-maker' || tags[lookupId + '-karaoke']?.source === 'karaoke-maker';
      } catch(e) { /* ignore */ }
      return Object.assign({}, item, { karaoke: karaoke, isCustom: isCustom });
    });
    return { ok: true, queue: taggedQueue, currentIndex: queueIndex };
  });

  ipcMain.handle('queue-add', (_e, { videoId, title, requester }) => {
    const vid = resolveVid(videoId);
    queue.push({ videoId: vid, title: title || vid, singer: requester || '', requester: requester || '' });
    if (queueIndex < 0) { queueIndex = queue.length - 1; sendPlay(vid, title || vid, requester); }
    saveState();
    notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
    notifyPlayerQueue();
    return { ok: true };
  });

  ipcMain.handle('queue-play-now', (_e, { videoId, title, requester }) => {
    const vid = resolveVid(videoId);
    const existingIdx = queue.findIndex(item => item.videoId === vid);
    if (existingIdx >= 0) {
      queue.splice(existingIdx, 1);
    }
    queue.push({ videoId: vid, title: title || vid, singer: requester || '', requester: requester || '' });
    skipRequested = true;
    queueIndex = queue.length - 1;
    saveState();
    sendPlay(vid, title || vid, requester);
    notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
    notifyPlayerQueue();
    return { ok: true };
  });

  ipcMain.handle('queue-remove', (_e, index) => {
    if (index < 0 || index >= queue.length) return { ok: false };
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
      return { title: item.title, videoId: item.videoId, requester: item.singer, currentTime: playback.currentTime, duration: playback.duration, state: playback.state === 'playing' ? 1 : 2 };
    }
    return { title: '', state: -2 };
  });

  ipcMain.on('transport-play', () => notifyPlayer({ type: 'play' }));
  ipcMain.on('transport-pause', () => notifyPlayer({ type: 'pause' }));
  ipcMain.on('transport-skip', () => advanceQueue(1));
  ipcMain.on('transport-prev', () => advanceQueue(-1));
  ipcMain.on('transport-seek', (_e, t) => notifyPlayer({ type: 'seek', time: t }));
  ipcMain.on('transport-volume', (_e, l) => notifyPlayer({ type: 'volume', level: l }));
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
      var title = '';
      if (library) {
        try {
          var meta = library.getMetadata(videoId);
          title = meta ? (meta.title || videoId) : (videoId || '');
        } catch(e) { title = videoId || ''; }
      }
      notifyPlayer({ type: 'toggle-full-lyrics', active: true, lines: lines, title: title || videoId || '' });
    } catch(e) {
      console.error('[karol] toggle-full-lyrics error:', e.message);
      notifyPlayer({ type: 'toggle-full-lyrics', active: true, lines: [], title: 'Error loading lyrics' });
    }
  });

  function advanceQueue(direction) {
    if (queue.length === 0) return;
    skipRequested = true;
    queueIndex = (queueIndex + direction + queue.length) % queue.length;
    const item = queue[queueIndex];
    saveState();
    sendPlay(item.videoId, item.title, item.singer || item.requester);
    notifyCtrl('queue-update', { queue, currentIndex: queueIndex });
    notifyPlayerQueue();
  }

  ipcMain.on('launch-player', () => createPlayer());
  ipcMain.on('close-player', () => { if (playWin && !playWin.isDestroyed()) playWin.close(); });

  ipcMain.handle('app-version', () => '3.1.0');
  ipcMain.handle('display-info', () => screen.getAllDisplays().map(d => ({ id: d.id, label: d.label, bounds: d.bounds, isPrimary: d.id === screen.getPrimaryDisplay().id })));

  // ── Download / Request handlers ──
  ipcMain.handle('download-start', (_e, { videoId, karaoke, url }) => {
    if (processingJobs[videoId] && processingJobs[videoId].status !== 'error') {
      return { ok: false, error: 'Already processing' };
    }
    const ytUrl = url || 'https://www.youtube.com/watch?v=' + videoId;
    if (karaoke === false) {
      startDirectDownload(videoId, ytUrl);
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

  ipcMain.handle('request-add', (_e, { videoId, requester, title, url, karaoke }) => {
    if (!videoId) return { ok: false, error: 'No video ID' };
    const ytUrl = url || 'https://www.youtube.com/watch?v=' + videoId;
    // If karaoke is explicitly false, do a direct download (no demucs/lyrics/re-encode)
    // Default to karaoke pipeline for backward compatibility
    if (karaoke === false) {
      startDirectDownload(videoId, ytUrl);
      return { ok: true, message: 'Direct download started — video will appear in library when ready' };
    }
    startKaraokePipeline(videoId, ytUrl, requester || '');
    return { ok: true, message: 'Processing started — song will appear in library when ready' };
  });

  ipcMain.handle('request-list', () => {
    return [];
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
    delete processingJobs[videoId];
    if (karaokify === false) {
      startDirectDownload(videoId, url);
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
      await library.init();
    }
    return { ok: true };
  });

  // ── Lyric reprocessing ──
  ipcMain.handle('reprocess-lyrics', (_e, { videoId, forceWhisper }) => {
    const karaokeId = videoId.replace(/-karaoke$/, '');
    const ytUrl = 'https://www.youtube.com/watch?v=' + karaokeId;

    // Already queued or processing
    const checkId = karaokeId; // Use stripped ID for queue/processing checks
    if (processingJobs[checkId] && processingJobs[checkId].status !== 'error') {
      return { ok: false, error: 'Already in progress' };
    }

    console.log('[karol] Reprocessing lyrics for:', karaokeId);
    processingJobs[checkId] = { status: 'queued', progress: 0, label: 'Re-Lyric: ' + karaokeId + (forceWhisper ? ' (Whisper)' : ''), karaokify: true, isReLyric: true, queuePosition: karaokeQueue.length + 1 };
    broadcastJobProgress();

    // Queue reprocess as a special job (downloads.js handles --reprocess flag)
    karaokeQueue.push({
      videoId: karaokeId,
      url: ytUrl,
      requester: '',
      isReLyric: true,
      forceWhisper: !!forceWhisper
    });
    processNextKaraokeJob();
    return { ok: true, message: 'Reprocessing queued (position: ' + (karaokeQueue.length) + ')' };
  });

  // ── Lyric offset persistence ──
  const TAGS_JSON = '/Volumes/maxone/Deskreen/tags.json';

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

      const proc = childCp.spawn('/opt/homebrew/bin/yt-dlp', [
        '--flat-playlist', '--dump-json', '--no-playlist',
        '--cookies-from-browser', 'chrome',
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
      if (processingJobs[karaokeId] && processingJobs[karaokeId].status !== 'error') {
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
  ctrlWin.on('closed', () => { ctrlWin = null; });
  ctrlWin.loadFile(CTRL_HTML);

  console.log('[karol] Ready.');
});

app.on('window-all-closed', () => {});
app.on('activate', () => {
  if (!ctrlWin || ctrlWin.isDestroyed()) {
    const primary = screen.getPrimaryDisplay();
    ctrlWin = new BrowserWindow({
      width: 1200, height: 900, x: primary.workArea.x, y: primary.workArea.y,
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
      title: 'Karol DJ Controller', backgroundColor: '#0a0a14',
    });
    ctrlWin.on('closed', () => { ctrlWin = null; });
    ctrlWin.loadFile(CTRL_HTML);
  }
});

app.on('before-quit', () => {
  if (apiServerProcess && !apiServerProcess.killed) {
    apiServerProcess.kill();
    console.log('[karol] API server stopped');
  }
});