#!/usr/bin/env node
// Karol API server - no TypeScript, no Electron deps
const http = require('http');
const Koa = require('koa');
const cors = require('kcors');
const Router = require('koa-router');
const bodyParser = require('koa-bodyparser');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 3131;
const app = new Koa();
const router = new Router();
app.use(cors());
app.use(bodyParser());

const VLC_AUTH = 'Basic ' + Buffer.from(':karol').toString('base64');

function vlcGet(endpoint) {
  return new Promise((resolve, reject) => {
    http.get({
      hostname: '127.0.0.1', port: 8080, path: endpoint,
      headers: { Authorization: VLC_AUTH },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

function findCoverPath(filePath) {
  if (!filePath) return null;
  const dir = path.dirname(filePath);
  const candidates = ['cover.jpg', 'cover.png', 'folder.jpg', 'albumart.jpg', 'artwork.jpg'];
  for (const c of candidates) {
    const p = path.join(dir, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── VLC routes ──
router.get('/api/vlc-dj/health', async (ctx) => {
  ctx.body = { ok: true, vlcAvailable: true, hardwareAvailable: true };
});

router.get('/api/vlc-dj/now-playing', async (ctx) => {
  try {
    const d = await vlcGet('/requests/status.json');
    if (!d) { ctx.body = { title: '', artist: '', album: '', duration: 0, position: 0 }; return; }
    const meta = (d.information && d.information.category && d.information.category.meta) || {};
    let fullPath = '';
    if (d.currentplid != null) {
      const pl = await vlcGet('/requests/playlist.json');
      if (pl) {
        const items = (pl.children && pl.children[0] && pl.children[0].children) || [];
        for (const item of items) {
          if (String(item.id) === String(d.currentplid)) {
            fullPath = decodeURIComponent((item.uri || '').replace('file://', ''));
            break;
          }
        }
      }
    }
    ctx.body = {
      title: meta.filename || '', artist: meta.artist || '', album: meta.album || '',
      duration: Number(d.length || 0), position: Number(d.time || 0),
      id: d.currentplid != null ? String(d.currentplid) : undefined,
      coverUrl: fullPath ? '/api/vlc-dj/cover?path=' + encodeURIComponent(fullPath) : undefined,
    };
  } catch (e) { ctx.body = { title: '', artist: '', album: '', duration: 0, position: 0 }; }
});

router.get('/api/vlc-dj/playlist', async (ctx) => {
  try {
    const [pl, st] = await Promise.all([vlcGet('/requests/playlist.json'), vlcGet('/requests/status.json')]);
    const items = (pl && pl.children && pl.children[0] && pl.children[0].children) || [];
    const tracks = items.map((item, i) => {
      const uri = String(item.uri || '');
      const fullPath = uri.startsWith('file://') ? decodeURIComponent(uri.replace('file://', '')) : String(item.name || '');
      const cp = findCoverPath(fullPath);
      return {
        id: String(item.id || i), name: String(item.name || 'Track ' + (i+1)), uri,
        duration: typeof item.duration === 'number' ? item.duration : undefined,
        coverUrl: cp ? '/api/vlc-dj/cover?path=' + encodeURIComponent(fullPath) : undefined,
      };
    });
    const cid = Number(st && st.currentplid);
    const currentIndex = !isNaN(cid) ? tracks.findIndex(t => Number(t.id) === cid) : -1;
    ctx.body = { tracks, currentIndex };
  } catch (e) { ctx.body = { tracks: [], currentIndex: -1 }; }
});

router.get('/api/vlc-dj/cover', async (ctx) => {
  const fp = ctx.query.path;
  if (!fp) { ctx.status = 400; return; }
  const cp = findCoverPath(fp);
  if (!cp) { ctx.status = 404; return; }
  ctx.type = path.extname(cp) === '.png' ? 'image/png' : 'image/jpeg';
  ctx.body = fs.createReadStream(cp);
});

function getLibraryFolder() {
  try {
    const configPath = path.join(os.homedir(), '.deskreen', 'vlc-config.json');
    const raw = fs.readFileSync(configPath, 'utf-8');
    const cfg = JSON.parse(raw);
    if (cfg.libraryFolder && fs.existsSync(cfg.libraryFolder)) return cfg.libraryFolder;
  } catch (e) { /* fall through */ }
  return path.join(os.homedir(), 'Music');
}

function scanLibraryFolders() {
  const musicDir = getLibraryFolder();
  console.log('[vlc-dj] Scanning library folder:', musicDir);
  const tracks = [];
  let skipped = 0, errors = 0;
  try {
    function walk(dir, depth) {
      if (depth > 6) return;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) { walk(full, depth + 1); }
          else if (/\.(mp3|flac|wav|m4a|aiff|ogg)$/i.test(entry.name)) {
            const cp = findCoverPath(full);
            tracks.push({
              title: path.basename(full, path.extname(full)), path: full,
              artist: path.basename(path.dirname(path.dirname(full))) || '',
              album: path.basename(path.dirname(full)) || '', duration: 0,
              coverUrl: cp ? '/api/vlc-dj/cover?path=' + encodeURIComponent(full) : undefined,
            });
          } else { skipped++; }
        }
      } catch (e) { errors++; }
    }
    walk(musicDir, 0);
    console.log('[vlc-dj] Library scan complete:', tracks.length, 'tracks,', skipped, 'non-audio,', errors, 'errors');
  } catch (e) { console.error('[vlc-dj] Library scan failed:', e.message); }
  return tracks;
}

let _libCache = null;
let _libCacheAt = 0;
function getCachedLibrary() {
  const now = Date.now();
  if (_libCache && (now - _libCacheAt) < 60000) return _libCache;
  _libCache = scanLibraryFolders();
  _libCacheAt = now;
  return _libCache;
}

router.get('/api/vlc-dj/library', async (ctx) => {
  ctx.body = { tracks: getCachedLibrary() };
});

router.get('/api/vlc-dj/library/search', async (ctx) => {
  const q = (ctx.query.q || '').toLowerCase();
  if (!q) { ctx.body = { results: [] }; return; }
  const tracks = getCachedLibrary();
  const results = tracks.filter(t =>
    t.title.toLowerCase().includes(q) ||
    t.artist.toLowerCase().includes(q) ||
    t.album.toLowerCase().includes(q)
  );
  ctx.body = { results };
});

router.get('/api/vlc-dj/status', async (ctx) => {
  try {
    const d = await vlcGet('/requests/status.json');
    ctx.body = {
      state: (d && d.state) || 'stopped',
      volume: (d && d.volume) || 0,
      time: (d && d.time) || 0,
      length: (d && d.length) || 0,
      position: (d && d.position) || 0,
      duration: (d && d.length) || 0,
    };
  } catch (e) { ctx.body = { state: 'stopped', volume: 0, time: 0, length: 0, position: 0, duration: 0 }; }
});

// ── VLC transport routes (match React SPA paths) ──
router.post('/api/vlc-dj/transport/play', async (ctx) => {
  try {
    await vlcGet('/requests/status.json?command=pl_play');
    ctx.body = { ok: true };
  } catch (e) { ctx.body = { ok: false, error: e.message }; }
});

router.post('/api/vlc-dj/transport/pause', async (ctx) => {
  try {
    await vlcGet('/requests/status.json?command=pl_pause');
    ctx.body = { ok: true };
  } catch (e) { ctx.body = { ok: false, error: e.message }; }
});

router.post('/api/vlc-dj/transport/skip-next', async (ctx) => {
  try {
    await vlcGet('/requests/status.json?command=pl_next');
    ctx.body = { ok: true };
  } catch (e) { ctx.body = { ok: false, error: e.message }; }
});

router.post('/api/vlc-dj/transport/skip-prev', async (ctx) => {
  try {
    await vlcGet('/requests/status.json?command=pl_previous');
    ctx.body = { ok: true };
  } catch (e) { ctx.body = { ok: false, error: e.message }; }
});

router.post('/api/vlc-dj/transport/seek', async (ctx) => {
  try {
    const body = ctx.request.body || {};
    const sec = Number(body.seconds || 0);
    await vlcGet('/requests/status.json?command=seek&val=' + Math.round(sec));
    ctx.body = { ok: true };
  } catch (e) { ctx.body = { ok: false, error: e.message }; }
});

router.post('/api/vlc-dj/transport/seek-relative', async (ctx) => {
  try {
    const body = ctx.request.body || {};
    const delta = Number(body.delta || 0);
    if (delta !== 0) {
      await vlcGet('/requests/status.json?command=seek&val=' + (delta > 0 ? '+' : '') + Math.round(delta) + 's');
    }
    ctx.body = { ok: true };
  } catch (e) { ctx.body = { ok: false, error: e.message }; }
});

router.post('/api/vlc-dj/transport/volume', async (ctx) => {
  try {
    const body = ctx.request.body || {};
    // React slider sends 0-100 (percentage); VLC HTTP uses 0-256 range
    const pct = Math.max(0, Math.min(100, Number(body.level || 50)));
    const vlcVol = Math.round((pct / 100) * 256);
    await vlcGet('/requests/status.json?command=volume&val=' + vlcVol);
    ctx.body = { ok: true };
  } catch (e) { ctx.body = { ok: false, error: e.message }; }
});

// ── VLC queue routes (match React SPA paths) ──

router.post('/api/vlc-dj/queue/clear', async (ctx) => {
  try {
    await vlcGet('/requests/status.json?command=pl_empty');
    ctx.body = { ok: true };
  } catch (e) { ctx.body = { ok: false, error: e.message }; }
});

router.post('/api/vlc-dj/queue', async (ctx) => {
  try {
    const body = ctx.request.body || {};
    const fp = body.path;
    if (!fp) { ctx.status = 400; ctx.body = { ok: false, error: 'path required' }; return; }
    await vlcGet('/requests/status.json?command=in_enqueue&input=file://' + encodeURIComponent(fp));
    ctx.body = { ok: true };
  } catch (e) { ctx.body = { ok: false, error: e.message }; }
});

router.post('/api/vlc-dj/queue/:id/play', async (ctx) => {
  try {
    const id = ctx.params.id;
    if (!id) { ctx.status = 400; ctx.body = { ok: false, error: 'id required' }; return; }
    await vlcGet('/requests/status.json?command=pl_play&id=' + encodeURIComponent(id));
    ctx.body = { ok: true };
  } catch (e) { ctx.body = { ok: false, error: e.message }; }
});

router.delete('/api/vlc-dj/queue/:id', async (ctx) => {
  try {
    const id = ctx.params.id;
    if (!id) { ctx.status = 400; ctx.body = { ok: false, error: 'id required' }; return; }
    await vlcGet('/requests/status.json?command=pl_delete&id=' + encodeURIComponent(id));
    ctx.body = { ok: true };
  } catch (e) { ctx.body = { ok: false, error: e.message }; }
});

// ── Ableton routes ──
router.get('/api/ableton/health', (ctx) => { ctx.body = { ok: true, connected: false }; });
router.get('/api/ableton/state', (ctx) => { ctx.body = { ok: true, connected: false, playing: false, tempo: 120, tracks: [], masterVolume: 0.85 }; });
router.post('/api/ableton/transport/play', (ctx) => { ctx.body = { ok: true }; });
router.post('/api/ableton/transport/stop', (ctx) => { ctx.body = { ok: true }; });
router.post('/api/ableton/track/:i/volume', (ctx) => { ctx.body = { ok: true }; });
router.post('/api/ableton/track/:i/mute', (ctx) => { ctx.body = { ok: true }; });
router.post('/api/ableton/master/volume', (ctx) => { ctx.body = { ok: true }; });
router.post('/api/ableton/tempo', (ctx) => { ctx.body = { ok: true }; });
router.post('/api/ableton/mix', (ctx) => { ctx.body = { ok: true }; });

// ── Hardware routes (match React SPA paths) ──
router.get('/api/vlc-dj/hardware/mic', (ctx) => {
  ctx.body = { micVolume: 50, micMuted: false, vlcVolume: 75 };
});

router.post('/api/vlc-dj/hardware/mic', (ctx) => {
  ctx.body = { ok: true };
});

router.post('/api/vlc-dj/hardware/mic/mute', (ctx) => {
  ctx.body = { ok: true };
});

// ── Mount router first ──
app.use(router.routes());

// ── Static SPA (only for non-API paths) ──
const djDistDir = path.resolve(__dirname, '..', 'src', 'dj-controller', 'dist');
if (fs.existsSync(djDistDir)) {
  app.use(async (ctx, next) => {
    if (ctx.path.startsWith('/api/')) { await next(); return; }
    let filePath = path.join(djDistDir, ctx.path.slice(1) || 'index.html');
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        ctx.type = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : ext === '.js' ? 'application/javascript' : 'application/octet-stream';
        ctx.body = fs.createReadStream(filePath);
        return;
      }
    } catch (e) { /* fall through */ }
    ctx.type = 'text/html';
    ctx.body = fs.createReadStream(path.join(djDistDir, 'index.html'));
  });
  console.log('SPA: ' + djDistDir);
}

const server = http.createServer(app.callback());
server.listen(PORT, '0.0.0.0', () => {
  console.log('Karol API online at http://0.0.0.0:' + PORT);
  console.log('  VLC, Ableton, Hardware mixer routes ready');
});

process.on('SIGINT', () => { server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
