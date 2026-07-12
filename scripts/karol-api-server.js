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
const PLAYER_HOST = process.env.PLAYER_HOST || (() => {
  try { return require('fs').readFileSync('/tmp/karol-player-host.txt', 'utf8').trim(); }
  catch { return '192.168.68.60'; }
})();
const PLAYER_PORT = parseInt(process.env.PLAYER_PORT || (() => {
  try { return require('fs').readFileSync('/tmp/karol-player-port.txt', 'utf8').trim(); }
  catch { return '3131'; }
})(), 10);

// ── Port conflict: try to listen directly. If the port is occupied
// by a stale instance, we exit so launchd can restart us cleanly.
// We avoid execSync / lsof because macOS TCC sandboxing in ~/Documents
// can hang those calls indefinitely. ──


const app = new Koa();
const router = new Router();
app.use(cors());
app.use(bodyParser());

// Request logging
app.use(async (ctx, next) => {
  await next();
  const rt = ctx.response.get('X-Response-Time');
  console.log(`${new Date().toISOString()} ${ctx.ip} ${ctx.method} ${ctx.url} - ${ctx.status}`);
});

// ── Get the LAN IP of the Mac (first non-internal IPv4 on en0/wlan0/etc) ──
function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    if (/^(en|wl|eth|wlan)/i.test(name)) {
      for (const addr of nets[name]) {
        if (addr.family === 'IPv4' && !addr.internal) return addr.address;
      }
    }
  }
  return '127.0.0.1';
}

const VLC_PASSWORD = process.env.VLC_PASSWORD || 'karol';
const VLC_AUTH = 'Basic ' + Buffer.from(':' + VLC_PASSWORD).toString('base64');

// VLC runtime health — updated by ensureVlcRunning on startup and
// after each vlcGet call. The /api/vlc-dj/health endpoint reads this
// instead of returning a hardcoded true.
let vlcAvailable = false;
let vlcRejections = 0;
const VLC_MAX_REJECTIONS = 5;

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

// ── YouTube DJ proxy middleware ───────────────────────────────────────

// ── YouTube response cache (serve stale on S8 unreachable) ──
const youtubeCache = new Map(); // path -> { body, status, type, timestamp }
const YOUTUBE_CACHE_TTL = 30000; // 30 seconds stale-data window

const CACHEABLE_PATHS = new Set([
  '/api/youtube-dj/health',
  '/api/youtube-dj/now-playing',
]);

function getCachedYoutube(path) {
  const entry = youtubeCache.get(path);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > YOUTUBE_CACHE_TTL) {
    youtubeCache.delete(path);
    return null;
  }
  return entry;
}

function setCachedYoutube(path, status, body, type) {
  youtubeCache.set(path, { status, body, type, timestamp: Date.now() });
}

function proxyYouTubeToPlayer(ctx) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (status, body, isCached) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      try { socket && socket.removeAllListeners('error'); } catch {}
      try { resStream && resStream.removeAllListeners('error'); } catch {}
      ctx.status = status;
      if (typeof body === 'object') ctx.type = 'application/json';
      ctx.body = body;
      resolve();
      // On success, cache the response for cacheable GET endpoints
      if (!isCached && status >= 200 && status < 300 && ctx.method === 'GET' && CACHEABLE_PATHS.has(ctx.path)) {
        setCachedYoutube(ctx.path, status, body, ctx.response && ctx.response.type);
      }
    };

    const reqBody = ctx.request.body && Object.keys(ctx.request.body).length > 0
      ? JSON.stringify(ctx.request.body)
      : null;

    const reqPath = ctx.path + (ctx.querystring ? '?' + ctx.querystring : '');

    const reqOpts = {
      hostname: PLAYER_HOST,
      port: PLAYER_PORT,
      path: reqPath,
      method: ctx.method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 30000,
      family: 4,
    };
    if (reqBody) reqOpts.headers['Content-Length'] = Buffer.byteLength(reqBody);

    const req = http.request(reqOpts);
    let socket = null;
    let resStream = null;

    req.on('socket', (sock) => {
      socket = sock;
      socket.on('error', (err) => {
        console.error(`[youtube-dj proxy] Socket error for ${ctx.method} ${ctx.path}: ${err.message}`);
        try { req.destroy(); } catch {}
        settle(502, { ok: false, error: 'Player unreachable', details: err.message });
      });
    });

    req.on('response', (res) => {
      resStream = res;
      let data = '';
      res.on('error', (err) => {
        console.error(`[youtube-dj proxy] Response error for ${ctx.method} ${ctx.path}: ${err.message}`);
        try { req.destroy(); } catch {}
        settle(502, { ok: false, error: 'Player response error', details: err.message });
      });
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.headers['content-type']) ctx.type = res.headers['content-type'];
        try { settle(res.statusCode, JSON.parse(data)); }
        catch { settle(res.statusCode, data); }
      });
    });

    const connectTimer = setTimeout(() => {
      try { req.destroy(); } catch {}
      console.error(`[youtube-dj proxy] Connect timeout for ${ctx.method} ${ctx.path}`);
      // Try serving from cache before returning 502
      const cached = getCachedYoutube(ctx.path);
      if (cached) {
        console.log(`[youtube-dj proxy] Serving stale cache for ${ctx.path}`);
        settle(cached.status, cached.body, true);
      } else {
        settle(502, { ok: false, error: 'Player connection timeout' });
      }
    }, 10000);

    req.on('error', (err) => {
      console.error(`[youtube-dj proxy] Error proxying ${ctx.method} ${ctx.path}: ${err.message}`);
      // Try serving from cache before returning 502
      const cached = getCachedYoutube(ctx.path);
      if (cached) {
        console.log(`[youtube-dj proxy] Serving stale cache for ${ctx.path}`);
        settle(cached.status, cached.body, true);
      } else {
        settle(502, { ok: false, error: 'Player unreachable', details: err.message });
      }
    });

    req.on('timeout', () => {
      try { req.destroy(); } catch {}
      console.error(`[youtube-dj proxy] Request timeout for ${ctx.method} ${ctx.path}`);
      const cached = getCachedYoutube(ctx.path);
      if (cached) {
        console.log(`[youtube-dj proxy] Serving stale cache for ${ctx.path}`);
        settle(cached.status, cached.body, true);
      } else {
        settle(502, { ok: false, error: 'Player request timeout' });
      }
    });

    if (reqBody) req.write(reqBody);
    req.end();
  });
}

// Track whether the S8 player was recently unreachable (fast-fail cache mode)
let playerRecentlyDown = false;
let playerDownSince = 0;
const PLAYER_DOWN_COOLDOWN = 15000; // After 15s of failures, try again

app.use(async (ctx, next) => {
  if (ctx.path.startsWith('/api/youtube-dj/') || ctx.path.startsWith('/api/youtube-karaoke/')) {
    // Fast-fail: if player was recently down and we have a fresh cache, serve it immediately
    if (playerRecentlyDown && ctx.method === 'GET' && CACHEABLE_PATHS.has(ctx.path)) {
      const cached = getCachedYoutube(ctx.path);
      if (cached) {
        const age = Date.now() - cached.timestamp;
        // If cache is fresh enough and player was recently down, skip the proxy attempt
        if (age < PLAYER_DOWN_COOLDOWN + YOUTUBE_CACHE_TTL) {
          console.log(`[youtube-dj proxy] Fast-fail cache for ${ctx.path} (player down since ${Math.round((Date.now() - playerDownSince) / 1000)}s ago)`);
          ctx.status = cached.status;
          ctx.type = 'application/json';
          ctx.body = cached.body;
          return;
        }
      }
      // Cooldown expired, try the player again
      playerRecentlyDown = false;
    }
    await proxyYouTubeToPlayer(ctx);
    // Track if the proxy failed (502)
    if (ctx.status === 502) {
      if (!playerRecentlyDown) {
        playerRecentlyDown = true;
        playerDownSince = Date.now();
      }
    } else {
      playerRecentlyDown = false;
    }
    return;
  }
  await next();
});

// ── VLC routes ──

