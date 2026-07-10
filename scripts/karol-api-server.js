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

const VLC_PASSWORD = process.env.VLC_PASSWORD || 'karol';
const VLC_AUTH = 'Basic ' + Buffer.from(':' + VLC_PASSWORD).toString('base64');

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
        if (name === 'BlackHole 16ch') blackholePresent = true;
        if (name === 'Karol') karolAggregate = true;
        if (d.coreaudio_default_audio_output_device === 'spaudio_yes') defaultOutput = name;
      }
    }
  } catch {}

  ctx.body = {
    ok: true,
    devices: {
      umc404hd: { present: umcPresent, sampleRate: umcSampleRate, type: 'USB audio interface', inputs: 4, outputs: 4 },
      blackhole16ch: { present: blackholePresent, type: 'Virtual audio driver' },
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
          input: { device: 'BlackHole 16ch', channels: '1-2' },
          output: 'Master',
          description: 'Karaoke mic / DJ audio input from BlackHole channels 1-2',
          recommendedPlugins: ['EQ Eight (HPF at 80Hz)', 'Compressor (light, 2:1)', 'Reverb (Send A)'],
        },
        {
          index: 1,
          name: 'VLC Playlist',
          type: 'Audio',
          input: { device: 'BlackHole 16ch', channels: '3-4' },
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
        output: { device: 'Karol', description: 'Multi-Output Device (UMC404HD + BlackHole 16ch)' },
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

// ── Mount router first ──
app.use(router.routes());

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
  startAbletonPoll();
});

process.on('SIGINT', () => { server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
