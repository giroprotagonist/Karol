// Karol Electron — Main Process
// One Mac to rule them all. No servers, no ports, no mDNS, no proxies.

const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// ── Crash guard: log but NEVER exit ──
process.on('uncaughtException', (err) => {
  console.error('[karol] Uncaught exception:', err.message);
  console.error(err.stack);
  // Do NOT process.exit — keep the app alive
});
process.on('unhandledRejection', (reason) => {
  console.error('[karol] Unhandled rejection:', reason?.message || reason);
  if (reason?.stack) console.error(reason.stack);
});

// ── Module imports ──
let library, playerState, downloads, requests;

function loadModules() {
  try { library = require('./library'); } catch (e) { console.log('[karol] Library module:', e.message); }
  try { playerState = require('./player-state'); } catch (e) { console.log('[karol] Player state module:', e.message); }
  try { downloads = require('./downloads'); } catch (e) { console.log('[karol] Downloads module:', e.message); }
  try { requests = require('./requests'); } catch (e) { console.log('[karol] Requests module:', e.message); }

  // Wire callbacks so player-state can forward play events
  if (playerState) {
    playerState.setCallbacks(
      // onStateChange — forward to player window
      (event) => {
        ensurePlayerWindow();
        if (playerWindow) playerWindow.webContents.send('player-event', event);
        // Also forward queue updates to controller
        if (controllerWindow && !controllerWindow.isDestroyed()) {
          controllerWindow.webContents.send('queue-update');
          if (event.type === 'play') {
            controllerWindow.webContents.send('player-status', {
              videoId: event.videoId,
              isYouTube: event.isYouTube,
              currentTime: 0,
              duration: 0,
              state: 'playing',
            });
          }
        }
      },
      // onQueueUpdate — forward to both windows
      () => {
        if (controllerWindow && !controllerWindow.isDestroyed()) {
          controllerWindow.webContents.send('queue-update');
        }
        // Send queue update to player too
        if (playerWindow && !playerWindow.isDestroyed()) {
          const q = playerState.getQueue();
          if (q && q.ok) {
            var evt = {
              type: 'queue-update',
              queue: q.queue,
              currentIndex: q.currentIndex,
            }; console.log('[trace] player-event ' + evt.type + ' from:', new Error().stack.split('\n')[2]); playerWindow.webContents.send('player-event', evt);
          }
        }
      }
    );
  }
}

loadModules();

// ── State ──
let controllerWindow = null;
let playerWindow = null;

// ── Window creation ──

function ensurePlayerWindow() {
  if (!playerWindow || playerWindow.isDestroyed()) {
    createPlayerWindow();
  }
  if (playerWindow) {
    playerWindow.show();
    playerWindow.focus();
  }
}

function createControllerWindow() {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.workAreaSize;

  controllerWindow = new BrowserWindow({
    width: Math.min(1200, width),
    height: Math.min(900, height),
    x: primary.workArea.x,
    y: primary.workArea.y,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Karol DJ Controller',
    backgroundColor: '#0a0a14',
  });

  // Forward console logs from renderer to main process (must be before loadFile)
  controllerWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log('[controller] ' + message);
  });

  controllerWindow.loadFile('controller.html');

  controllerWindow.on('closed', () => {
    controllerWindow = null;
  });
}

function createPlayerWindow() {
  // Use external display for HDMI output
  const displays = screen.getAllDisplays();
  const external = displays.find(d => d.id !== screen.getPrimaryDisplay().id) || screen.getPrimaryDisplay();
  const b = external.bounds;

  playerWindow = new BrowserWindow({
    fullscreen: true,
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
    title: 'Karol Player',
    backgroundColor: '#000',
    frame: false,
    alwaysOnTop: external.id !== screen.getPrimaryDisplay().id,
  });

  // Forward console logs from renderer to main process (must be before loadFile)
  playerWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const levels = ['verbose','info','warning','error'];
    console.log('[player:' + (levels[level] || level) + '] ' + message);
  });

  playerWindow.loadFile('player.html');

  playerWindow.on('closed', () => {
    playerWindow = null;
  });

  console.log('[karol] Player window on display:', external.id, b);
}

// ── IPC Handlers ──