// ═══════════════════════════════════════════════════════════════
//  Library Module — local video download + metadata pipeline
// ═══════════════════════════════════════════════════════════════

const LIBRARY_DIR = path.resolve(__dirname, '..', '.deskreen', 'library');
const DOWNLOADS_DIR = path.resolve(__dirname, '..', '.deskreen', 'youtube-downloads');
const ARCHIVE_PATH = path.resolve(__dirname, '..', '.deskreen', 'youtube-download-archive.txt');
const TAGS_PATH = path.resolve(__dirname, '..', '.deskreen', 'tags.json');
const YT_DLP_PATH = '/opt/homebrew/bin/yt-dlp';

fs.mkdirSync(LIBRARY_DIR, { recursive: true });

function getVideoPath(videoId) {
  // Try exact match first, then wildcard (yt-dlp sometimes adds format code suffix)
  const exact = path.join(LIBRARY_DIR, videoId + '.mp4');
  if (fs.existsSync(exact)) return exact;
  try {
    const files = fs.readdirSync(LIBRARY_DIR);
    const match = files.find(f => f.startsWith(videoId) && f.endsWith('.mp4'));
    if (match) return path.join(LIBRARY_DIR, match);
  } catch (e) { /* ignore */ }
  return exact; // return expected path even if not found
}
function getInfoPath(videoId) {
  return path.join(LIBRARY_DIR, videoId + '.info.json');
}
function getThumbPath(videoId) {
  try {
    const files = fs.readdirSync(LIBRARY_DIR);
    for (const ext of ['jpg', 'webp', 'png']) {
      const exact = path.join(LIBRARY_DIR, videoId + '.' + ext);
      if (fs.existsSync(exact)) return exact;
      const match = files.find(f => f.startsWith(videoId) && f.endsWith('.' + ext) && !f.includes('.vtt') && !f.includes('.info.'));
      if (match) return path.join(LIBRARY_DIR, match);
    }
  } catch (e) { /* ignore */ }
  return null;
}

function getVideoMetadata(videoId) {
  try {
    const info = JSON.parse(fs.readFileSync(getInfoPath(videoId), 'utf8'));
    return {
      id: info.id,
      title: info.title,
      duration: info.duration,
      thumbnail: info.thumbnail,
      upload_date: info.upload_date,
      subtitles: Object.keys(info.subtitles || {}),
    };
  } catch { return null; }
}

function getSubtitleFiles(videoId) {
  if (!fs.existsSync(LIBRARY_DIR)) return [];
  const files = [];
  try {
    for (const f of fs.readdirSync(LIBRARY_DIR)) {
      if (f.startsWith(videoId + '.') && f.endsWith('.vtt')) {
        const stripped = f.replace(videoId + '.', '').replace('.vtt', '');
        files.push({ lang: stripped, file: f, path: path.join(LIBRARY_DIR, f) });
      }
    }
  } catch (e) { /* ignore */ }
  return files;
}

function validateVttFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    if (content.trim().startsWith('WEBVTT') && content.trim().length > 20) {
      return true;
    }
  } catch {}
  try { fs.unlinkSync(filePath); } catch {}
  return false;
}

function downloadVideo(videoId) {
  return new Promise((resolve, reject) => {
    const mp4 = getVideoPath(videoId);
    if (fs.existsSync(mp4)) { resolve(mp4); return; }

    console.log('[library] Downloading video: ' + videoId);
    const proc = require('child_process').spawn(YT_DLP_PATH, [
      '-f', 'b[height<=1080]',
      '--merge-output-format', 'mp4',
      '--write-info-json',
      '--write-thumbnail',
      '--write-subs', '--sub-langs', 'all',
      '--download-archive', ARCHIVE_PATH,
      '-o', path.join(LIBRARY_DIR, '%(id)s.%(ext)s'),
      '--no-playlist',
      'https://www.youtube.com/watch?v=' + videoId,
    ], { timeout: 90000 });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(mp4)) {
        console.log('[library] Download complete: ' + videoId);
        // Validate subtitle files
        const subs = getSubtitleFiles(videoId);
        for (const s of subs) { validateVttFile(s.path); }
        resolve(mp4);
      } else {
        console.error('[library] Download failed for ' + videoId + ' (code ' + code + ')');
        reject(new Error('Download failed with code ' + code + (stderr ? ': ' + stderr.slice(-200) : '')));
      }
    });
    proc.on('error', reject);
  });
}

// ═══════════════════════════════════════════════════════════════

