const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

let djControllerWindow = null;
let libraryDashboardWindow = null;
let apiServerProcess = null;

const API_PORT = 3131;
const API_SERVER_ENTRY = path.join(__dirname, '..', 'api-server', 'index.js');

// ── API Server ──────────────────────────────────────────────

function startApiServer() {
  console.log('[karol] Starting API server...');
  apiServerProcess = spawn('node', [API_SERVER_ENTRY], {
    cwd: path.join(__dirname, '..'),
    stdio: 'pipe',
    env: { ...process.env, NODE_ENV: 'production' },
  });

  apiServerProcess.stdout.on('data', (data) => {
    process.stdout.write('[api] ' + data);
  });

  apiServerProcess.stderr.on('data', (data) => {
    process.stderr.write('[api:err] ' + data);
  });

  apiServerProcess.on('exit', (code) => {
    console.log('[karol] API server exited with code ' + code);
    apiServerProcess = null;
  });

  apiServerProcess.on('error', (err) => {
    console.error('[karol] Failed to start API server:', err.message);
    apiServerProcess = null;
  });
}

function stopApiServer() {
  if (apiServerProcess) {
    console.log('[karol] Stopping API server...');
    apiServerProcess.kill('SIGTERM');
    apiServerProcess = null;
  }
}

// ── Poll API server readiness ───────────────────────────────

function waitForApiServer(maxAttempts = 30) {
  return new Promise((resolve) => {
    let attempts = 0;
    const check = () => {
      attempts++;
      http.get(`http://localhost:${API_PORT}/api/health.json`, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.ok) {
              console.log('[karol] API server ready after ' + attempts + ' attempts');
              resolve(true);
              return;
            }
          } catch {}
          retry();
        });
      }).on('error', () => {
        retry();
      });
    };

    const retry = () => {
      if (attempts >= maxAttempts) {
        console.warn('[karol] API server did not become ready after ' + maxAttempts + ' attempts');
        resolve(false);
        return;
      }
      setTimeout(check, 1000);
    };

    check();
  });
}

// ── Windows ──────────────────────────────────────────────────

function createDjControllerWindow() {
  djControllerWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Karol DJ Controller',
    backgroundColor: '#07070d',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  djControllerWindow.loadURL(`http://localhost:${API_PORT}/dj-controller/`);

  djControllerWindow.once('ready-to-show', () => {
    djControllerWindow.show();
  });

  djControllerWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  djControllerWindow.on('closed', () => {
    djControllerWindow = null;
  });
}

function createLibraryDashboardWindow() {
  libraryDashboardWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Karol Request Generator',
    backgroundColor: '#07070d',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  libraryDashboardWindow.loadURL(`http://localhost:${API_PORT}/library/`);

  libraryDashboardWindow.once('ready-to-show', () => {
    libraryDashboardWindow.show();
  });

  libraryDashboardWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  libraryDashboardWindow.on('closed', () => {
    libraryDashboardWindow = null;
  });
}

// ── App Lifecycle ────────────────────────────────────────────

app.whenReady().then(async () => {
  app.setAppUserModelId('com.karol.app');

  // Start the API server
  startApiServer();

  // Wait for it to be ready
  const ready = await waitForApiServer();
  if (!ready) {
    console.error('[karol] API server failed to start — launching windows anyway');
  }

  // Open the DJ controller window
  createDjControllerWindow();

  // Also open the library dashboard / request generator
  createLibraryDashboardWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createDjControllerWindow();
      createLibraryDashboardWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  // Try graceful shutdown of API server
  try {
    http.get(`http://localhost:${API_PORT}/api/shutdown`, () => {}).on('error', () => {});
  } catch {}
  stopApiServer();
});

app.on('quit', () => {
  stopApiServer();
});