function setupIPC() {
  // ── Transport controls ──
  ipcMain.on('transport-play', () => {
    playerState?.play();
    ensurePlayerWindow();
    if (playerWindow) var evt = { type: 'play' }; console.log('[trace] player-event ' + evt.type + ' from:', new Error().stack.split('\n')[2]); playerWindow.webContents.send('player-event', evt);
  });
  ipcMain.on('transport-pause', () => {
    playerState?.pause();
    if (playerWindow) var evt = { type: 'pause' }; console.log('[trace] player-event ' + evt.type + ' from:', new Error().stack.split('\n')[2]); playerWindow.webContents.send('player-event', evt);
  });
  ipcMain.on('transport-skip', () => {
    const next = playerState?.skip();
    ensurePlayerWindow();
    if (playerWindow && next) {
      var evt = { type: 'play', videoId: next.videoId, isYouTube: next.isYouTube, title: next.title, requester: next.requester || next.singer }; console.log('[trace] player-event ' + evt.type + ' from:', new Error().stack.split('\n')[2]); playerWindow.webContents.send('player-event', evt);
    }
  });
  ipcMain.on('transport-seek', (_e, time) => {
    playerState?.seek(time);
    if (playerWindow) var evt = { type: 'seek', time }; console.log('[trace] player-event ' + evt.type + ' from:', new Error().stack.split('\n')[2]); playerWindow.webContents.send('player-event', evt);
  });
  ipcMain.on('transport-volume', (_e, level) => {
    playerState?.volume(level);
    if (playerWindow) var evt = { type: 'volume', level }; console.log('[trace] player-event ' + evt.type + ' from:', new Error().stack.split('\n')[2]); playerWindow.webContents.send('player-event', evt);
  });

  // ── Queue management ──
  ipcMain.handle('queue-add', async (_e, { videoId, title, requester, url }) => {
    return playerState?.addToQueue(videoId, url, title, requester);
  });
  ipcMain.handle('queue-play-now', async (_e, { videoId, title, requester, url }) => {
    return playerState?.playNow(videoId, url, title, requester);
  });
  ipcMain.handle('queue-remove', async (_e, index) => {
    return playerState?.removeFromQueue(index);
  });
  ipcMain.handle('queue-clear', async () => {
    return playerState?.clearQueue();
  });
  ipcMain.handle('queue-reorder', async (_e, { from, to }) => {
    return playerState?.reorderQueue(from, to);
  });
  ipcMain.handle('queue-skip-to', async (_e, index) => {
    return playerState?.skipTo(index);
  });
  ipcMain.handle('queue-get', async () => {
    return playerState?.getQueue() || { queue: [], currentIndex: -1 };
  });

  // ── Status ──
  ipcMain.handle('status-get', async () => {
    return {
      ok: true,
      queueLength: playerState?.getQueueLength() || 0,
      currentTitle: playerState?.getCurrentTitle() || '',
      playerState: playerState?.getPlayerState() || 'idle',
    };
  });
  ipcMain.handle('now-playing', async () => {
    return playerState?.getNowPlaying() || { title: '', videoId: '', currentTime: 0, duration: 0, state: -2 };
  });

  // ── Library ──
  ipcMain.handle('library-list', async (_e, opts) => {
    if (!library) return { ok: false, error: 'Library module not loaded' };
    try { return library.list(opts); } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('library-metadata', async (_e, videoId) => {
    if (!library) return null;
    try { return library.getMetadata(videoId); } catch (e) { return null; }
  });
  ipcMain.handle('library-tags', async () => {
    if (!library) return {};
    try { return library.getTags(); } catch (e) { return {}; }
  });
  ipcMain.handle('library-set-tag', async (_e, { videoId, tag }) => {
    if (!library) return false;
    try { return library.setTag(videoId, tag); } catch (e) { return false; }
  });
  ipcMain.handle('library-status', async (_e, videoId) => {
    if (!library) return { exists: false };
    try { return library.getStatus(videoId); } catch (e) { return { exists: false }; }
  });
  ipcMain.handle('library-lyrics', async (_e, videoId) => {
    if (!library) return null;
    try { return library.getLyrics(videoId); } catch (e) { return null; }
  });
  ipcMain.handle('library-file-path', async (_e, videoId) => {
    if (!library) return null;
    try { return library.getVideoPath(videoId); } catch (e) { return null; }
  });
  ipcMain.handle('library-scan', async () => {
    if (!library) return { ok: false, error: 'Library module not loaded' };
    try { return library.scanSummary(); } catch (e) { return { ok: false, error: e.message }; }
  });

  // ── Downloads ──
  ipcMain.handle('download-start', async (_e, { videoId, karaoke }) => {
    if (!downloads) return { ok: false, error: 'Downloads module not loaded' };
    try { return downloads.start(videoId, karaoke); } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('download-status', async (_e, videoId) => {
    if (!downloads) return { downloading: false };
    try { return downloads.getStatus(videoId); } catch (e) { return { downloading: false }; }
  });
  ipcMain.handle('download-cancel', async (_e, videoId) => {
    if (!downloads) return false;
    try { return downloads.cancel(videoId); } catch (e) { return false; }
  });

  // ── Song requests ──
  ipcMain.handle('request-add', async (_e, { videoId, requester, title }) => {
    if (!requests) return { ok: false, error: 'Requests module not loaded' };
    try { return requests.add(videoId, requester, title); } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('request-list', async () => {
    if (!requests) return [];
    try { return requests.list(); } catch (e) { return []; }
  });

  // ── Window management ──
  ipcMain.on('launch-player', () => {
    ensurePlayerWindow();
  });
  ipcMain.on('close-player', () => {
    if (playerWindow && !playerWindow.isDestroyed()) {
      playerWindow.close();
      playerWindow = null;
    }
  });

  // ── App info ──
  ipcMain.handle('app-version', () => '1.0.0');
  ipcMain.handle('display-info', () => {
    return screen.getAllDisplays().map(d => ({
      id: d.id,
      label: d.label,
      size: d.size,
      bounds: d.bounds,
      isPrimary: d.id === screen.getPrimaryDisplay().id,
    }));
  });
}

// ── Player window event forwarding ──
function setupPlayerForward() {
  // Player window sends playback state back to main → controller
  ipcMain.on('player-state-report', (_e, state) => {
    if (playerState) {
      playerState.updatePlaybackState(state);
    }
    if (controllerWindow) {
      controllerWindow.webContents.send('player-status', state);
    }
  });

  // Player requests next track
  ipcMain.on('player-request-next', () => {
    const next = playerState?.skip();
    ensurePlayerWindow();
    if (playerWindow && next) {
      var evt = {
        type: 'play',
        videoId: next.videoId,
        isYouTube: next.isYouTube,
        title: next.title,
        requester: next.requester,
      }; console.log('[trace] player-event ' + evt.type + ' from:', new Error().stack.split('\n')[2]); playerWindow.webContents.send('player-event', evt);
    }
  });
}

// ── App lifecycle ──

process.on('exit', function(code) { console.log('[karol] PROCESS EXIT with code: ' + code); });
app.whenReady().then(() => {
  console.log('[karol] Starting Karol Electron...');
  console.log('[karol] Displays detected:', screen.getAllDisplays().length);

  // ── Register custom protocol to serve local media files ──
  // file:// on external drives is unreliable in renderer processes (sandboxed)
  const { protocol, net } = require('electron');
  protocol.handle('karol-file', async (request) => {
    try {
      const filePath = decodeURIComponent(request.url.replace('karol-file:///', '/'));
      return await net.fetch('file://' + filePath);
    } catch (e) {
      console.error('[karol-file] Error:', request.url, e.message);
      return new Response('Not found', { status: 404 });
    }
  });

  // Initialize library (build cache if needed)
  if (library) {
    library.init().catch(e => console.error('[karol] Library init error:', e.message));
  }

  setupIPC();
  setupPlayerForward();

  createControllerWindow();
  // Player window created on demand via "Show Player Window" button

  console.log('[karol] Ready.');
});

app.on('window-all-closed', () => {
  // On macOS, stay open unless Cmd+Q
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (!controllerWindow || controllerWindow.isDestroyed()) {
    createControllerWindow();
  }
  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.show();
  }
});

app.on('before-quit', () => {
  console.log('[karol] Shutting down...');
});