router.get('/api/vlc-dj/health', async (ctx) => {
  // Actually probe VLC's HTTP interface instead of returning a hardcoded true.
  // Also check the consecutive-failure counter so a single transient error
  // doesn't flip vlcAvailable to false.
  try {
    await vlcGet('/requests/status.json');
    vlcRejections = 0;
    vlcAvailable = true;
  } catch {
    vlcRejections++;
    if (vlcRejections >= VLC_MAX_REJECTIONS) {
      vlcAvailable = false;
    }
  }
  ctx.body = { ok: true, vlcAvailable, hardwareAvailable: true };
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

// ── Minimal OSC bundle builder (plain UDP, no npm dep) ──
function pad4(buf) {
  while (buf.length % 4 !== 0) buf = Buffer.concat([buf, Buffer.from([0])]);
  return buf;
}

// ── OSC message builder (supports 0+ float args for AbletonOSC) ──
function oscMsg(address, args) {
  // args = array of numbers, or empty array for no-arg messages
  const addr = pad4(Buffer.from(address + '\0'));
  let typeTag = ',';
  for (const a of args) { typeTag += 'f'; }
  const tt = pad4(Buffer.from(typeTag + '\0'));
  const argBufs = [];
  for (const a of args) {
    const b = Buffer.alloc(4);
    b.writeFloatBE(a, 0);
    argBufs.push(b);
  }
  return Buffer.concat([addr, tt, ...argBufs]);
}

function sendOscBundle(msg) {
  const dgram = require('dgram');
  const sock = dgram.createSocket('udp4');
  // Wrap in bundle
  const header = Buffer.from('#bundle\0');
  const timetag = Buffer.alloc(8);
  timetag.writeBigInt64BE(BigInt(1), 0);
  const size = Buffer.alloc(4);
  size.writeInt32BE(msg.length, 0);
  const buf = Buffer.concat([header, timetag, size, msg]);
  sock.send(buf, 0, buf.length, 11000, '127.0.0.1', () => sock.close());
}

function sendOsc(address, ...args) { sendOscBundle(oscMsg(address, args)); }

// Reusable single-message bundle (used by queryTrackProperties)
function oscBundleSingle(address, args) {
  const msg = oscMsg(address, args || []);
  const header = Buffer.from('#bundle\0');
  const timetag = Buffer.alloc(8);
  timetag.writeBigInt64BE(BigInt(1), 0);
  const size = Buffer.alloc(4);
  size.writeInt32BE(msg.length, 0);
  return Buffer.concat([header, timetag, size, msg]);
}

// ── OSC reply parser (reverse of oscMsg) ──
function parseOscReply(buf) {
  // Skip bundle header (#bundle + timetag = 16 bytes)
  let offset = 16;
  const messages = [];
  while (offset < buf.length) {
    const size = buf.readInt32BE(offset);
    offset += 4;
    const msg = buf.slice(offset, offset + size);
    offset += size;
    if (msg.length === 0) continue;
    // Parse address pattern
    let addrEnd = 0;
    while (addrEnd < msg.length && msg[addrEnd] !== 0) addrEnd++;
    const address = msg.slice(0, addrEnd).toString();
    // Skip to aligned address end
    let cursor = addrEnd;
    while (cursor % 4 !== 0) cursor++;
    // Type tag starts with comma
    if (msg[cursor] !== 0x2c) continue; // ','
    let typeEnd = cursor;
    while (typeEnd < msg.length && msg[typeEnd] !== 0) typeEnd++;
    const types = msg.slice(cursor + 1, typeEnd).toString();
    cursor = typeEnd;
    while (cursor % 4 !== 0) cursor++;
    // Parse arguments
    const args = [];
    for (let i = 0; i < types.length && cursor < msg.length; i++) {
      if (types[i] === 'f') {
        args.push(msg.readFloatBE(cursor));
        cursor += 4;
      } else if (types[i] === 'i') {
        args.push(msg.readInt32BE(cursor));
        cursor += 4;
      } else if (types[i] === 's' || types[i] === 'S') {
        let strEnd = cursor;
        while (strEnd < msg.length && msg[strEnd] !== 0) strEnd++;
        args.push(msg.slice(cursor, strEnd).toString());
        cursor = strEnd;
        while (cursor % 4 !== 0) cursor++;
      } else if (types[i] === 'T') { args.push(true); }
      else if (types[i] === 'F') { args.push(false); }
      else { cursor += 4; } // skip unknown
    }
    messages.push({ address, args });
  }
  return messages;
}

// ── Bidirectional OSC: single persistent socket for send + receive ──
let oscSocket = null;
let trackCache = {}; // track_id -> { name, volume, muted, solo, pan, sends[], meters }
let oscSocketBound = false;

function ensureOscSocket() {
  const dgram = require('dgram');
  if (oscSocket && oscSocketBound) return;
  if (oscSocket) { try { oscSocket.close(); } catch {} }
  oscSocket = dgram.createSocket('udp4');
  oscSocket.on('message', (buf) => {
    try {
      const msgs = parseOscReply(buf);
      for (const { address, args } of msgs) {
        if (address.startsWith('/live/track/get/name') && args.length >= 2) {
          const tid = Math.round(args[0]);
          if (tid >= 0) { trackCache[tid] = trackCache[tid] || {}; trackCache[tid].name = args[1]; }
        } else if (address.startsWith('/live/track/get/volume') && args.length >= 2) {
          const tid = Math.round(args[0]);
          if (tid >= 0) { trackCache[tid] = trackCache[tid] || {}; trackCache[tid].volume = args[1]; }
        } else if (address.startsWith('/live/track/get/mute') && args.length >= 2) {
          const tid = Math.round(args[0]);
          if (tid >= 0) { trackCache[tid] = trackCache[tid] || {}; trackCache[tid].muted = args[1] === 1; }
        } else if (address.startsWith('/live/track/get/solo') && args.length >= 2) {
          const tid = Math.round(args[0]);
          if (tid >= 0) { trackCache[tid] = trackCache[tid] || {}; trackCache[tid].solo = args[1] === 1; }
        } else if (address.startsWith('/live/track/get/panning') && args.length >= 2) {
          const tid = Math.round(args[0]);
          if (tid >= 0) { trackCache[tid] = trackCache[tid] || {}; trackCache[tid].pan = args[1]; }
        } else if (address.startsWith('/live/track/get/send') && args.length >= 3) {
          const tid = Math.round(args[0]);
          const sid = Math.round(args[1]);
          if (tid >= 0) { trackCache[tid] = trackCache[tid] || {}; trackCache[tid].sends = trackCache[tid].sends || []; trackCache[tid].sends[sid] = args[2]; }
        } else if (address.startsWith('/live/track/get/output_meter_left') && args.length >= 2) {
          const tid = Math.round(args[0]);
          if (tid >= 0) { trackCache[tid] = trackCache[tid] || {}; trackCache[tid].meterLeft = args[1]; }
        } else if (address.startsWith('/live/track/get/output_meter_right') && args.length >= 2) {
          const tid = Math.round(args[0]);
          if (tid >= 0) { trackCache[tid] = trackCache[tid] || {}; trackCache[tid].meterRight = Math.max(0, args[1]); }
        } else if (address === '/live/song/get/tempo' && args.length >= 1) {
          cachedAbletonState.tempo = Math.round(args[0]);
        }
      }
    } catch { /* ignore parse errors */ }
  });
  oscSocket.bind(0, '127.0.0.1', () => { oscSocketBound = true; });
}

function sendOscPersistent(address, ...args) {
  ensureOscSocket();
  if (!oscSocket) return;
  const buf = oscBundleSingle(address, args);
  oscSocket.send(buf, 0, buf.length, 11000, '127.0.0.1');
}

// ── Track discovery: query track names and properties ──
let oscQueryTimer = null;

function queryTrackProperties() {
  // Query master meters
  sendOscPersistent('/live/track/get/output_meter_left', -1, 0);
  sendOscPersistent('/live/track/get/output_meter_right', -1, 0);
  
  // Query up to 8 tracks for all properties
  for (let i = 0; i < 8; i++) {
    const props = ['name', 'volume', 'mute', 'solo', 'panning', 'output_meter_left', 'output_meter_right'];
    for (const p of props) {
      if (p === 'name') {
        sendOscPersistent('/live/track/get/' + p, i);
      } else {
        sendOscPersistent('/live/track/get/' + p, i, 0);
      }
    }
  }
  
  // After 2 seconds, sync trackCache into cachedAbletonState
  setTimeout(() => {
    const keys = Object.keys(trackCache).filter(k => k !== '-1').map(Number).sort((a,b) => a-b);
    if (keys.length > 0) {
      cachedAbletonState.tracks = keys.map(idx => ({
        index: idx,
        name: (trackCache[idx] && trackCache[idx].name) || ('Track ' + (idx + 1)),
        volume: trackCache[idx].volume != null ? trackCache[idx].volume : 0.75,
        muted: trackCache[idx].muted || false,
        solo: trackCache[idx].solo || false,
        pan: trackCache[idx].pan != null ? trackCache[idx].pan : 0,
        sends: trackCache[idx].sends || [],
        meterLeft: trackCache[idx].meterLeft != null ? trackCache[idx].meterLeft : 0,
        meterRight: trackCache[idx].meterRight != null ? trackCache[idx].meterRight : 0,
        color: '#555',
        hasClip: false,
        isPlaying: false,
      }));
    }
    if (trackCache['-1']) {
      cachedAbletonState.masterMeterLeft = trackCache['-1'].meterLeft || 0;
      cachedAbletonState.masterMeterRight = trackCache['-1'].meterRight || 0;
    }
  }, 2000);
}

// ── Ableton connection state ──
let abletonConnected = false;

function checkAbletonConnected() {
  const { execSync } = require('child_process');
  try {
    const out = execSync('lsof -i :11000 -sTCP:LISTEN 2>/dev/null || lsof -i :11000 2>/dev/null', { timeout: 2000 }).toString();
    return out.includes('Live') || out.includes('Ableton');
  } catch {
    return false;
  }
}

// ── Cached state — stores the last values the user/API set ──
const TRACK_COLORS = ['#E0533D', '#D95C14', '#E0962D', '#7CB342', '#1FAC8A',
  '#2090C0', '#4766B8', '#6C3FAA', '#B34DA0', '#D9488B',
  '#6B8E92', '#8C6B53', '#5C6BC0', '#26A69A', '#AB47BC',
];

function defaultTrack(idx) {
  return {
    index: idx,
    name: 'Track ' + (idx + 1),
    volume: 0.75,
    muted: false,
    solo: false,
    pan: 0,
    color: TRACK_COLORS[idx % TRACK_COLORS.length],
    sends: [0, 0, 0, 0],
    hasClip: false,
    isPlaying: false,
    meterLeft: 0,
    meterRight: 0,
  };
}

const cachedAbletonState = {
  playing: false,
  tempo: 120,
  beatPosition: 0,
  masterVolume: 0.85,
  masterMeterLeft: 0,
  masterMeterRight: 0,
  tracks: [
    { ...defaultTrack(0), name: 'Karol DJ', volume: 0.75 },
    { ...defaultTrack(1), name: 'VLC Playlist', volume: 0.75 },
  ],
};

function ensureTrack(idx) {
  while (cachedAbletonState.tracks.length <= idx) {
    cachedAbletonState.tracks.push(defaultTrack(cachedAbletonState.tracks.length));
  }
  return cachedAbletonState.tracks[idx];
}

// Poll connection every 5 seconds, query track properties every 5s
function startAbletonPoll() {
  setInterval(() => {
    abletonConnected = checkAbletonConnected();
    if (abletonConnected) {
      ensureOscSocket();
      queryTrackProperties();
    }
  }, 5000);
  abletonConnected = checkAbletonConnected();
  if (abletonConnected) {
    ensureOscSocket();
    setTimeout(queryTrackProperties, 1000);
  }
}

// ── Ableton routes (AbletonOSC Remote Script API) ──
router.get('/api/ableton/health', (ctx) => {
  ctx.body = { ok: true, connected: abletonConnected };
});

router.get('/api/ableton/state', (ctx) => {
  ctx.body = {
    ok: true,
    connected: abletonConnected,
    playing: cachedAbletonState.playing,
    tempo: cachedAbletonState.tempo,
    beatPosition: cachedAbletonState.beatPosition,
    tracks: cachedAbletonState.tracks,
    masterVolume: cachedAbletonState.masterVolume,
    masterMeterLeft: cachedAbletonState.masterMeterLeft,
    masterMeterRight: cachedAbletonState.masterMeterRight,
  };
});

// Comprehensive mixer state for the Ableton Mixer SPA
router.get('/api/ableton/mixer-state', (ctx) => {
  ctx.body = {
    ok: true,
    connected: abletonConnected,
    playing: cachedAbletonState.playing,
    tempo: cachedAbletonState.tempo,
    beatPosition: cachedAbletonState.beatPosition,
    tracks: cachedAbletonState.tracks,
    masterVolume: cachedAbletonState.masterVolume,
    masterMeterLeft: cachedAbletonState.masterMeterLeft,
    masterMeterRight: cachedAbletonState.masterMeterRight,
  };
});

// Transport: AbletonOSC song commands take NO arguments
router.post('/api/ableton/transport/play', (ctx) => {
  sendOsc('/live/song/start_playing');
  cachedAbletonState.playing = true;
  ctx.body = { ok: true };
});

router.post('/api/ableton/transport/stop', (ctx) => {
  sendOsc('/live/song/stop_playing');
  cachedAbletonState.playing = false;
  ctx.body = { ok: true };
});

// Track volume: /live/track/set/volume <track_id> <volume>
router.post('/api/ableton/track/:i/volume', (ctx) => {
  const idx = parseInt(ctx.params.i, 10);
  const { volume } = ctx.request.body || {};
  if (volume == null) { ctx.status = 400; ctx.body = { ok: false, error: 'volume required' }; return; }
  const clamped = Math.max(0, Math.min(1, volume));
  sendOsc('/live/track/set/volume', idx, clamped);
  console.log('[ableton:track] Setting track', idx, 'volume to', clamped);
  if (idx >= 0) {
    const t = ensureTrack(idx);
    t.volume = clamped;
  }
  ctx.body = { ok: true };
});

// Track mute: /live/track/set/mute <track_id> <mute>
router.post('/api/ableton/track/:i/mute', (ctx) => {
  const idx = parseInt(ctx.params.i, 10);
  const { muted } = ctx.request.body || {};
  if (muted == null) { ctx.status = 400; ctx.body = { ok: false, error: 'muted required' }; return; }
  sendOsc('/live/track/set/mute', idx, muted ? 1 : 0);
  console.log('[ableton:track] Setting track', idx, 'mute to', muted);
  if (idx >= 0) {
    const t = ensureTrack(idx);
    t.muted = !!muted;
  }
  ctx.body = { ok: true };
});

// Master track in Ableton LOM is track_id = -1
router.post('/api/ableton/master/volume', (ctx) => {
  const { volume } = ctx.request.body || {};
  if (volume == null) { ctx.status = 400; ctx.body = { ok: false, error: 'volume required' }; return; }
  const clamped = Math.max(0, Math.min(1, volume));
  sendOsc('/live/track/set/volume', -1, clamped);
  cachedAbletonState.masterVolume = clamped;
  console.log('[ableton:master] Master volume set to', clamped, '(' + Math.round(clamped * 100) + '%)');
  ctx.body = { ok: true };
});

// Tempo: /live/song/set/tempo <bpm>
router.post('/api/ableton/tempo', (ctx) => {
  const { bpm } = ctx.request.body || {};
  if (bpm == null) { ctx.status = 400; ctx.body = { ok: false, error: 'bpm required' }; return; }
  const clamped = Math.max(20, Math.min(999, bpm));
  sendOsc('/live/song/set/tempo', clamped);
  cachedAbletonState.tempo = clamped;
  console.log('[ableton:tempo] Tempo set to', clamped, 'BPM');
  ctx.body = { ok: true };
});

// Bulk mix update
router.post('/api/ableton/mix', (ctx) => {
  const { karaokeVol, karaokeMuted, vlcVol, vlcMuted, masterVol } = ctx.request.body || {};
  // Track 0 (Karol DJ)
  if (karaokeVol != null) {
    const v = Math.max(0, Math.min(1, karaokeVol));
    sendOsc('/live/track/set/volume', 0, v);
    ensureTrack(0).volume = v;
  }
  if (karaokeMuted != null) {
    sendOsc('/live/track/set/mute', 0, karaokeMuted ? 1 : 0);
    ensureTrack(0).muted = !!karaokeMuted;
  }
  // Track 1 (VLC Playlist)
  if (vlcVol != null) {
    const v = Math.max(0, Math.min(1, vlcVol));
    sendOsc('/live/track/set/volume', 1, v);
    ensureTrack(1).volume = v;
  }
  if (vlcMuted != null) {
    sendOsc('/live/track/set/mute', 1, vlcMuted ? 1 : 0);
    ensureTrack(1).muted = !!vlcMuted;
  }
  // Master
  if (masterVol != null) {
    const v = Math.max(0, Math.min(1, masterVol));
    sendOsc('/live/track/set/volume', -1, v);
    cachedAbletonState.masterVolume = v;
  }
  console.log('[ableton:mix] Bulk update - master:', cachedAbletonState.masterVolume, 'track0:', ensureTrack(0).volume, 'track1:', ensureTrack(1).volume);
  ctx.body = { ok: true };
});

// Track solo: toggles solo state
router.post('/api/ableton/track/:i/solo', (ctx) => {
  const idx = parseInt(ctx.params.i, 10);
  if (isNaN(idx) || idx < 0) { ctx.status = 400; ctx.body = { ok: false, error: 'invalid track index' }; return; }
  const t = ensureTrack(idx);
  const next = !t.solo;
  sendOsc('/live/track/set/solo', idx, next ? 1 : 0);
  t.solo = next;
  console.log('[ableton:track] Setting track', idx, 'solo to', next);
  ctx.body = { ok: true, solo: next };
});

// Track pan: /live/track/set/panning <track_id> <pan>  (pan is -1 to 1)
router.post('/api/ableton/track/:i/pan', (ctx) => {
  const idx = parseInt(ctx.params.i, 10);
  const { pan } = ctx.request.body || {};
  if (pan == null) { ctx.status = 400; ctx.body = { ok: false, error: 'pan required' }; return; }
  if (isNaN(idx) || idx < 0) { ctx.status = 400; ctx.body = { ok: false, error: 'invalid track index' }; return; }
  const clamped = Math.max(-1, Math.min(1, pan));
  sendOsc('/live/track/set/panning', idx, clamped);
  const t = ensureTrack(idx);
  t.pan = clamped;
  console.log('[ableton:track] Setting track', idx, 'pan to', clamped);
  ctx.body = { ok: true, pan: clamped };
});

// Track send: /live/track/set/send <track_id> <send_id> <value>
router.post('/api/ableton/track/:i/send/:sendIndex', (ctx) => {
  const idx = parseInt(ctx.params.i, 10);
  const sendIdx = parseInt(ctx.params.sendIndex, 10);
  const { value } = ctx.request.body || {};
  if (value == null) { ctx.status = 400; ctx.body = { ok: false, error: 'value required' }; return; }
  if (isNaN(idx) || idx < 0) { ctx.status = 400; ctx.body = { ok: false, error: 'invalid track index' }; return; }
  if (isNaN(sendIdx) || sendIdx < 0 || sendIdx > 3) { ctx.status = 400; ctx.body = { ok: false, error: 'invalid send index (0-3)' }; return; }
  const clamped = Math.max(0, Math.min(1, value));
  sendOsc('/live/track/set/send', idx, sendIdx, clamped);
  const t = ensureTrack(idx);
  if (!t.sends) t.sends = [0, 0, 0, 0];
  t.sends[sendIdx] = clamped;
  console.log('[ableton:track] Setting track', idx, 'send', sendIdx, 'to', clamped);
  ctx.body = { ok: true, sendIndex: sendIdx, value: clamped };
});

// ── Audio device discovery (for U-Phoria detection from S24) ──
router.get('/api/audio/devices', (ctx) => {
  const { execSync } = require('child_process');
  let umcPresent = false;
  let blackholePresent = false;
  let karolAggregate = false;
  let defaultOutput = '';
  let umcSampleRate = 0;

  try {
    const out = execSync('system_profiler SPAudioDataType -json', { timeout: 3000 }).toString();
    const data = JSON.parse(out);
    for (const item of data.SPAudioDataType || []) {
      for (const d of item._items || []) {
        const name = d._name || '';
        if (name.includes('UMC404HD')) {
          umcPresent = true;
          umcSampleRate = d.coreaudio_device_srate || 0;
        }
        if (name === 'BlackHole 2ch') blackholePresent = true;
        if (name === 'Karol') karolAggregate = true;
        if (d.coreaudio_default_audio_output_device === 'spaudio_yes') defaultOutput = name;
      }
    }
  } catch {}

  ctx.body = {
    ok: true,
    devices: {
      umc404hd: { present: umcPresent, sampleRate: umcSampleRate, type: 'USB audio interface', inputs: 4, outputs: 4 },
      blackhole: { present: blackholePresent, type: 'Virtual audio driver' },
      karolAggregate: { present: karolAggregate, type: 'Multi-Output Device' },
    },
    defaultOutput,
    abletonConnected: abletonConnected,
    apiOnline: true,
  };
});

// ── Ableton session template (recommended track layout) ──
router.get('/api/ableton/template', (ctx) => {
  ctx.body = {
    ok: true,
    template: {
      name: 'Karol DJ Session',
      description: 'Recommended Ableton Live track layout for Karol DJ/karaoke',
      tracks: [
        {
          index: 0,
          name: 'Karol DJ',
          type: 'Audio',
          input: { device: 'BlackHole 2ch', channels: '1-2' },
          output: 'Master',
          description: 'Karaoke mic / DJ audio input from BlackHole channels 1-2',
          recommendedPlugins: ['EQ Eight (HPF at 80Hz)', 'Compressor (light, 2:1)', 'Reverb (Send A)'],
        },
        {
          index: 1,
          name: 'VLC Playlist',
          type: 'Audio',
          input: { device: 'BlackHole 2ch', channels: '3-4' },
          output: 'Master',
          description: 'Background music from VLC via BlackHole channels 3-4',
          recommendedPlugins: ['EQ Eight (slight smile curve)', 'Compressor (gentle)'],
        },
      ],
      sends: [
        { index: 0, label: 'A - Reverb', type: 'Reverb', preset: 'Medium Hall' },
        { index: 1, label: 'B - Delay', type: 'Delay', preset: 'Stereo 1/4' },
      ],
      master: {
        output: { device: 'Karol', description: 'Multi-Output Device (UMC404HD + BlackHole 2ch)' },
        recommendedPlugins: ['Limiter (ceiling -0.3dB)'],
      },
      audioSettings: {
        inputDevice: 'UMC404HD 192k',
        outputDevice: 'Karol',
        sampleRate: 48000,
        bufferSize: 256,
      },
    },
  };
});

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

// ── Discovery endpoint (required by Android controller health check) ──
router.get('/api/discover.json', (ctx) => {
  const lanIp = getLanIp();
  ctx.body = {
    name: 'Karol API Server',
    role: 'dj-host',
    ready: true,
    host: lanIp,
    port: PORT,
    shareUrl: null,
    djControllerUrl: `http://${lanIp}:${PORT}/dj-controller/`,
    youtubeDjHealthUrl: `http://${lanIp}:${PORT}/api/youtube-dj/health`,
    vlcDjHealthUrl: `http://${lanIp}:${PORT}/api/vlc-dj/status`,
  };
});

// ── Library API endpoints ──

// Metadata: returns info.json data for a video. Triggers background download if not available.
router.get('/api/library/metadata/:videoId', async (ctx) => {
  const videoId = ctx.params.videoId;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    ctx.status = 400; ctx.body = { ok: false, error: 'Invalid video ID' }; return;
  }
  const meta = getVideoMetadata(videoId);
  if (meta) {
    ctx.body = { ok: true, ready: true, ...meta };
    return;
  }
  // Not downloaded yet — trigger background download, return immediately
  downloadVideo(videoId).catch((e) => console.warn('[library] Background download failed: ' + e.message));
  ctx.body = { ok: true, ready: false, downloading: true, id: videoId };
});

// Serve mp4 file with Range header support for download resumption
router.get('/api/library/file/:videoId', async (ctx) => {
  const videoId = ctx.params.videoId;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    ctx.status = 400; ctx.body = { ok: false, error: 'Invalid video ID' }; return;
  }
  const mp4 = getVideoPath(videoId);
  if (!fs.existsSync(mp4)) {
    ctx.status = 404;
    ctx.body = { ok: false, error: 'Video not downloaded yet' };
    return;
  }
  const stat = fs.statSync(mp4);
  const range = ctx.req.headers.range;
  ctx.set('Accept-Ranges', 'bytes');
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    ctx.status = 206;
    ctx.set('Content-Range', 'bytes ' + start + '-' + end + '/' + stat.size);
    ctx.set('Content-Type', 'video/mp4');
    ctx.set('Content-Length', String(end - start + 1));
    ctx.body = fs.createReadStream(mp4, { start, end });
  } else {
    ctx.set('Content-Type', 'video/mp4');
    ctx.set('Content-Length', String(stat.size));
    ctx.body = fs.createReadStream(mp4);
  }
});

