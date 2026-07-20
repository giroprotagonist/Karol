const { app, BrowserWindow, ipcMain, screen, protocol } = require('electron');
const path = require('path');

process.on('uncaughtException', (e) => { console.error('FATAL:', e.stack); });
process.on('unhandledRejection', (e) => { console.error('UNHANDLED:', e?.stack || e); });
process.on('exit', (c) => console.log('EXIT code:', c));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Load modules
let library, playerState;
try { library = require('./library'); console.log('[test] library loaded'); } catch(e) { console.error('[test] library FAIL:', e.message); }
try { playerState = require('./player-state'); console.log('[test] playerState loaded'); } catch(e) { console.error('[test] playerState FAIL:', e.message); }

app.whenReady().then(async () => {
  console.log('[test] Ready. Displays:', screen.getAllDisplays().length);

  if (library) { await library.init(); console.log('[test] library.init done'); }

  protocol.registerFileProtocol('karol-file', (req, cb) => {
    const fp = decodeURIComponent(req.url.replace('karol-file://', ''));
    console.log('[test] Serving file:', fp.substring(0,80));
    cb({ path: fp });
  });

  // Controller window
  const primary = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    width: 1200, height: 900, x: primary.workArea.x, y: primary.workArea.y,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    title: 'Karol', backgroundColor: '#0a0a14',
  });
  win.webContents.on('console-message', (e, l, m) => console.log('[ctrl]', m));
  win.loadFile('controller.html');

  // IPC
  ipcMain.handle('library-list', async () => library ? library.list({}) : { ok: false });
  ipcMain.handle('library-file-path', async (_e, vid) => library ? library.getFilePath(vid) : null);
  ipcMain.handle('library-lyrics', async (_e, vid) => library ? library.getLyrics(vid) : null);
  ipcMain.handle('library-metadata', async (_e, vid) => library ? library.getMetadata(vid) : null);
  ipcMain.handle('library-tags', async () => library ? library.getTags() : {});
  ipcMain.handle('library-status', async (_e, vid) => library ? library.getStatus(vid) : {exists:false});
  
  // Player window + playback
  let playerWindow = null;
  
  function createPlayerWindow() {
    if (playerWindow && !playerWindow.isDestroyed()) { playerWindow.show(); return; }
    console.log('[test] Creating player window...');
    playerWindow = new BrowserWindow({
      width: 1280, height: 720,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
      backgroundColor: '#000', show: true,
    });
    playerWindow.webContents.on('console-message', (e, l, m) => console.log('[player]', m));
    playerWindow.webContents.on('crashed', () => { console.error('[test] PLAYER CRASH'); playerWindow = null; });
    playerWindow.loadFile('player.html');
  }

  ipcMain.on('launch-player', () => createPlayerWindow());
  
  ipcMain.handle('queue-play-now', async (_e, { videoId, title, requester }) => {
    console.log('[test] play-now:', videoId, title);
    createPlayerWindow();
    // Small delay then send play
    setTimeout(() => {
      if (playerWindow && !playerWindow.isDestroyed()) {
        console.log('[test] Sending play command');
        playerWindow.webContents.send('player-event', { type: 'play', videoId, isYouTube: false, title, requester });
      }
    }, 1000);
    return { ok: true };
  });

  ipcMain.on('player-state-report', (_e, s) => {
    console.log('[test] Player state:', s.state);
  });

  // Minimal queue
  ipcMain.handle('queue-get', async () => ({ ok: true, queue: [], currentIndex: -1 }));
  ipcMain.handle('status-get', async () => ({ ok: true, queueLength: 0 }));
  ipcMain.handle('now-playing', async () => ({ title: '', state: -2 }));
  ipcMain.handle('queue-add', async () => ({ ok: true }));
  ipcMain.handle('queue-remove', async () => ({ ok: true }));
  ipcMain.handle('queue-clear', async () => ({ ok: true }));
  ipcMain.on('transport-play', () => {});
  ipcMain.on('transport-pause', () => {});
  ipcMain.on('transport-skip', () => {});

  console.log('[test] IPC ready');
});

console.log('[test] Starting...');
