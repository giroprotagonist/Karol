// Minimal Electron test - isolates whether crash is in app code or Electron/macOS
const { app, BrowserWindow } = require('electron');

let win = null;
const startTime = Date.now();

function log(msg) {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`[${elapsed}s] ${msg}`);
}

app.whenReady().then(() => {
  log('app ready');

  win = new BrowserWindow({
    width: 400,
    height: 300,
    show: true,
  });

  win.loadURL('data:text/html,<h1>Hello</h1>');

  win.on('closed', () => {
    log('window closed');
    win = null;
  });

  log('window created');
});

// Heartbeat every 5 seconds
setInterval(() => {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  log(`alive at ${elapsed}s`);
}, 5000);

// Catch uncaught errors so we see them in the log
process.on('uncaughtException', (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.message}`);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  log(`UNHANDLED REJECTION: ${reason}`);
});