// Quick status check: is the video downloaded and ready?
router.get('/api/library/status/:videoId', async (ctx) => {
  const videoId = ctx.params.videoId;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    ctx.status = 400; ctx.body = { ok: false, error: 'Invalid video ID' }; return;
  }
  const ready = fs.existsSync(getVideoPath(videoId));
  const meta = getVideoMetadata(videoId);
  const subs = getSubtitleFiles(videoId).filter(s => validateVttFile(s.path));
  ctx.body = { ok: true, ready, metadata: meta, subtitles: subs.map(s => ({ lang: s.lang })) };
});

// Serve a specific subtitle file as WebVTT
router.get('/api/library/subtitle/:videoId/:lang', async (ctx) => {
  const { videoId, lang } = ctx.params;
  if (!videoId || !lang) { ctx.status = 400; ctx.body = { ok: false }; return; }
  const filePath = path.join(LIBRARY_DIR, videoId + '.' + lang + '.vtt');
  if (!fs.existsSync(filePath)) {
    ctx.status = 404;
    ctx.body = { ok: false, error: 'Subtitle not found' };
    return;
  }
  if (!validateVttFile(filePath)) {
    ctx.status = 404;
    ctx.body = { ok: false, error: 'Subtitle file is invalid' };
    return;
  }
  ctx.set('Content-Type', 'text/vtt');
  ctx.set('Cache-Control', 'public, max-age=3600');
  ctx.body = fs.createReadStream(filePath);
});

// Serve thumbnail
router.get('/api/library/thumb/:videoId', async (ctx) => {
  const videoId = ctx.params.videoId;
  const tp = getThumbPath(videoId);
  if (!tp) { ctx.status = 404; ctx.body = { ok: false }; return; }
  const ext = path.extname(tp).toLowerCase();
  ctx.type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  ctx.set('Cache-Control', 'public, max-age=86400');
  ctx.body = fs.createReadStream(tp);
});

// List all videos in the local library
router.get('/api/library/list', async (ctx) => {
  const videos = [];
  try {
    // Parse the download archive — source of truth for what's been downloaded
    const downloadedVideoIds = new Set();
    if (fs.existsSync(ARCHIVE_PATH)) {
      const lines = fs.readFileSync(ARCHIVE_PATH, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        const vid = line.trim().replace(/^youtube\s+/i, '').trim();
        if (vid && vid.length >= 10) downloadedVideoIds.add(vid);
      }
    }

    // Single-pass scan: build videoId -> {size, subs, meta} map
    // by scanning both directories once
    const fileMap = {}; // videoId -> { size: 0, subs: Set, meta: null }

    function ensure(vid) {
      if (!fileMap[vid]) fileMap[vid] = { size: 0, subs: [], meta: null };
      return fileMap[vid];
    }

    for (const dir of [LIBRARY_DIR, DOWNLOADS_DIR]) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir);
      for (const f of files) {
        // Try to extract videoId from filename
        // Library: <videoId>.mp4 / <videoId>.info.json / <videoId>.<lang>.vtt
        // YouTube-downloads: title-based.mp4 / title-based.<lang>.vtt
        // VTT files sometimes embed videoId: title.lang-videoId.vtt
        let videoIdFromFile = null;

        // Check all known videoIds against filename
        // For library dir: strip extension to get videoId
        // For downloads dir: check if any known videoId appears in filename
        const extMatch = f.match(/\.(mp4|info\.json|vtt|webp|jpg)$/);
        if (!extMatch) continue;

        const base = f.slice(0, -extMatch[0].length);

        // Both library and downloads dirs use videoId naming
        // For VTT files with pattern <videoId>.<lang-info>.vtt, extract videoId from first segment
        const vid = (extMatch[1] === 'vtt')
          ? base.split('.')[0].replace(/\.f\d+$/, '')
          : base.replace(/\.f\d+$/, '');
        if (downloadedVideoIds.has(vid)) videoIdFromFile = vid;
        // Fallback: VTT embedded suffix like <lang>-<VIDEOID>.vtt
        else if (extMatch[1] === 'vtt') {
          const m = base.match(/[.-]([A-Za-z0-9_-]{10,12})$/);
          if (m && downloadedVideoIds.has(m[1])) videoIdFromFile = m[1];
        }

        if (!videoIdFromFile) continue;

        const entry = ensure(videoIdFromFile);

        if (extMatch[1] === 'mp4') {
          try { entry.size = fs.statSync(path.join(dir, f)).size; } catch (e) {}
        } else if (extMatch[1] === 'info.json') {
          try { entry.meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) {}
        } else if (extMatch[1] === 'vtt') {
          // Extract language code
          const parts = base.split('.');
          for (const p of parts) {
            if (/^[a-z]{2,3}(-[A-Za-z0-9]+)*$/i.test(p) && p !== 'live_chat') {
              entry.subs.push(p);
              break;
            }
          }
        }
      }
    }

    // Build result from archive entries
    for (const videoId of downloadedVideoIds) {
      const f = fileMap[videoId] || { size: 0, subs: [], meta: null };
      videos.push({
        videoId,
        title: f.meta?.title || videoId,
        duration: f.meta?.duration || 0,
        size: f.size,
        subtitles: f.subs,
        thumbnail: f.meta?.thumbnail || '',
        upload_date: f.meta?.upload_date || '',
        cached: true,
      });
    }
  } catch (e) { console.error('[library/list]', e.message); }
  // Sort by most recent first (largest file usually = full recording)
  videos.sort((a, b) => b.size - a.size);
  ctx.body = { ok: true, count: videos.length, videos };
});

// Scan summary
router.get('/api/library/scan', async (ctx) => {
  try {
    // Count mp4s across both directories
    let totalMp4Files = 0;
    let totalSize = 0;
    const langSet = new Set();

    for (const dir of [LIBRARY_DIR, DOWNLOADS_DIR]) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir);
      for (const f of files) {
        if (f.endsWith('.mp4')) {
          totalMp4Files++;
          totalSize += fs.statSync(path.join(dir, f)).size;
        }
        if (f.endsWith('.vtt')) {
          const parts = f.split('.');
          if (parts.length >= 3) langSet.add(parts[parts.length - 2]);
        }
      }
    }

    const archiveCount = fs.existsSync(ARCHIVE_PATH)
      ? fs.readFileSync(ARCHIVE_PATH, 'utf8').split('\n').filter(Boolean).length : 0;
    ctx.body = {
      ok: true,
      totalVideos: archiveCount,
      totalMp4Files,
      totalSize,
      totalSizeFormatted: (totalSize / 1024 / 1024).toFixed(0) + ' MB',
      subtitleLanguages: Array.from(langSet),
      archiveEntries: archiveCount,
    };
  } catch (e) {
    ctx.body = { ok: true, totalVideos: 0, totalSize: 0, subtitleLanguages: [], error: e.message };
  }
});

// ── Tag system (karaoke / music video) ──
function loadTags() {
  try {
    if (fs.existsSync(TAGS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(TAGS_PATH, 'utf8'));
      // Normalize: support both old string format and new object format
      const normalized = {};
      for (const [vid, val] of Object.entries(raw)) {
        if (typeof val === 'string') {
          normalized[vid] = { tag: val, year: '', artist: '', source: '' };
        } else if (val && typeof val === 'object') {
          normalized[vid] = {
            tag: val.tag || 'music',
            year: val.year || '',
            artist: val.artist || '',
            source: val.source || ''
          };
        }
      }
      return normalized;
    }
  } catch (e) { console.error('[library/tags] load error:', e.message); }
  return {};
}

function saveTags(tags) {
  try {
    fs.writeFileSync(TAGS_PATH, JSON.stringify(tags, null, 2), 'utf8');
  } catch (e) { console.error('[library/tags] save error:', e.message); }
}

router.get('/api/library/tags', async (ctx) => {
  ctx.body = { ok: true, tags: loadTags() };
});

router.post('/api/library/tags', async (ctx) => {
  const body = ctx.request.body || {};
  const videoId = body.videoId;
  const tag = body.tag;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    ctx.status = 400; ctx.body = { ok: false, error: 'Invalid videoId' }; return;
  }
  if (!tag || (tag !== 'karaoke' && tag !== 'music')) {
    ctx.status = 400; ctx.body = { ok: false, error: 'tag must be "karaoke" or "music"' }; return;
  }
  const tags = loadTags();
  // Merge: preserve existing metadata, apply new fields
  const existing = tags[videoId] || { tag: 'music', year: '', artist: '', source: '' };
  tags[videoId] = {
    tag: tag,
    year: body.year !== undefined ? String(body.year) : existing.year,
    artist: body.artist !== undefined ? String(body.artist) : existing.artist,
    source: body.source !== undefined ? String(body.source) : existing.source
  };
  saveTags(tags);
  ctx.body = { ok: true, videoId, tag: tags[videoId] };
});

// Batch download all videos from a playlist (background job)
const activeDownloads = new Set();
router.post('/api/library/download-playlist', async (ctx) => {
  const body = ctx.request.body || {};
  const playlistUrl = body.playlistUrl;
  const playlistId = body.playlistId || (playlistUrl ? playlistUrl.match(/list=([a-zA-Z0-9_-]+)/)?.[1] : null);
  if (!playlistId) { ctx.status = 400; ctx.body = { ok: false, error: 'Missing playlistId or playlistUrl' }; return; }
  if (activeDownloads.has(playlistId)) {
    ctx.body = { ok: true, alreadyRunning: true, playlistId };
    return;
  }
  activeDownloads.add(playlistId);
  ctx.body = { ok: true, started: true, playlistId };

  // Run in background
  (async () => {
    try {
      console.log('[library] Batch downloading playlist: ' + playlistId);
      const proc = require('child_process').spawn(YT_DLP_PATH, [
        '-f', 'b[height<=1080]',
        '--merge-output-format', 'mp4',
        '--write-info-json',
        '--write-thumbnail',
        '--write-subs', '--sub-langs', 'all',
        '--download-archive', ARCHIVE_PATH,
        '-o', path.join(LIBRARY_DIR, '%(id)s.%(ext)s'),
        '--yes-playlist',
        'https://www.youtube.com/playlist?list=' + playlistId,
      ], { timeout: 600000 });

      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        console.log('[library] Batch download finished for ' + playlistId + ' (code ' + code + ')');
        activeDownloads.delete(playlistId);
      });
    } catch (e) {
      console.error('[library] Batch download error: ' + e.message);
      activeDownloads.delete(playlistId);
    }
  })();
});

// ── Mount router ──
app.use(router.routes());

// ── Static: Library Dashboard ──
const libraryDashboardDir = path.resolve(__dirname, '..', 'src', 'library-dashboard');
if (fs.existsSync(libraryDashboardDir)) {
  app.use(async (ctx, next) => {
    if (!ctx.path.startsWith('/library/') && ctx.path !== '/library') { await next(); return; }
    const relPath = ctx.path === '/library' ? 'index.html' : ctx.path.slice('/library/'.length) || 'index.html';
    const filePath = path.join(libraryDashboardDir, relPath);
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        ctx.type = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : ext === '.js' ? 'application/javascript' : 'application/octet-stream';
        ctx.body = fs.createReadStream(filePath);
        return;
      }
    } catch (e) { /* fall through */ }
    ctx.type = 'text/html';
    ctx.body = fs.createReadStream(path.join(libraryDashboardDir, 'index.html'));
  });
  console.log('Library Dashboard: http://' + getLanIp() + ':' + PORT + '/library/');
}

// ── Static: Ableton Mixer SPA (iPhone-friendly) ──
const abletonMixerDir = path.resolve(__dirname, '..', 'src', 'ableton-mixer');
if (fs.existsSync(abletonMixerDir)) {
  app.use(async (ctx, next) => {
    if (!ctx.path.startsWith('/ableton-mixer/')) { await next(); return; }
    const relPath = ctx.path.slice('/ableton-mixer/'.length) || 'index.html';
    const filePath = path.join(abletonMixerDir, relPath);
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        ctx.type = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : ext === '.js' ? 'application/javascript' : ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : 'application/octet-stream';
        ctx.body = fs.createReadStream(filePath);
        return;
      }
    } catch (e) { /* fall through */ }
    ctx.type = 'text/html';
    ctx.body = fs.createReadStream(path.join(abletonMixerDir, 'index.html'));
  });
  console.log('Ableton Mixer SPA: ' + abletonMixerDir);
}

// ── Static SPA (only for non-API paths) ──
const djDistDir = path.resolve(__dirname, '..', 'src', 'dj-controller', 'dist');
if (fs.existsSync(djDistDir)) {
  app.use(async (ctx, next) => {
    if (ctx.path.startsWith('/api/')) { await next(); return; }
    // Strip /dj-controller prefix before resolving to dist filesystem
    let relative = ctx.path;
    if (relative.startsWith('/dj-controller/')) relative = relative.slice('/dj-controller/'.length);
    else if (relative.startsWith('/dj-controller')) relative = relative.slice('/dj-controller'.length);
    if (!relative || relative === '/') relative = 'index.html';
    let filePath = path.join(djDistDir, relative);
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        ctx.type = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : ext === '.js' ? 'application/javascript' : ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : 'application/octet-stream';
        // Prevent Android WebView from serving stale SPA builds
        ctx.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        ctx.set('Pragma', 'no-cache');
        ctx.set('Expires', '0');
        ctx.body = fs.createReadStream(filePath);
        return;
      }
    } catch (e) { /* fall through */ }
    ctx.type = 'text/html';
    ctx.body = fs.createReadStream(path.join(djDistDir, 'index.html'));
  });
  console.log('SPA: ' + djDistDir);
}

// ── VLC auto-start: ensure VLC is running with HTTP interface ──
// Polls the HTTP interface after launch so we don't try to talk to VLC
// before it's actually ready (race condition on fresh boot).
async function isVlcHttpReady() {
  return new Promise((resolve) => {
    const req = http.get({
      hostname: '127.0.0.1', port: 8080,
      path: '/requests/status.json',
      timeout: 2000,
      headers: { Authorization: VLC_AUTH },
    }, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function ensureVlcRunning() {
  const { spawn } = require('child_process');
  // Quick check: is VLC's HTTP port already responding?
  const alreadyRunning = await isVlcHttpReady();
  if (alreadyRunning) {
    console.log('[vlc-auto] VLC HTTP interface already running on :8080');
    vlcAvailable = true;
    return true;
  }

  console.log('[vlc-auto] Starting VLC with HTTP interface...');
  const vlcPath = '/Applications/VLC.app/Contents/MacOS/VLC';
  const vlc = spawn(vlcPath, [
    '--extraintf', 'http',
    '--http-password', VLC_PASSWORD,
    '--http-host', '127.0.0.1',
    '--http-port', '8080',
    '--play-and-exit',
    '--no-video-title-show',
  ], {
    stdio: 'ignore',
    detached: true,
  });
  vlc.unref();
  vlc.on('error', (err) => {
    console.warn('[vlc-auto] Failed to start VLC: ' + err.message);
    vlcAvailable = false;
  });

  // Poll VLC HTTP interface until it responds (up to 30 seconds)
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (await isVlcHttpReady()) {
      console.log('[vlc-auto] VLC HTTP interface ready after ' + (i + 1) + 's');
      vlcAvailable = true;
      return true;
    }
  }
  console.warn('[vlc-auto] VLC HTTP interface did not become ready within 30s');
  vlcAvailable = false;
  return false;
}

// ── VLC playlist auto-restore: write all tracks to a .m3u file so VLC
// loads them when launched. This replaces sequential HTTP enqueue (35s+)
// with instant file-based loading. ──
function writeVlcPlaylistFile() {
  const playlistFile = '/tmp/karol-vlc-playlist.m3u';
  console.log('[vlc-restore] Scanning library...');
  const tracks = scanLibraryFolders();
  if (!tracks.length) {
    console.log('[vlc-restore] No tracks found, skipping');
    try { require('fs').unlinkSync(playlistFile); } catch {}
    return null;
  }
  const m3u = '#EXTM3U\n' + tracks.map(t => t.path).join('\n') + '\n';
  require('fs').writeFileSync(playlistFile, m3u, 'utf-8');
  console.log('[vlc-restore] Wrote ' + tracks.length + ' tracks to ' + playlistFile);
  return playlistFile;
}

// ── mDNS broadcaster (Bonjour) — advertises _karol-dj._tcp so the
// S24 controller finds the server without needing a hardcoded IP ──
let mdnsProc = null;
function startMdnsBroadcaster(lanIp) {
  const { spawn } = require('child_process');
  // dns-sd -R registers a service on the local mDNS responder.
  // The controller resolves host/port from the SRV record, no TXT needed.
  mdnsProc = spawn('dns-sd', [
    '-R', 'Karol API Server',
    '_karol-dj._tcp',
    'local',
    String(PORT),
  ], {
    stdio: 'ignore',
    detached: false,
  });
  mdnsProc.on('error', (err) => {
    console.warn('[mDNS] Failed to start broadcaster: ' + err.message);
    mdnsProc = null;
  });
  mdnsProc.on('exit', () => { mdnsProc = null; });
  // Don't wait for it — koa startup doesn't block
  mdnsProc.unref();
  console.log('[mDNS] Broadcasting ' + lanIp + ':' + PORT + ' as _karol-dj._tcp');
}

function stopMdnsBroadcaster() {
  if (mdnsProc) {
    try { mdnsProc.kill('SIGTERM'); } catch {}
    mdnsProc = null;
  }
}

// ── BlackHole sample rate fix: ensures 44.1 kHz to match UMC404HD ──
// CoreAudio may reset BlackHole to 48 kHz after reboot; this Swift binary sets it.
function alignBlackHoleSampleRate() {
  const { execSync } = require('child_process');
  const binPath = path.resolve(__dirname, '..', 'scripts', 'blackhole-44100');
  if (!fs.existsSync(binPath)) {
    console.log('[blackhole-sr] Swift binary not found at ' + binPath + ' (run: swiftc -o scripts/blackhole-44100 scripts/blackhole-44100.swift)');
    return;
  }
  try {
    const out = execSync(binPath, { timeout: 3000 }).toString();
    console.log('[blackhole-sr] ' + out.trim());
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString() : e.message;
    console.warn('[blackhole-sr] Failed: ' + stderr.trim());
  }
}

// ── Audio chain verification: confirms the Karol aggregate device,
// BlackHole, and UMC404HD are present and Karol is the default output.
// Runs once at startup; results are logged for diagnosis but the server
// stays up regardless — the user can fix audio config later. ──
function verifyAudioChain() {
  const { execSync } = require('child_process');
  try {
    const text = execSync('system_profiler SPAudioDataType', { timeout: 5000, encoding: 'utf8' });
    const hasKarol = /^\s*Karol:\s*$/m.test(text);
    const hasBlackHole = /BlackHole\s*2ch/i.test(text);
    const hasUMC = /UMC404/i.test(text);
    const isDefault = /^\s*Default Output Device:\s*Yes\s*$/m.test(text);

    if (hasKarol) {
      console.log('[audio-check] Karol aggregate device: present');
    } else {
      console.warn('[audio-check] Karol aggregate device: MISSING');
    }
    if (hasBlackHole) {
      console.log('[audio-check] BlackHole 2ch: present');
    } else {
      console.warn('[audio-check] BlackHole 2ch: MISSING');
    }
    if (hasUMC) {
      console.log('[audio-check] UMC404HD: present');
    } else {
      console.warn('[audio-check] UMC404HD: MISSING');
    }
    if (isDefault) {
      console.log('[audio-check] Karol is default output: yes');
    } else {
      // The default check matches AFTER Karol's block — verify more carefully
      const afterKarol = text.split(/^\s*Karol:\s*$/m)[1] || '';
      const defaultInBlock = /^\s*Default Output Device:\s*Yes\s*$/m.test(afterKarol.split(/^\S/m)[0] || afterKarol);
      if (defaultInBlock) {
        console.log('[audio-check] Karol is default output: yes (block match)');
      } else {
        console.warn('[audio-check] Karol is default output: NO');
      }
    }
    return { hasKarol, hasBlackHole, hasUMC };
  } catch (e) {
    console.warn('[audio-check] Failed: ' + e.message);
    return { hasKarol: false, hasBlackHole: false, hasUMC: false };
  }
}

// ── Ableton auto-launch: opens the Karol template if Ableton isn't
// already running. Fire-and-forget — the audio announcement doesn't wait. ──
function launchAbletonIfNotRunning() {
  const { execSync } = require('child_process');
  const template = path.join(os.homedir(), 'Music', 'Ableton', 'User Library', 'Templates', 'Karol Live Set.als');
  if (!fs.existsSync(template)) {
    console.warn('[ableton] Template not found: ' + template);
    return;
  }
  try {
    const pgrep = execSync('pgrep -x "Live"', { timeout: 2000, encoding: 'utf8' }).trim();
    if (pgrep) {
      console.log('[ableton] Already running (pid ' + pgrep.split('\n')[0] + ') — skipping launch');
      return;
    }
  } catch { /* pgrep returns non-zero when no match — that means it's not running */ }

  console.log('[ableton] Launching with Karol template...');
  const { spawn } = require('child_process');
  const ableton = spawn('open', [
    '-a', 'Ableton Live 11 Suite',
    template,
  ], { stdio: 'ignore', detached: true });
  ableton.unref();
  ableton.on('error', (err) => {
    console.warn('[ableton] Failed: ' + err.message);
  });
}

const server = http.createServer(app.callback());
server.listen(PORT, '0.0.0.0', () => {
  console.log('Karol API online at http://0.0.0.0:' + PORT);
  console.log('  YouTube DJ proxy → ' + PLAYER_HOST + ':' + PLAYER_PORT);
  console.log('  VLC, Ableton, Hardware mixer routes ready');
  alignBlackHoleSampleRate();
  startAbletonPoll();
  startMdnsBroadcaster(getLanIp());
  // ── Audio chain verification ──
  const audioStatus = verifyAudioChain();
  // Write playlist file first, then launch VLC. After VLC is ready,
  // load the .m3u playlist via HTTP API — this is instant for VLC
  // (parses the file natively) vs sequential enqueue (35+ seconds).
  const plFile = writeVlcPlaylistFile();
  const expectedTrackCount = plFile
    ? fs.readFileSync(plFile, 'utf-8').split('\n').filter(l => l && l[0] !== '#').length
    : 0;
      console.log('[vlc-restore] Expecting ' + expectedTrackCount + ' tracks');

  // Fire-and-forget Ableton launch — doesn't block VLC restore or announcement
  launchAbletonIfNotRunning();

  ensureVlcRunning().then(async (vlcOk) => {
    let tracksLoaded = 0;
    if (vlcOk && plFile) {
      // Clear any stale playlist, then load the .m3u file
      await vlcGet('/requests/status.json?command=pl_empty');
      await vlcGet('/requests/status.json?command=in_play&input=file://' + encodeURIComponent(plFile));
      // VLC parses .m3u asynchronously — poll until all tracks appear
      console.log('[vlc-restore] Waiting for VLC to parse playlist...');
      let lastItemCount = 0;
      for (let attempt = 0; attempt < 25; attempt++) {
        await new Promise(r => setTimeout(r, 1000));
        const pl = await vlcGet('/requests/playlist.json');
        const items = (pl && pl.children && pl.children[0] && pl.children[0].children) || [];
        if (items.length !== lastItemCount) {
          console.log('[vlc-restore] Items visible: ' + items.length + '/' + expectedTrackCount);
          lastItemCount = items.length;
        }
        if (items.length >= expectedTrackCount || (items.length >= 10 && items.length === lastItemCount && attempt > 5)) {
          await vlcGet('/requests/status.json?command=pl_pause');
          tracksLoaded = items.length;
          console.log('[vlc-restore] Tracks loaded: ' + tracksLoaded + ', paused');
          break;
        }
      }
      if (!tracksLoaded) {
        console.warn('[vlc-restore] Playlist still incomplete after polling — may need manual reload');
      }
    }

    // ── Audio cue: announce readiness via macOS 'say' ──
    // Build a status message reflecting what actually came up.
    const parts = [];
    if (vlcOk && tracksLoaded) {
      parts.push(tracksLoaded + ' tracks loaded');
    } else if (vlcOk) {
      parts.push('VLC running, playlist loading');
    } else {
      parts.push('VLC not available');
    }
    if (!audioStatus.hasKarol) parts.push('aggregate device missing');
    if (!audioStatus.hasBlackHole) parts.push('BlackHole missing');
    if (!audioStatus.hasUMC) parts.push('interface missing');

    const announcement = 'Karol server is running. ' + parts.join('. ') + '.';
    const { exec } = require('child_process');
    exec('say "' + announcement.replace(/"/g, "'") + '"', (err) => {
      if (err) {
        console.warn('[announce] say failed: ' + err.message);
        setTimeout(() => { exec('say "Karol ready"', () => {}); }, 2000);
      } else {
        console.log('[announce] ' + announcement);
      }
    });
  });
});

process.on('SIGINT', () => { stopMdnsBroadcaster(); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { stopMdnsBroadcaster(); server.close(() => process.exit(0)); });

// Crash guards — log and stay alive, don't let a single unhandled error kill the server.
// launchd/crontab restart on exit, but preventing the crash in the first place avoids
// unnecessary downtime and produces cleaner logs for diagnosis.
process.on('unhandledRejection', (reason, promise) => {
  console.error('[crash-guard] Unhandled Promise Rejection:', reason);
  if (reason && reason.stack) console.error(reason.stack);
});
process.on('uncaughtException', (err) => {
  console.error('[crash-guard] Uncaught Exception (' + err.name + '):', err.message);
  if (err.stack) console.error(err.stack);
  // Don't exit — let the event loop keep running. Only exit on truly
  // unrecoverable errors (e.g., EADDRINUSE handled at listen time).
});
process.on('uncaughtExceptionMonitor', (err, origin) => {
  console.error('[crash-guard] Uncaught Exception (' + origin + '):', err.message);
});
