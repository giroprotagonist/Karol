#!/usr/bin/env node
// Karol API server - no TypeScript, no Electron deps

// ── Safety net: never let a child-process crash take down the server ──
process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] Unhandled rejection:', reason);
});

// ── Server uptime tracking (for health endpoint) ──
const SERVER_START_TIME = Date.now();
let activeConnections = 0;
let peakConnections = 0;

const http = require('http');
const Koa = require('koa');
const cors = require('kcors');
const Router = require('koa-router');
const bodyParser = require('koa-bodyparser');
const compress = require('koa-compress');
const fs = require('fs');
const path = require('path');
const os = require('os');
const mysql = require('./karol-mysql');

const PORT = 3131;

// ── mDNS Player Discovery — resolves KarolPlayer._karol-dj._tcp ──
let _mdnsPlayerBrowser = null;
let _mdnsPlayerHost = null; // { host, port, at: timestamp }
const MDNS_PLAYER_TTL = 5 * 60 * 1000; // 5 min cache
let _mdnsDiscoveryInFlight = null; // dedupe concurrent discovery calls

function discoverPlayerViaMdns() {
  if (_mdnsDiscoveryInFlight) return _mdnsDiscoveryInFlight;

  _mdnsDiscoveryInFlight = (async () => {
    // Direct resolve — skip browse, go straight to lookup
    // This is faster and more reliable than browse-then-resolve
    const { spawn } = require('child_process');
    
    try {
      const hostInfo = await new Promise((resolve) => {
        const proc = spawn('dns-sd', [
          '-L', 'KarolPlayer', '_karol-dj._tcp', 'local'
        ], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 6000 });
        
        let output = '';
        proc.stdout.on('data', (chunk) => { output += chunk.toString(); });
        
        // The dns-sd -L is fire-and-forget (keeps running), so we need a timeout
        setTimeout(() => {
          try { proc.kill('SIGTERM'); } catch {}
          const match = output.match(/reached at\s+(\S+)\.local\.:(\d+)/);
          if (match) {
            resolve({ host: match[1] + '.local', port: parseInt(match[2], 10) });
          } else {
            // Try without .local suffix — some networks resolve differently
            const match2 = output.match(/reached at\s+(\S+):(\d+)/);
            if (match2) resolve({ host: match2[1], port: parseInt(match2[2], 10) });
            else resolve(null);
          }
        }, 3000);
        
        proc.on('exit', () => { resolve(null); });
        proc.on('error', () => { resolve(null); });
      });
      
      if (hostInfo) {
        _mdnsPlayerHost = { host: hostInfo.host, port: hostInfo.port || 3131, at: Date.now() };
        // Persist to disk cache for cold-start fallback
        try { fs.writeFileSync('/tmp/karol-player-mdns.txt', hostInfo.host + '\n'); } catch {}
        return hostInfo.host;
      }
    } catch {}
    
    // mDNS failed — try persisted cache from last successful discovery
    try {
      const cached = fs.readFileSync('/tmp/karol-player-mdns.txt', 'utf8').trim();
      if (cached && cached.length > 3) {
        _mdnsPlayerHost = { host: cached, port: 3131, at: Date.now() }; // fresh TTL, re-verify in background
        // Kick off background refresh to get the real IP behind .local
        refreshPlayerHostAsync().catch(() => {});
        return cached;
      }
    } catch {}
    
    return null;
  })().then(result => {
    _mdnsDiscoveryInFlight = null;
    return result;
  }).catch(err => {
    _mdnsDiscoveryInFlight = null;
    console.warn('[mdns] Discovery failed: ' + err.message);
    return null;
  });
  
  return _mdnsDiscoveryInFlight;
}

function getPlayerHost() {
  if (process.env.PLAYER_HOST) return process.env.PLAYER_HOST;
  
  // Fresh mDNS cache — return immediately
  if (_mdnsPlayerHost && Date.now() - _mdnsPlayerHost.at < MDNS_PLAYER_TTL)
    return _mdnsPlayerHost.host;
  
  // TTL expired but we still have a cached hostname — return it and refresh in background.
  // NEVER return null here; that causes all proxy routes to serve empty stubs
  // and the queue/songs disappear even though the S8 is still reachable.
  if (_mdnsPlayerHost) {
    // Prolong TTL so we don't keep re-triggering this for every request
    _mdnsPlayerHost.at = Date.now();
    refreshPlayerHostAsync().catch(() => {});
    return _mdnsPlayerHost.host;
  }
  
  // No in-memory cache at all — try disk cache as last resort
  try {
    const cached = fs.readFileSync('/tmp/karol-player-mdns.txt', 'utf8').trim();
    if (cached && cached.length > 3) {
      _mdnsPlayerHost = { host: cached, port: 3131, at: Date.now() };
      refreshPlayerHostAsync().catch(() => {});
      return cached;
    }
  } catch {}
  
  // No cached hostname anywhere — trigger discovery but return null
  // (first ever call or cache file deleted)
  refreshPlayerHostAsync().catch(() => {});
  return null;
}

function getPlayerPort() {
  if (process.env.PLAYER_PORT) return parseInt(process.env.PLAYER_PORT, 10);
  if (_mdnsPlayerHost) return _mdnsPlayerHost.port || 3131;
  return 3131;
}

// Async refresh the player host via mDNS
function refreshPlayerHostAsync() {
  return discoverPlayerViaMdns().then(host => {
    if (host) console.log('[mdns] Discovered player at ' + host);
    else console.warn('[mdns] No KarolPlayer found via mDNS');
    return host;
  });
}

// Player down tracking — fast-fail proxy when S8 has been unreachable
let playerRecentlyDown = false;
let playerDownSince = 0;
const PLAYER_DOWN_COOLDOWN_MS = 30_000; // 30s cooldown before retrying proxy

function markPlayerDown() {
  if (!playerRecentlyDown) {
    playerRecentlyDown = true;
    playerDownSince = Date.now();
    console.log('[proxy] Player marked as DOWN — fast-failing proxy for ' + (PLAYER_DOWN_COOLDOWN_MS / 1000) + 's');
    // Trigger background rediscovery (tablet IP may have changed)
    refreshPlayerHostAsync().then((ip) => {
      if (ip && playerRecentlyDown) {
        // IP still resolves but player is still down — try again after cooldown
        console.log('[proxy] Player IP resolves to ' + ip + ' but still unreachable');
      }
    });
  }
}

function markPlayerUp() {
  if (playerRecentlyDown) {
    console.log('[proxy] Player recovered — re-enabling proxy');
    playerRecentlyDown = false;
    playerDownSince = 0;
  }
}

// ── Port conflict: try to listen directly. If the port is occupied
// by a stale instance, we exit so launchd can restart us cleanly.
// We avoid execSync / lsof because macOS TCC sandboxing in ~/Documents
// can hang those calls indefinitely. ──


const app = new Koa();
const router = new Router();
app.use(cors());
app.use(bodyParser());
// Gzip/brotli compression — cuts the 1.4MB library JSON to ~280KB
app.use(compress({
  threshold: 1024,      // compress anything over 1KB
  br: false,            // brotli compresses well but encoding is slow — gzip is fast enough
}));

// Force close after every response — prevents Firefox keep-alive connections
// from accumulating and stalling the TCP send buffer (see CLOSE_WAIT leaks)
app.use(async (ctx, next) => {
  ctx.set('Connection', 'close');
  await next();
});

// ── Health endpoint middleware — runs before ALL other routes ──
// Must never block on the event loop, proxy state, or filesystem I/O.
app.use(async (ctx, next) => {
  if (ctx.path === '/api/health.json' && ctx.method === 'GET') {
    const uptime = Math.floor((Date.now() - SERVER_START_TIME) / 1000);
    const mem = process.memoryUsage();
    ctx.type = 'application/json';
    ctx.body = JSON.stringify({
      ok: true,
      uptime,
      uptimeFormatted: Math.floor(uptime / 3600) + 'h ' + Math.floor((uptime % 3600) / 60) + 'm ' + (uptime % 60) + 's',
      memoryMB: Math.round(mem.heapUsed / 1024 / 1024),
      memoryTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      connections: activeConnections,
      peakConnections,
      playerHost: getPlayerHost() || 'not-discovered',
      playerRecentlyDown,
    });
    return;
  }
  await next();
});

// Simple per-IP rate limiter: 100 req/s burst, refills 20 tokens/s.
// Only rate-limits non-localhost clients to prevent runaway polling.
const rateLimits = new Map();
app.use(async (ctx, next) => {
  const ip = ctx.ip || 'unknown';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') { await next(); return; }
  const now = Date.now();
  let entry = rateLimits.get(ip);
  if (!entry || now - entry.ts > 30000) {
    entry = { tokens: 100, last: now, ts: now };
    rateLimits.set(ip, entry);
  }
  const elapsed = now - entry.last;
  entry.tokens = Math.min(100, entry.tokens + elapsed * (20 / 1000));
  entry.last = now;
  if (entry.tokens < 1) {
    ctx.status = 429;
    ctx.body = { ok: false, error: 'Rate limited' };
    return;
  }
  entry.tokens -= 1;
  await next();
});

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

function getMyIps() {
  const ips = new Set();
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const addr of nets[name]) {
      if (addr.address) ips.add(addr.address);
    }
  }
  return ips;
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

// ── Title resolution cache (YouTube: <id> → real title) ──
const titleResolutionCache = new Map(); // videoId => title
const TITLE_RESOLVE_TIMEOUT = 3000;

/** Resolve "YouTube: <id>" placeholder titles in a queue response via YouTube oEmbed. */
async function resolveQueuePlaceholderTitles(queueBody) {
  if (!queueBody || !queueBody.queue) return queueBody;
  const toResolve = [];
  for (const item of queueBody.queue) {
    if (!item || !item.title) continue;
    // Matches placeholder format: "YouTube: <videoId>" or bare video ID
    const placeholder = item.title.startsWith('YouTube: ') ? item.title.slice(9).trim() :
      (item.title === item.videoId ? item.videoId : null);
    if (!placeholder) continue;
    // Check cache first
    if (titleResolutionCache.has(placeholder)) {
      item.title = titleResolutionCache.get(placeholder);
      continue;
    }
    toResolve.push({ item, videoId: placeholder });
  }

  if (toResolve.length === 0) return queueBody;

  console.log(`[youtube-dj proxy] Resolving ${toResolve.length} queue titles via oEmbed...`);
  // Resolve in parallel — each with its own timeout
  await Promise.all(toResolve.map(({ item, videoId }) =>
    (async () => {
      try {
        const res = await fetch(
          `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
          { signal: AbortSignal.timeout(TITLE_RESOLVE_TIMEOUT) }
        );
        if (res.ok) {
          const json = await res.json();
          const realTitle = json.title || item.title;
          titleResolutionCache.set(videoId, realTitle);
          item.title = realTitle;
          console.log(`[youtube-dj proxy] Resolved title for ${videoId}: ${realTitle.slice(0, 50)}`);
        } else {
          console.error(`[youtube-dj proxy] oEmbed ${res.status} for ${videoId}`);
        }
      } catch (err) {
        // Keep placeholder on failure; will retry on next poll
        console.error(`[youtube-dj proxy] oEmbed failed for ${videoId}: ${err.message || err}`);
      }
    })()
  ));

  return queueBody;
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

// Dedicated agent for S8 proxy — no keep-alive, tight limits to avoid leak accumulation
const playerAgent = new http.Agent({ keepAlive: false, maxSockets: 50, maxFreeSockets: 0, timeout: 5000 });

function proxyYouTubeToPlayer(ctx) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (status, body, isCached) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      try { socket && socket.removeAllListeners('error'); } catch {}
      try { resStream && resStream.removeAllListeners('error'); } catch {}
      try { req && req.destroy(); } catch {}  // Force close to prevent CLOSE_WAIT leaks
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
      hostname: getPlayerHost(),
      port: getPlayerPort(),
      path: reqPath,
      method: ctx.method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 3000,
      family: 4,
      agent: playerAgent,
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
        // Gracefully handle tablet errors for GET endpoints that the UI polls frequently.
        // If the tablet returns 5xx for now-playing, return a stub so the UI doesn't disconnect.
        if (res.statusCode >= 500 && ctx.path === '/api/youtube-dj/now-playing') {
          console.log(`[youtube-dj proxy] Tablet returned ${res.statusCode} for now-playing — returning stub`);
          settle(200, { title: '', videoId: '', currentTime: 0, duration: 0, state: -2, error: 'Player recovering' });
          return;
        }
        if (res.headers['content-type']) ctx.type = res.headers['content-type'];
        let parsed;
        try { parsed = JSON.parse(data); } catch { settle(res.statusCode, data); return; }

        // Enrich queue items with real titles (resolve YouTube: <id> placeholders via oEmbed)
        if (ctx.method === 'GET' && ctx.path === '/api/youtube-dj/queue' && parsed && parsed.queue && parsed.queue.length > 0) {
          const placeholderCount = parsed.queue.filter(item => item.title && (item.title.startsWith('YouTube: ') || item.title === item.videoId)).length;
          console.log(`[youtube-dj proxy] Queue title resolution: ${placeholderCount} placeholders out of ${parsed.queue.length} items`);
          resolveQueuePlaceholderTitles(parsed).then((enriched) => settle(res.statusCode, enriched));
        } else {
          settle(res.statusCode, parsed);
        }
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
    }, 1000);

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

// Track whether consecutive proxy failures indicate the S8 player IP may have changed.
let consecutiveProxyFails = 0;
const PLAYER_DOWN_THRESHOLD = 10; // Consecutive 502s before triggering mDNS rediscovery

app.use(async (ctx, next) => {
  if (ctx.path.startsWith('/api/youtube-dj/') || ctx.path.startsWith('/api/youtube-karaoke/')) {
    
    // Detect self-loop: if the proxy target host is this machine, skip proxying.
    const targetHost = getPlayerHost();
    const myIps = getMyIps();
    
    // If the player has not been discovered yet via mDNS, return stubs
    // so the UI doesn't hang waiting for a proxy connection that will never come.
    if (!targetHost) {
      if (ctx.method === 'GET') {
        if (ctx.path === '/api/youtube-dj/status' || ctx.path === '/api/youtube-dj/health') {
          ctx.status = 200;
          ctx.body = { ok: true, djActive: false, castConnected: false, youtubeSignedIn: false, notDiscovered: true };
          ctx.type = 'application/json';
          return;
        }
        if (ctx.path === '/api/youtube-dj/now-playing') {
          ctx.status = 200;
          ctx.body = { title: '', videoId: '', currentTime: 0, duration: 0, state: -2 };
          ctx.type = 'application/json';
          return;
        }
        if (ctx.path === '/api/youtube-dj/queue') {
          ctx.status = 200;
          ctx.body = { ok: true, queue: [], currentIndex: -1, playerState: -2 };
          ctx.type = 'application/json';
          return;
        }
        if (ctx.path === '/api/youtube-dj/playlist') {
          ctx.status = 200;
          ctx.body = { ok: true, config: { activePlaylistId: '', playlists: [], playlistId: '', playlistUrl: '' } };
          ctx.type = 'application/json';
          return;
        }
      }
      ctx.status = 503;
      ctx.body = { ok: false, error: 'Player not yet discovered — waiting for mDNS' };
      ctx.type = 'application/json';
      
      // Fire-and-forget background discovery
      refreshPlayerHostAsync().catch(() => {});
      return;
    }
    
    if (myIps.has(targetHost) || targetHost === '127.0.0.1' || targetHost === '::1' || targetHost === 'localhost') {
      console.log(`[youtube-dj proxy] Target ${targetHost} is local — skipping proxy loop`);
      // Return stub responses since no upstream player is available
      if (ctx.path === '/api/youtube-dj/status' || ctx.path === '/api/youtube-dj/health') {
        ctx.status = 200;
        ctx.body = {
          ok: true,
          djActive: false,
          castConnected: false,
          captureReady: false,
          showActive: false,
          queueLength: 0,
          currentTitle: '',
          interstitialMessage: 'Deskreen Electron app is not running',
          lastPlaybackError: null,
          lastAdvanceReason: null,
          volumeLevel: 1,
          port: PORT,
          hostMode: 'direct',
          host: getLanIp(),
          youtubeSignedIn: false,
        };
      } else if (ctx.path === '/api/youtube-dj/now-playing') {
        ctx.status = 200;
        ctx.body = { title: '', videoId: '', currentTime: 0, duration: 0, state: -2 };
      } else if (ctx.path === '/api/youtube-dj/queue') {
        ctx.status = 200;
        ctx.body = { ok: true, queue: [], currentIndex: -1, playerState: -2 };
      } else if (ctx.path === '/api/youtube-dj/playlist') {
        ctx.status = 200;
        ctx.body = { ok: true, config: { activePlaylistId: '', playlists: [], playlistId: '', playlistUrl: '' } };
      } else if (ctx.path === '/api/youtube-dj/restart-show') {
        ctx.status = 200;
        ctx.body = { ok: true };
      } else {
        ctx.status = 200;
        ctx.body = { ok: false, error: 'Deskreen Electron app is not running' };
      }
      ctx.type = 'application/json';
      return;
    }

    // ── Fast-fail: if the S8 player has been unreachable recently, ──
    // skip the proxy entirely and serve stub/cached responses.
    // This prevents hung TCP connections from piling up when the
    // tablet is offline.
    if (playerRecentlyDown) {
      const downSec = Math.floor((Date.now() - playerDownSince) / 1000);
      // GET polling endpoints: serve stubs so the UI doesn't disconnect
      if (ctx.method === 'GET') {
        if (ctx.path === '/api/youtube-dj/health' || ctx.path === '/api/youtube-dj/status') {
          ctx.status = 200;
          ctx.body = { ok: true, djActive: false, castConnected: false, youtubeSignedIn: false, playerDown: true, playerDownSec: downSec };
          ctx.type = 'application/json';
          return;
        }
        if (ctx.path === '/api/youtube-dj/now-playing') {
          ctx.status = 200;
          ctx.body = { title: '', videoId: '', currentTime: 0, duration: 0, state: -2, playerDown: true };
          ctx.type = 'application/json';
          return;
        }
        if (ctx.path === '/api/youtube-dj/queue') {
          ctx.status = 200;
          ctx.body = { ok: true, queue: [], currentIndex: -1, playerState: -2 };
          ctx.type = 'application/json';
          return;
        }
      }
      // POST/DELETE mutations: fast-fail with a clear error
      // (don't queue up connections that will just time out)
      if (ctx.method === 'POST' || ctx.method === 'DELETE') {
        ctx.status = 503;
        ctx.body = { ok: false, error: 'Player unavailable — retry in ' + Math.max(0, Math.ceil((PLAYER_DOWN_COOLDOWN_MS - (Date.now() - playerDownSince)) / 1000)) + 's' };
        ctx.type = 'application/json';
        return;
      }
    }

    // ── Background: periodically refresh the player via mDNS ──
    // Only trigger if the cache is really stale (> 5 min), and never
    // on the request path — fire-and-forget in the background.
    const now = Date.now();
    if (!_mdnsPlayerHost || (now - _mdnsPlayerHost.at) > MDNS_PLAYER_TTL) {
      // Fire-and-forget — don't await, don't block the request
      refreshPlayerHostAsync().catch(() => {});
    }

    // Pre-emptively trigger download when the dashboard sends a video to the S8.
    const isPlayNow = ctx.method === 'POST' && (ctx.path.endsWith('/play-now') || ctx.path === '/api/youtube-dj/play-now');
    const isQueue = ctx.method === 'POST' && (ctx.path.endsWith('/queue') || ctx.path === '/api/youtube-dj/queue' || ctx.path === '/api/youtube-karaoke/queue');
    if ((isPlayNow || isQueue) && ctx.request.body && ctx.request.body.url) {
      const match = ctx.request.body.url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
      if (match) {
        const videoId = match[1];
        const mp4 = getVideoPath(videoId);
        if (!fs.existsSync(mp4)) {
          console.log('[proxy] Pre-emptively downloading video for S8: ' + videoId);
          downloadVideo(videoId).catch((e) => console.warn('[proxy] Pre-download failed: ' + e.message));
        }
        // Enrich the request body with the real song title from our library metadata
        // so the S8 marquee never shows a raw video ID
        if (!ctx.request.body.title) {
          try {
            const infoPath = path.join(getDownloadDir(videoId), videoId + '.info.json');
            if (!fs.existsSync(infoPath)) {
              // Try karaoke dir
              const altPath = path.join(LIBRARY_KARAOKE_DIR, videoId + '.info.json');
              if (fs.existsSync(altPath)) {
                const info = JSON.parse(fs.readFileSync(altPath, 'utf8'));
                if (info.title) ctx.request.body.title = info.title;
              }
            } else {
              const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
              if (info.title) ctx.request.body.title = info.title;
            }
          } catch {}
          // Fallback: check tags.json
          if (!ctx.request.body.title) {
            try {
              const tags = JSON.parse(fs.readFileSync(TAGS_PATH, 'utf8'));
              if (tags[videoId]?.title) ctx.request.body.title = tags[videoId].title;
            } catch {}
          }
        }
      }
    }

    await proxyYouTubeToPlayer(ctx);
    // Track consecutive proxy failures for ADB-based IP rediscovery.
    if (ctx.status === 502) {
      consecutiveProxyFails++;
      if (consecutiveProxyFails >= PLAYER_DOWN_THRESHOLD) {
        // Trigger async IP rediscovery (tablet IP may have changed)
        refreshPlayerHostAsync().catch(() => {});
        consecutiveProxyFails = 0;
      }
      // After 3 consecutive 502s, mark the player as down for fast-fail
      if (consecutiveProxyFails >= 3 && !playerRecentlyDown) {
        markPlayerDown();
      }
    } else if (ctx.status >= 200 && ctx.status < 500) {
      consecutiveProxyFails = 0;
      markPlayerUp();
    }
    return;
  }
  await next();
});

// ═══════════════════════════════════════════════════════════════
//  Library Module — local video download + metadata pipeline
// ═══════════════════════════════════════════════════════════════

// External drive with full video archive (8,000+ karaoke mp4s)
const EXTERNAL_DRIVE = '/Volumes/maxone';
const LIBRARY_DIR = path.join(EXTERNAL_DRIVE, 'Deskreen');
const LIBRARY_KARAOKE_DIR = path.join(LIBRARY_DIR, 'karaoke');
const LIBRARY_SONGS_DIR = path.join(LIBRARY_DIR, 'songs');
const DOWNLOADS_DIR = path.resolve(__dirname, '..', '..', '.deskreen', 'youtube-downloads');
const ARCHIVE_PATH = path.join(LIBRARY_DIR, 'youtube-download-archive.txt');
const TAGS_PATH = path.join(LIBRARY_DIR, 'tags.json');
const YT_DLP_PATH = '/opt/homebrew/bin/yt-dlp';

// All library directories to search for files (root + subdirectories)
const LIBRARY_SEARCH_DIRS = [LIBRARY_DIR, LIBRARY_KARAOKE_DIR, LIBRARY_SONGS_DIR];

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SCRIPTS_DIR = path.resolve(__dirname, '..', 'scripts');

fs.mkdirSync(LIBRARY_DIR, { recursive: true });
fs.mkdirSync(LIBRARY_KARAOKE_DIR, { recursive: true });
fs.mkdirSync(LIBRARY_SONGS_DIR, { recursive: true });

// Determine the download directory for a video based on its tag
function getDownloadDir(videoId) {
  const tags = loadTags();
  const tag = tags[videoId]?.tag;
  if (tag === 'karaoke') return LIBRARY_KARAOKE_DIR;
  if (tag === 'song' || tag === 'music') return LIBRARY_SONGS_DIR;
  return LIBRARY_DIR; // root for unclassified
}

// Search all library dirs for a file matching a predicate
function _findInLibraryDirs(predicate) {
  for (const dir of LIBRARY_SEARCH_DIRS) {
    try {
      if (!fs.existsSync(dir)) continue;
      const result = predicate(dir);
      if (result) return result;
    } catch (e) { /* ignore */ }
  }
  return null;
}

function getVideoPath(videoId) {
  // Search all library dirs (root + subdirs) for video file in any format
  const VIDEO_EXTS = ['.mp4', '.mkv', '.mp3', '.webm'];
  const found = _findInLibraryDirs((dir) => {
    for (const ext of VIDEO_EXTS) {
      const exact = path.join(dir, videoId + ext);
      if (fs.existsSync(exact)) return exact;
    }
    // Also check for files that start with videoId (handles yt-dlp format suffixes)
    try {
      const files = fs.readdirSync(dir);
      for (const ext of VIDEO_EXTS) {
        const match = files.find(f => f.startsWith(videoId) && f.endsWith(ext));
        if (match) return path.join(dir, match);
      }
    } catch (e) { /* ignore */ }
    return null;
  });
  if (found) return found;
  return path.join(LIBRARY_DIR, videoId + '.mp4'); // fallback expected path
}

function getInfoPath(videoId) {
  const found = _findInLibraryDirs((dir) => {
    const p = path.join(dir, videoId + '.info.json');
    if (fs.existsSync(p)) return p;
    return null;
  });
  if (found) return found;
  return path.join(LIBRARY_DIR, videoId + '.info.json'); // fallback expected path
}

function getThumbPath(videoId) {
  return _findInLibraryDirs((dir) => {
    const files = fs.readdirSync(dir);
    for (const ext of ['jpg', 'webp', 'png']) {
      const exact = path.join(dir, videoId + '.' + ext);
      if (fs.existsSync(exact)) return exact;
      const match = files.find(f => f.startsWith(videoId) && f.endsWith('.' + ext) && !f.includes('.vtt') && !f.includes('.info.'));
      if (match) return path.join(dir, match);
    }
    return null;
  });
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
  const files = [];
  for (const dir of LIBRARY_SEARCH_DIRS) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(videoId + '.') && f.endsWith('.vtt')) {
          const stripped = f.replace(videoId + '.', '').replace('.vtt', '');
          files.push({ lang: stripped, file: f, path: path.join(dir, f) });
        }
      }
    } catch (e) { /* ignore */ }
  }
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

    const outDir = getDownloadDir(videoId);
    const tagLabel = outDir === LIBRARY_KARAOKE_DIR ? 'karaoke' : outDir === LIBRARY_SONGS_DIR ? 'songs' : 'root';
    console.log('[library] Downloading video: ' + videoId + ' → ' + tagLabel);
    // No --download-archive on individual downloads — the archive is for
    // batch dedup. On-demand downloads must always fetch even if the mp4
    // was cleaned up since the last batch run.
    const proc = require('child_process').spawn(YT_DLP_PATH, [
      '-f', 'b[height<=1080]',
      '--merge-output-format', 'mp4',
      '--write-info-json',
      '--write-thumbnail',
      '--write-subs', '--sub-langs', 'all,-live_chat',
      '-o', path.join(outDir, '%(id)s.%(ext)s'),
      '--no-playlist',
      'https://www.youtube.com/watch?v=' + videoId,
    ], { timeout: 90000 });

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(mp4)) {
        console.log('[library] Download complete: ' + videoId);
        __libraryListCache = { ts: 0, data: null, rawJson: null, archiveMtime: 0 }; // invalidate list cache
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

// ── Song Request Queue ──
// Persisted via MySQL on Bluehost (karol.rideyrbike.com/db.php).
// Local cache for fast lookups; refreshed on startup and periodically.

let songRequestCache = {}; // videoId → requester_name (lazy-loaded)

async function getSongRequestMap() {
  try {
    const map = await mysql.requestMap();
    if (map) { songRequestCache = map; return map; }
  } catch (e) { console.error('[requests] MySQL fetch error:', e.message); }
  return songRequestCache || {};
}

// Pre-load on startup
getSongRequestMap();
// Refresh every 30 seconds (lightweight: just returns the map)
setInterval(() => { getSongRequestMap().catch(() => {}); }, 30000);

function proxyRequestToS8(videoId, forcePlayNow, requester, songTitle) {
  return new Promise((resolve, reject) => {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const bodyObj = { url };
    if (forcePlayNow) bodyObj.action = 'play-now';
    if (requester) bodyObj.requester = requester;
    if (songTitle) bodyObj.title = songTitle;
    const body = JSON.stringify(bodyObj);
    const reqOpts = {
      hostname: getPlayerHost(),
      port: getPlayerPort(),
      path: '/api/youtube-dj/queue',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
      family: 4,
      agent: playerAgent,
    };
    const req = http.request(reqOpts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ ok: true, body: JSON.parse(data) }); }
        catch { resolve({ ok: true, body: data }); }
      });
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

router.post('/api/queue/request', async (ctx) => {
  const body = ctx.request.body || {};
  let { videoId, name, title } = body;
  const url = body.url || '';
  const karaokeify = !!body.karaokeify;

  const cleanName = String(name || '').trim().substring(0, 40);
  if (!cleanName) {
    ctx.status = 400;
    ctx.body = { ok: false, error: 'name is required' };
    return;
  }

  // Custom URL flow: extract videoId from YouTube URL
  if (!videoId || videoId === '__custom__') {
    if (!url) {
      ctx.status = 400;
      ctx.body = { ok: false, error: 'videoId or YouTube URL is required' };
      return;
    }
    const match = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/|^)([a-zA-Z0-9_-]{11})/);
    if (!match) {
      ctx.status = 400;
      ctx.body = { ok: false, error: 'Invalid YouTube URL' };
      return;
    }
    videoId = match[1];
  }

  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    ctx.status = 400;
    ctx.body = { ok: false, error: 'invalid videoId' };
    return;
  }

  const cleanTitle = title ? String(title).trim().substring(0, 120) : '';

  // ── Karaoke custom URL: start the pipeline, return immediately ──
  if (karaokeify) {
    const karaokeId = videoId + '-karaoke';
    const karaokeMp4 = path.join(LIBRARY_KARAOKE_DIR, karaokeId + '.mp4');

    // Already made — add directly to S8 queue
    if (fs.existsSync(karaokeMp4)) {
      console.log(`[request] Karaoke exists for ${videoId}, adding to S8 queue`);
      mysql.requestAdd(karaokeId, cleanName, cleanTitle).catch(e => {});
      const playerHost = getPlayerHost();
      if (playerHost) {
        try {
          await proxyRequestToS8(karaokeId, false, cleanName, cleanTitle);
        } catch (e) {
          console.error(`[request] S8 proxy error for ${karaokeId}: ${e.message}`);
        }
      }
      ctx.body = { ok: true, videoId: karaokeId, requester: cleanName, karaokeify: true, queued: true };
      return;
    }

    // Already processing — return status
    if (karaokeJobs.has(videoId)) {
      const job = karaokeJobs.get(videoId);
      mysql.requestAdd(videoId, cleanName, cleanTitle).catch(e => {});
      ctx.body = { ok: true, videoId, requester: cleanName, karaokeify: true, status: job.status, progress: job.progress };
      return;
    }

    // Start the karaoke pipeline in the background — uses the same pipeline as POST /api/library/make-karaoke
    // but returns immediately so the user isn't blocked.
    karaokeJobs.set(videoId, { status: 'processing', progress: 0, requester: cleanName, cleanTitle });
    mysql.requestAdd(videoId, cleanName, cleanTitle).catch(e => {});

    const args = [path.join(PROJECT_ROOT, 'tools', 'make-karaoke-video.py'), url];
    if (body.artist) args.push('--artist', body.artist);
    if (body.title_karaoke) args.push('--title', body.title_karaoke);

    const proc = require('child_process').spawn('/opt/homebrew/bin/python3', args, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        console.log('[karaoke/req] ' + line);
        const m = line.match(/^\[\d+\.?\d*\] (\w+): (.+)$/);
        if (m) {
          const step = m[1];
          let p = 0;
          if (step === 'download') p = 15;
          else if (step === 'demucs') p = 35;
          else if (step === 'lyrics') p = 55;
          else if (step === 'render') p = 80;
          else if (step === 'library') p = 95;
          else if (step === 'complete') p = 100;
          else if (step === 'error') p = -1;
          const job = karaokeJobs.get(videoId);
          if (job) job.progress = p;
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      console.error('[karaoke/req:stderr] ' + chunk.toString().trim());
    });

    proc.on('close', async (code) => {
      if (code === 0) {
        karaokeJobs.set(videoId, { status: 'complete', progress: 100, karaokeVideoId: karaokeId });
        console.log('[karaoke/req] Complete: ' + videoId + ', adding to S8 queue');

        // Add the completed karaoke video to the S8 queue
        const playerHost = getPlayerHost();
        if (playerHost) {
          try {
            const job = karaokeJobs.get(videoId);
            await proxyRequestToS8(karaokeId, false, job?.requester || cleanName, job?.cleanTitle || cleanTitle);
            console.log('[karaoke/req] Added ' + karaokeId + ' to S8 queue');
          } catch (e) {
            console.error('[karaoke/req] S8 proxy error after render: ' + e.message);
          }
        }
      } else {
        karaokeJobs.set(videoId, { status: 'failed', progress: -1, error: 'Process exited with code ' + code });
        console.error('[karaoke/req] Failed: ' + videoId + ' (exit ' + code + ')');
      }
    });

    proc.on('error', (err) => {
      karaokeJobs.set(videoId, { status: 'failed', progress: -1, error: err.message });
      console.error('[karaoke/req] Spawn error: ' + err.message);
    });

    ctx.body = { ok: true, videoId, requester: cleanName, karaokeify: true, status: 'processing', progress: 0 };
    return;
  }

  // ── Standard (non-karaoke) request ──
  // Persist request to MySQL via Bluehost proxy (fire-and-forget, never blocks)
  mysql.requestAdd(videoId, cleanName, cleanTitle).catch(e => {
    console.error('[requests] MySQL add error:', e.message);
  });

  const playerHost = getPlayerHost();
  if (!playerHost) {
    console.log(`[request] Queued request from "${cleanName}" for ${videoId} — player not yet discovered, will proxy when ready`);
    ctx.status = 202;
    ctx.body = { ok: true, videoId, requester: cleanName, queued: true, playerReady: false };
    return;
  }

  // Proxy to S8 immediately — no blocking status check
  // S8 decides play-now vs queue-add on its own
  try {
    const result = await proxyRequestToS8(videoId, false, cleanName, cleanTitle);
    console.log(`[request] "${cleanName}" requested ${videoId} — added to S8 queue`);
    ctx.status = 200;
    ctx.body = { ok: true, videoId, requester: cleanName, queued: true, playerReady: true, s8Response: result.body };
  } catch (e) {
    console.error(`[request] Failed to proxy to S8 for "${cleanName}" / ${videoId}: ${e.message}`);
    ctx.status = 202;
    ctx.body = { ok: true, videoId, requester: cleanName, queued: true, playerReady: false, proxyError: e.message };
  }
});

router.get('/api/queue/request/list', async (ctx) => {
  const map = await getSongRequestMap();
  ctx.body = { ok: true, requestMap: map, count: Object.keys(map).length };
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
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    // Try lsof first (fast, local), fall back silently on failure
    execFile('lsof', ['-i', ':11000'], { timeout: 2000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' }, (err, stdout) => {
      if (err) {
        // lsof failed or returned non-zero — Ableton is not listening
        resolve(false);
        return;
      }
      resolve((stdout || '').includes('Live') || (stdout || '').includes('Ableton'));
    });
    // Safety: if execFile hangs (unlikely with SIGKILL), resolve false after timeout
    setTimeout(() => resolve(false), 2500);
  }).catch(() => false);
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
    { ...defaultTrack(1), name: 'Background Music', volume: 0.75 },
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
  setInterval(async () => {
    abletonConnected = await checkAbletonConnected();
    if (abletonConnected) {
      ensureOscSocket();
      queryTrackProperties();
    }
  }, 5000);
  // Initial check (async, fire-and-forget)
  checkAbletonConnected().then((connected) => {
    abletonConnected = connected;
    if (abletonConnected) {
      ensureOscSocket();
      setTimeout(queryTrackProperties, 1000);
    }
  });
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
  const { karaokeVol, karaokeMuted, musicVol, musicMuted, masterVol } = ctx.request.body || {};
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
  // Track 1 (Background Music)
  if (musicVol != null) {
    const v = Math.max(0, Math.min(1, musicVol));
    sendOsc('/live/track/set/volume', 1, v);
    ensureTrack(1).volume = v;
  }
  if (musicMuted != null) {
    sendOsc('/live/track/set/mute', 1, musicMuted ? 1 : 0);
    ensureTrack(1).muted = !!musicMuted;
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
router.get('/api/audio/devices', async (ctx) => {
  let umcPresent = false;
  let blackholePresent = false;
  let karolAggregate = false;
  let defaultOutput = '';
  let umcSampleRate = 0;

  // Use async execFile to avoid blocking the event loop
  const { execFile } = require('child_process');
  try {
    const out = await new Promise((resolve, reject) => {
      execFile('system_profiler', ['SPAudioDataType', '-json'], {
        timeout: 3000,
        maxBuffer: 1024 * 1024,
        killSignal: 'SIGKILL',
      }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
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
          name: 'Background Music',
          type: 'Audio',
          input: { device: 'BlackHole 2ch', channels: '3-4' },
          output: 'Master',
          description: 'Background music via BlackHole channels 3-4',
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
  };
});

// ── Library API endpoints ──

// Metadata: returns info.json data for a video. Triggers background download if not available.
router.get('/api/library/metadata/:videoId', async (ctx) => {
  const videoId = ctx.params.videoId;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}(-karaoke)?$/.test(videoId)) {
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

// Prioritize a video for immediate download (foreground priority)
router.post('/api/library/download-now', async (ctx) => {
  const { videoId } = ctx.request.body || {};
  if (!videoId || !/^[a-zA-Z0-9_-]{11}(-karaoke)?$/.test(videoId)) {
    ctx.status = 400; ctx.body = { ok: false, error: 'Invalid video ID' }; return;
  }
  const mp4 = getVideoPath(videoId);
  if (fs.existsSync(mp4)) {
    ctx.body = { ok: true, ready: true, id: videoId };
    return;
  }
  // Fire download immediately (foreground priority)
  downloadVideo(videoId).then(() => {
    console.log('[library] Priority download complete: ' + videoId);
  }).catch((e) => {
    console.warn('[library] Priority download failed: ' + e.message);
  });
  ctx.body = { ok: true, ready: false, downloading: true, id: videoId };
});

// ── Full-pipeline add-video: download + tag enrichment + cache invalidation ──
const downloadJobs = new Map(); // videoId -> { status: 'downloading'|'complete'|'failed', progress: 0, error?: string }

router.post('/api/library/add-video', async (ctx) => {
  const body = ctx.request.body || {};
  const url = body.url || '';
  const videoIdMatch = url.match(/(?:v=|youtu\.be\/|^)([a-zA-Z0-9_-]{11})/);
  if (!videoIdMatch) {
    ctx.status = 400; ctx.body = { ok: false, error: 'Invalid YouTube URL or video ID' }; return;
  }
  const videoId = videoIdMatch[1];

  const mp4 = getVideoPath(videoId);
  if (fs.existsSync(mp4)) {
    ctx.body = { ok: true, videoId, status: 'complete', message: 'Already downloaded' };
    return;
  }

  if (downloadJobs.has(videoId) && downloadJobs.get(videoId).status === 'downloading') {
    ctx.body = { ok: true, videoId, status: 'downloading', message: 'Download in progress' };
    return;
  }

  // Start background download
  downloadJobs.set(videoId, { status: 'downloading', progress: 0 });
  ctx.body = { ok: true, videoId, status: 'downloading', message: 'Download started' };

  (async () => {
    try {
      console.log('[library/add-video] Downloading: ' + videoId);
      await downloadVideo(videoId);

      // Add to download archive
      try {
        if (!fs.existsSync(path.dirname(ARCHIVE_PATH))) {
          fs.mkdirSync(path.dirname(ARCHIVE_PATH), { recursive: true });
        }
        const archiveContent = fs.existsSync(ARCHIVE_PATH)
          ? fs.readFileSync(ARCHIVE_PATH, 'utf8') : '';
        if (!archiveContent.includes('youtube ' + videoId)) {
          // Ensure trailing newline before appending
          const needsNewline = archiveContent.length > 0 && !archiveContent.endsWith('\n');
          fs.appendFileSync(ARCHIVE_PATH, (needsNewline ? '\n' : '') + 'youtube ' + videoId + '\n', 'utf8');
        }
      } catch (e) {
        console.warn('[library/add-video] Archive update warning: ' + e.message);
      }

      // Enrich tags from info.json
      try {
        const infoPath = getInfoPath(videoId);
        if (fs.existsSync(infoPath)) {
          const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
          const tags = loadTags();
          const existing = tags[videoId] || {};
          // Auto-detect karaoke vs music from title
          const title = (info.title || '').toLowerCase();
          const isKaraoke = /karaoke|instrumental|lyrics?|cover\b|backing.track|sing.along/i.test(title);
          const autoTag = existing.tag
            || (isKaraoke ? 'karaoke' : 'music');
          tags[videoId] = {
            tag: autoTag,
            year: existing.year || (info.upload_date ? info.upload_date.slice(0, 4) : ''),
            artist: existing.artist || (info.uploader || ''),
            source: existing.source || 'auto-info.json',
          };
          saveTags(tags);
          console.log('[library/add-video] Tag enriched: ' + videoId + ' (' + autoTag + ')');

          // Move files to correct subdirectory if they're in the library root
          const targetDir = autoTag === 'karaoke' ? LIBRARY_KARAOKE_DIR :
            (autoTag === 'song' || autoTag === 'music') ? LIBRARY_SONGS_DIR : LIBRARY_DIR;
          if (targetDir !== LIBRARY_DIR) {
            const rootFiles = [];
            try {
              if (fs.existsSync(LIBRARY_DIR)) {
                for (const f of fs.readdirSync(LIBRARY_DIR)) {
                  if (f.startsWith(videoId + '.') || f.startsWith(videoId + '-')) {
                    rootFiles.push(f);
                  }
                }
              }
            } catch (e) {}
            for (const fname of rootFiles) {
              const src = path.join(LIBRARY_DIR, fname);
              const dst = path.join(targetDir, fname);
              try {
                fs.renameSync(src, dst);
                console.log('[library/add-video] Moved ' + fname + ' → ' + path.relative(LIBRARY_DIR, targetDir) + '/');
              } catch (e) {
                console.warn('[library/add-video] Failed to move ' + fname + ': ' + e.message);
              }
            }
          }
        }
      } catch (e) {
        console.warn('[library/add-video] Tag enrichment warning: ' + e.message);
      }

      // Invalidate list cache
      __libraryListCache = { ts: 0, data: null, rawJson: null, archiveMtime: 0 };

      downloadJobs.set(videoId, { status: 'complete', progress: 100 });
      console.log('[library/add-video] Complete: ' + videoId);
    } catch (e) {
      downloadJobs.set(videoId, { status: 'failed', progress: -1, error: e.message });
      console.error('[library/add-video] Failed: ' + videoId + ' — ' + e.message);
    }
  })();
});

// Check download status
router.get('/api/library/download-status/:videoId', async (ctx) => {
  const videoId = ctx.params.videoId;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}(-karaoke)?$/.test(videoId)) {
    ctx.status = 400; ctx.body = { ok: false, error: 'Invalid videoId' }; return;
  }

  const job = downloadJobs.get(videoId);
  if (job) {
    ctx.body = { ok: true, videoId, status: job.status, progress: job.progress, error: job.error };
    return;
  }

  // Check if file exists on disk (was downloaded in a previous session)
  const mp4 = getVideoPath(videoId);
  ctx.body = {
    ok: true,
    videoId,
    status: fs.existsSync(mp4) ? 'complete' : 'not_found',
    progress: fs.existsSync(mp4) ? 100 : 0,
  };
});

// ── Karaoke Video Maker ──────────────────────────────────────────────
const karaokeJobs = new Map(); // videoId -> { status, progress, error?, karaokeVideoId? }

router.post('/api/library/make-karaoke', async (ctx) => {
  const body = ctx.request.body || {};
  const url = body.url || '';
  const artist = body.artist || '';
  const title = body.title || '';

  const videoIdMatch = url.match(/(?:v=|youtu\.be\/|embed\/|shorts\/|^)([a-zA-Z0-9_-]{11})/);
  if (!videoIdMatch) {
    ctx.status = 400; ctx.body = { ok: false, error: 'Invalid YouTube URL or video ID' }; return;
  }
  const videoId = videoIdMatch[1];

  // Check if already processing or complete
  if (karaokeJobs.has(videoId)) {
    const job = karaokeJobs.get(videoId);
    ctx.body = { ok: true, videoId, status: job.status, progress: job.progress, error: job.error };
    return;
  }

  // Check if already made
  const karaokeMp4 = path.join(LIBRARY_KARAOKE_DIR, videoId + '-karaoke.mp4');
  if (fs.existsSync(karaokeMp4)) {
    ctx.body = { ok: true, videoId, karaokeVideoId: videoId + '-karaoke', status: 'complete', progress: 100 };
    return;
  }

  // Start background job
  karaokeJobs.set(videoId, { status: 'processing', progress: 0 });

  // Build argument list for make-karaoke-video.py
  const args = [path.join(PROJECT_ROOT, 'tools', 'make-karaoke-video.py'), url];
  if (artist) args.push('--artist', artist);
  if (title) args.push('--title', title);

  const proc = require('child_process').spawn('/opt/homebrew/bin/python3', args, {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let lastProgress = 0;
  proc.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      console.log('[karaoke/make] ' + line);
      // Parse progress from structured log lines: "[TIMESTAMP] step: message"
      const match = line.match(/^\[\d+\.?\d*\] (\w+): (.+)$/);
      if (match) {
        const step = match[1];
        if (step === 'download') lastProgress = 15;
        else if (step === 'demucs') lastProgress = 35;
        else if (step === 'lyrics') lastProgress = 55;
        else if (step === 'render') lastProgress = 80;
        else if (step === 'library') lastProgress = 95;
        else if (step === 'complete') lastProgress = 100;
        else if (step === 'error') lastProgress = -1;
        const job = karaokeJobs.get(videoId);
        if (job) job.progress = lastProgress;
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    console.error('[karaoke/make:stderr] ' + chunk.toString().trim());
  });

  proc.on('close', (code) => {
    if (code === 0) {
      karaokeJobs.set(videoId, { status: 'complete', progress: 100, karaokeVideoId: videoId + '-karaoke' });
      console.log('[karaoke/make] Complete: ' + videoId + ' -> ' + videoId + '-karaoke');
    } else {
      karaokeJobs.set(videoId, { status: 'failed', progress: -1, error: 'Process exited with code ' + code });
      console.error('[karaoke/make] Failed: ' + videoId + ' (exit ' + code + ')');
    }
  });

  proc.on('error', (err) => {
    karaokeJobs.set(videoId, { status: 'failed', progress: -1, error: err.message });
    console.error('[karaoke/make] Spawn error: ' + err.message);
  });

  // Return immediately — client polls /status for progress
  ctx.body = { ok: true, videoId, status: 'processing', progress: 0 };
});

// Check karaoke job status
router.get('/api/library/make-karaoke/status/:videoId', async (ctx) => {
  const videoId = ctx.params.videoId;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}(-karaoke)?$/.test(videoId)) {
    ctx.status = 400; ctx.body = { ok: false, error: 'Invalid videoId' }; return;
  }

  const job = karaokeJobs.get(videoId);
  if (job) {
    ctx.body = { ok: true, videoId, status: job.status, progress: job.progress, error: job.error, karaokeVideoId: job.karaokeVideoId };
    return;
  }

  // Check if completed on disk
  const karaokeMp4 = path.join(LIBRARY_KARAOKE_DIR, videoId + '-karaoke.mp4');
  if (fs.existsSync(karaokeMp4)) {
    ctx.body = { ok: true, videoId, karaokeVideoId: videoId + '-karaoke', status: 'complete', progress: 100 };
  } else {
    ctx.body = { ok: true, videoId, status: 'not_found', progress: 0 };
  }
});

// ── Karaoke Lyrics (LRC JSON) for real-time overlay ──
router.get('/api/library/lyrics/:videoId', async (ctx) => {
  let videoId = ctx.params.videoId;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}(-karaoke)?$/.test(videoId)) {
    ctx.status = 400; ctx.body = { ok: false, error: 'Invalid videoId' }; return;
  }

  // Strip -karaoke suffix if present so we don't double it in candidate paths
  const baseId = videoId.replace(/-karaoke$/, '');

  // Try karaoke LRC first, then plain library, then songs
  const candidates = [
    path.join(LIBRARY_KARAOKE_DIR, baseId + '-karaoke.lrc.json'),
    path.join(LIBRARY_DIR, baseId + '.lrc.json'),
    path.join(LIBRARY_SONGS_DIR, baseId + '.lrc.json'),
    path.join(LIBRARY_KARAOKE_DIR, videoId + '.lrc.json'),      // exact match (handles non-standard naming)
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
        ctx.body = { ok: true, videoId, ...data };
        return;
      }
    } catch (e) { /* continue */ }
  }

  ctx.status = 404;
  ctx.body = { ok: false, error: 'No lyrics found', videoId };
});

// Serve mp4 file with Range header support for download resumption
// Stream a video — pipes yt-dlp directly to the S8 so ExoPlayer starts
// within seconds. No waiting for full download + transfer.
router.get('/api/library/stream/:videoId', async (ctx) => {
  const videoId = ctx.params.videoId;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}(-karaoke)?$/.test(videoId)) {
    ctx.status = 400; ctx.body = { ok: false, error: 'Invalid video ID' }; return;
  }
  const mp4 = getVideoPath(videoId);
  // If already cached (non-empty), serve from disk like /file
  if (fs.existsSync(mp4) && fs.statSync(mp4).size > 0) {
    const stat = fs.statSync(mp4);
    const range = ctx.req.headers.range;
    ctx.set('Accept-Ranges', 'bytes');
    ctx.set('Content-Type', 'video/mp4');
    ctx.set('Cache-Control', 'no-cache');
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      ctx.status = 206;
      ctx.set('Content-Range', 'bytes ' + start + '-' + end + '/' + stat.size);
      ctx.set('Content-Length', String(end - start + 1));
      ctx.body = fs.createReadStream(mp4, { start, end });
    } else {
      ctx.set('Content-Length', String(stat.size));
      ctx.body = fs.createReadStream(mp4);
    }
    return;
  }
  // Not cached — spawn yt-dlp and pipe directly to the client.
  // ExoPlayer progressive HTTP playback starts as soon as data arrives.
  console.log('[library] Streaming live: ' + videoId);

  ctx.respond = false;
  const res = ctx.res;
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-cache',
  });

  const proc = require('child_process').spawn(YT_DLP_PATH, [
    '-f', 'b[height<=1080]',
    '--merge-output-format', 'mp4',
    '-o', '-',
    '--no-playlist',
    '--no-progress',
    'https://www.youtube.com/watch?v=' + videoId,
  ], { timeout: 300000 });

  let aborted = false;
  res.on('close', () => { aborted = true; proc.kill('SIGTERM'); });
  res.on('finish', () => { aborted = true; proc.kill('SIGTERM'); });

  proc.stdout.pipe(res);

  // Also save the data to disk for future cache hits
  const ws = fs.createWriteStream(mp4);
  proc.stdout.pipe(ws);

  proc.on('close', (code) => {
    ws.end();
    if (!aborted && code !== 0) console.error('[library] Stream exit ' + code + ' for ' + videoId);
    else if (!aborted) console.log('[library] Stream cache saved: ' + videoId);
  });
  proc.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg && !msg.includes('[download]')) console.error('[library] Stream: ' + msg);
  });
});

router.get('/api/library/file/:videoId', async (ctx) => {
  const videoId = ctx.params.videoId;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}(-karaoke)?$/.test(videoId)) {
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
  if (!videoId || !/^[a-zA-Z0-9_-]{11}(-karaoke)?$/.test(videoId)) {
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
  // Search all library dirs for the subtitle file
  let filePath = null;
  for (const dir of LIBRARY_SEARCH_DIRS) {
    const candidate = path.join(dir, videoId + '.' + lang + '.vtt');
    if (fs.existsSync(candidate)) { filePath = candidate; break; }
  }
  if (!filePath) {
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
// Uses a forked subprocess for the heavy filesystem scan so the
// main Node.js event loop stays responsive during ~20s of sync I/O.
let __libraryListCache = { ts: 0, data: null, rawJson: null, archiveMtime: 0 };
const LIBRARY_LIST_CACHE_MS = 3600_000;  // 1 hour — serves from in-memory cache
let __libraryScanInFlight = null;
const CACHE_FILE = '/tmp/karol-library-cache.json';

function tryLoadCacheFromDisk() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return false;
    const rawJson = fs.readFileSync(CACHE_FILE, 'utf8');
    const result = JSON.parse(rawJson);
    if (result && result.ok) {
      __libraryListCache = { ts: Date.now(), data: result, rawJson, archiveMtime: result.archiveMtime || 0 };
      console.log('[library] Loaded from disk: ' + result.count + ' videos');
      return true;
    }
  } catch (e) { console.error('[library] Failed to load cache from disk:', e.message); }
  return false;
}

function buildLibraryCache() {
  if (__libraryScanInFlight) return __libraryScanInFlight;
  __libraryScanInFlight = new Promise((resolve) => {
    const { execFile } = require('child_process');
    const worker = execFile(process.execPath, [path.resolve(__dirname, 'library-scan-worker.js'), ARCHIVE_PATH, LIBRARY_DIR, DOWNLOADS_DIR, TAGS_PATH], {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    }, async (err, stdout, stderr) => {
      if (stderr) console.error('[library] Worker stderr:', stderr.trim());
      let rawJson = null;
      try { rawJson = await fs.promises.readFile(CACHE_FILE, 'utf8'); } catch (e) { console.error('[library] Read cache file:', e.message); }
      let result = null;
      try { result = rawJson ? JSON.parse(rawJson) : null; } catch (e) { console.error('[library] Parse error:', e.message); }
      if (result && result.ok) {
        // Store the pre-serialized JSON string to avoid re-stringifying on every request
        __libraryListCache = { ts: Date.now(), data: result, rawJson, archiveMtime: result.archiveMtime || 0 };
        console.log('[library] Cache built: ' + result.count + ' videos');
      } else {
        console.error('[library] Worker failed:', err ? err.message : 'no result');
      }
      __libraryScanInFlight = null;
      resolve(result);
    });
  });
  return __libraryScanInFlight;
}

router.get('/api/library/list', async (ctx) => {
  const now = Date.now();
  let archiveChanged = false;
  try { archiveChanged = (await fs.promises.stat(ARCHIVE_PATH)).mtimeMs > __libraryListCache.archiveMtime; } catch (e) {}
  if ((!__libraryListCache.rawJson) || now - __libraryListCache.ts >= LIBRARY_LIST_CACHE_MS || archiveChanged) {
    tryLoadCacheFromDisk();
  }
  if (!__libraryListCache.data) {
    ctx.status = 500;
    ctx.body = '{"ok":false,"error":"Cache not available — run library scan separately"}';
    return;
  }

  // Client-side search params — filter server-side for speed
  const q = (ctx.query.q || '').toLowerCase();
  const year = ctx.query.year || '';
  const page = parseInt(ctx.query.page, 10) || 0;
  const limit = parseInt(ctx.query.limit, 10) || 0;

  if (!q && !year && !page && !limit) {
    // Fast path: return full cached JSON (compressed by middleware)
    ctx.type = 'application/json';
    ctx.body = __libraryListCache.rawJson;
    return;
  }

  // Filtered/paginated path: work from the parsed data
  const allVideos = __libraryListCache.data.videos || [];
  let videos = allVideos;
  if (q) {
    videos = videos.filter(v =>
      (v.title || '').toLowerCase().includes(q) ||
      (v.artist || '').toLowerCase().includes(q) ||
      String(v.year || '').includes(q)
    );
  }
  if (year) {
    videos = videos.filter(v => String(v.year) === year);
  }
  const total = videos.length;
  if (limit > 0) {
    const start = (page - 1) * limit;
    videos = videos.slice(start, start + limit);
  }

  ctx.type = 'application/json';
  ctx.body = JSON.stringify({
    ok: true,
    count: total,
    page: page || 1,
    limit: limit || total,
    videos,
  });
});

// Scan summary
router.get('/api/library/scan', async (ctx) => {
  try {
    // Count mp4s across both directories — use async I/O to avoid blocking the event loop
    let totalMp4Files = 0;
    let totalSize = 0;
    const langSet = new Set();

    for (const dir of [LIBRARY_DIR, LIBRARY_KARAOKE_DIR, LIBRARY_SONGS_DIR, DOWNLOADS_DIR]) {
      try { await fs.promises.access(dir); } catch (e) { continue; }
      const files = await fs.promises.readdir(dir);
      for (const f of files) {
        if (f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.mp3') || f.endsWith('.webm')) {
          totalMp4Files++;
          try {
            const stat = await fs.promises.stat(path.join(dir, f));
            totalSize += stat.size;
          } catch (e) { /* skip files that disappear mid-scan */ }
        }
        if (f.endsWith('.vtt')) {
          const parts = f.split('.');
          if (parts.length >= 3) langSet.add(parts[parts.length - 2]);
        }
      }
    }

    let archiveCount = 0;
    try {
      const archiveData = await fs.promises.readFile(ARCHIVE_PATH, 'utf8');
      archiveCount = archiveData.split('\n').filter(Boolean).length;
    } catch (e) {}

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

// ── Delete a video from the library ──
router.delete('/api/library/video/:videoId', async (ctx) => {
  const videoId = ctx.params.videoId;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}(-karaoke)?$/.test(videoId)) {
    ctx.status = 400; ctx.body = { ok: false, error: 'Invalid video ID' }; return;
  }

  const deleted = { mp4: false, info: false, subs: 0 };
  const errors = [];

  // Delete .mp4 file (handles yt-dlp format suffixes)
  const mp4Path = getVideoPath(videoId);
  if (mp4Path && fs.existsSync(mp4Path)) {
    try { fs.unlinkSync(mp4Path); deleted.mp4 = true; } catch (e) { errors.push('mp4: ' + e.message); }
  }
  // Also check DOWNLOADS_DIR for the mp4
  const dlMp4 = path.join(DOWNLOADS_DIR, videoId + '.mp4');
  if (fs.existsSync(dlMp4)) {
    try { fs.unlinkSync(dlMp4); deleted.mp4 = true; } catch (e) { errors.push('dl-mp4: ' + e.message); }
  }

  // Delete .info.json
  const infoPath = getInfoPath(videoId);
  if (fs.existsSync(infoPath)) {
    try { fs.unlinkSync(infoPath); deleted.info = true; } catch (e) { errors.push('info: ' + e.message); }
  }

  // Delete .vtt subtitle files
  const subs = getSubtitleFiles(videoId);
  for (const s of subs) {
    try { fs.unlinkSync(s.path); deleted.subs++; } catch (e) { errors.push('sub: ' + e.message); }
  }

  // Remove from download archive
  try {
    if (fs.existsSync(ARCHIVE_PATH)) {
      const lines = fs.readFileSync(ARCHIVE_PATH, 'utf8').split('\n');
      const filtered = lines.filter((l) => {
        const trimmed = l.trim();
        if (!trimmed) return false;
        return !trimmed.includes(videoId);
      });
      fs.writeFileSync(ARCHIVE_PATH, filtered.join('\n') + (filtered.length > 0 ? '\n' : ''), 'utf8');
    }
  } catch (e) { errors.push('archive: ' + e.message); }

  // Remove from tags
  try {
    const tags = loadTags();
    if (tags[videoId]) {
      delete tags[videoId];
      saveTags(tags);
    }
  } catch (e) { errors.push('tags: ' + e.message); }

  // Invalidate library list cache
  __libraryListCache = { ts: 0, data: null, rawJson: null, archiveMtime: 0 };

  console.log(`[library] Deleted video ${videoId}: mp4=${deleted.mp4} info=${deleted.info} subs=${deleted.subs}${errors.length ? ' errors=' + errors.join('; ') : ''}`);

  ctx.body = {
    ok: true,
    videoId,
    deleted,
    ...(errors.length ? { warnings: errors } : {}),
  };
});

// ── Tag system (karaoke / music video) ──
// Primary storage: MySQL (Bluehost). Local JSON is kept in sync for the scan worker
// and as offline cache. read = JSON, write = MySQL + JSON.
function loadTags() {
  try {
    if (fs.existsSync(TAGS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(TAGS_PATH, 'utf8'));
      const normalized = {};
      for (const [vid, val] of Object.entries(raw)) {
        if (typeof val === 'string') {
          normalized[vid] = { tag: val, year: '', artist: '', source: '' };
        } else if (val && typeof val === 'object') {
          normalized[vid] = {
            tag: val.tag || val.type || 'music',
            year: val.year || '',
            artist: val.artist || '',
            source: val.source || ''
          };
        }
      }
      return normalized;
    }
  } catch (e) { console.error('[library/tags] load error:', e.message); }
  // Auto-recover: if tags.json is empty or has < 10 entries, rebuild from disk
  // (delayed to avoid blocking startup; tags will be enriched asynchronously)
  const tags = {};
  if (!_rebuildTagsInFlight) {
    try {
      // Check archive count for comparison
      let archiveCount = 0;
      try {
        if (fs.existsSync(ARCHIVE_PATH)) {
          archiveCount = fs.readFileSync(ARCHIVE_PATH, 'utf8').split('\n').filter(Boolean).length;
        }
      } catch (_) {}
      if (archiveCount > 10 && _rebuildTagsInFlight === null) {
        // Trigger rebuild in background (don't await - let loadTags return empty)
        setTimeout(() => rebuildTagsFromDisk(), 5000);
      }
    } catch (_) {}
  }
  return tags;
}

function saveTags(tags) {
  try {
    fs.writeFileSync(TAGS_PATH, JSON.stringify(tags, null, 2), 'utf8');
  } catch (e) { console.error('[library/tags] save error:', e.message); }
}

// Rebuild tags.json from info.json files on disk.
// Called automatically when tags.json is empty or has far fewer entries
// than the download archive (data loss recovery).
let _rebuildTagsInFlight = null;
function rebuildTagsFromDisk() {
  if (_rebuildTagsInFlight) return _rebuildTagsInFlight;
  _rebuildTagsInFlight = (async () => {
    const startTime = Date.now();
    console.log('[library/tags] Rebuilding tags.json from info.json files ...');
    try {
      const tags = loadTags();
      let added = 0;
      // Scan all library search dirs for info.json files
      for (const dir of LIBRARY_SEARCH_DIRS) {
        try {
          if (!fs.existsSync(dir)) continue;
          const files = fs.readdirSync(dir);
          for (const f of files) {
            if (!f.endsWith('.info.json') || f.startsWith('._')) continue;
            const videoId = f.replace('.info.json', '');
            if (tags[videoId]) continue; // already tagged
            try {
              const info = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
              const title = (info.title || '').toLowerCase();
              const isKaraoke = /karaoke|instrumental|lyrics?|cover\b|backing.track|sing.along/i.test(title)
                || videoId.endsWith('-karaoke')
                || dir.includes('karaoke');
              const isSong = dir.includes('songs');
              const autoTag = isKaraoke ? 'karaoke' : (isSong ? 'music' : 'music');
              tags[videoId] = {
                tag: autoTag,
                year: (info.upload_date || '').slice(0, 4),
                artist: info.uploader || '',
                source: 'rebuilt-from-info.json'
              };
              added++;
            } catch (e) { /* skip corrupted info.json */ }
          }
        } catch (e) { /* skip unreadable dirs */ }
      }
      if (added > 0) {
        saveTags(tags);
        console.log(`[library/tags] Rebuilt ${added} entries in ${Date.now() - startTime}ms (total: ${Object.keys(tags).length})`);
        // Invalidate library cache so next request picks up new tags
        __libraryListCache = { ts: 0, data: null, rawJson: null, archiveMtime: 0 };
      } else {
        console.log('[library/tags] No new entries to rebuild');
      }
    } catch (e) {
      console.error('[library/tags] Rebuild failed:', e.message);
    } finally {
      _rebuildTagsInFlight = null;
    }
  })();
  return _rebuildTagsInFlight;
}

// Sync tags to MySQL (deferred background task, avoid blocking startup)
// The migration script already synced everything; this catches any writes
// that happened while the server was down.
let _tagsSyncScheduled = false;
function scheduleTagsSyncToMySQL() {
  if (_tagsSyncScheduled) return;
  _tagsSyncScheduled = true;
  setTimeout(async () => {
    try {
      const remoteCounts = await mysql.tagCountByTag();
      const remoteTotal = Object.values(remoteCounts || {}).reduce((a, b) => a + b, 0);
      const local = loadTags();
      const localTotal = Object.keys(local).length;
      if (Math.abs(localTotal - remoteTotal) < 50) {
        console.log(`[library/tags] MySQL already in sync (${remoteTotal} remote, ${localTotal} local)`);
        return;
      }
      console.log(`[library/tags] Syncing ${localTotal} tags to MySQL (${remoteTotal} remote)...`);
      let count = 0;
      for (const [vid, meta] of Object.entries(local)) {
        try {
          await mysql.tagSet(vid, meta.tag || 'music', meta.artist || '', meta.year || '', meta.source || '');
          count++;
        } catch (e) { /* skip */ }
        // Yield every 50 writes to avoid flooding the event loop
        if (count % 50 === 0) await new Promise(r => setTimeout(r, 100));
      }
      console.log(`[library/tags] Synced ${count} tags to MySQL`);
    } catch (e) { console.error('[library/tags] MySQL sync error:', e.message); }
  }, 30_000); // 30-second delay after startup
}

// On startup, schedule a deferred sync (auto-detects if needed)
scheduleTagsSyncToMySQL();

// Manual trigger to rebuild tags from info.json files
router.post('/api/library/tags/rebuild', async (ctx) => {
  rebuildTagsFromDisk();
  ctx.body = { ok: true, message: 'Tags rebuild started' };
});

router.get('/api/library/tags', async (ctx) => {
  ctx.body = { ok: true, tags: loadTags() };
});

router.post('/api/library/tags', async (ctx) => {
  const body = ctx.request.body || {};
  const videoId = body.videoId;
  const tag = body.tag;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}(-karaoke)?$/.test(videoId)) {
    ctx.status = 400; ctx.body = { ok: false, error: 'Invalid videoId' }; return;
  }
  if (!tag || (tag !== 'karaoke' && tag !== 'music' && tag !== 'song')) {
    ctx.status = 400; ctx.body = { ok: false, error: 'tag must be "karaoke", "music", or "song"' }; return;
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
  // Sync to MySQL asynchronously
  mysql.tagSet(videoId, tag, body.artist || '', body.year || '', body.source || '').catch(e => {
    console.error('[library/tags] MySQL write error:', e.message);
  });
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
        '--write-subs', '--write-auto-subs', '--sub-langs', 'all,-live_chat',
        '--download-archive', ARCHIVE_PATH,
        '--limit-rate', '3M',
        '--sleep-interval', '5',
        '--max-sleep-interval', '15',
        '-o', path.join(LIBRARY_DIR, '%(id)s.%(ext)s'),
        '--yes-playlist',
        'https://www.youtube.com/playlist?list=' + playlistId,
      ], { timeout: 600000 });

      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        console.log('[library] Batch download finished for ' + playlistId + ' (code ' + code + ')');
        __libraryListCache = { ts: 0, data: null, rawJson: null, archiveMtime: 0 }; // invalidate list cache
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
const libraryDashboardDir = path.resolve(__dirname, '..', 'library-dashboard');
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
const abletonMixerDir = path.resolve(__dirname, '..', 'ableton-mixer');
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
const djDistDir = path.resolve(__dirname, '..', 'dj-controller', 'dist');
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
  const { exec } = require('child_process');
  const binPath = path.resolve(__dirname, '..', 'scripts', 'blackhole-44100');
  if (!fs.existsSync(binPath)) {
    console.log('[blackhole-sr] Swift binary not found at ' + binPath + ' (run: swiftc -o scripts/blackhole-44100 scripts/blackhole-44100.swift)');
    return;
  }
  exec(binPath, { timeout: 5000 }, (err, stdout, stderr) => {
    if (err) {
      console.warn('[blackhole-sr] Failed: ' + (stderr || err.message).trim());
    } else {
      console.log('[blackhole-sr] ' + stdout.trim());
    }
  });
}

// ── Set Karol as macOS default output device ──
// Sets the Karol aggregate device as the system default output so audio
// routes correctly through BlackHole → Ableton → UMC404HD.
// This Swift binary sets Karol (Multi-Output: BlackHole 2ch + UMC404HD) as default.
function setDefaultAudioOutput() {
  const { exec } = require('child_process');
  const binPath = path.resolve(__dirname, '..', 'scripts', 'set-default-karol');
  if (!fs.existsSync(binPath)) {
    console.warn('[audio-default] Binary not found: ' + binPath);
    return;
  }
  exec(binPath, { timeout: 5000 }, (err, stdout, stderr) => {
    if (err) {
      console.warn('[audio-default] Failed: ' + (stderr || err.message).trim());
    } else {
      console.log('[audio-default] ' + stdout.trim());
    }
  });
}

// ── Audio chain verification: confirms the Karol aggregate device,
// BlackHole, and UMC404HD are present and Karol is the default output.
// Runs once at startup; results are logged for diagnosis but the server
// stays up regardless — the user can fix audio config later. ──
function verifyAudioChain() {
  const { exec } = require('child_process');
  exec('system_profiler SPAudioDataType', { timeout: 5000, encoding: 'utf8' }, (err, text) => {
    if (err) {
      console.warn('[audio-check] Failed: ' + err.message);
      return;
    }
    const hasKarol = /^\s*Karol:\s*$/m.test(text);
    const hasBlackHole = /BlackHole\s*2ch/i.test(text);
    const hasUMC = /UMC404/i.test(text);
    const isDefaultNo = /^\s*Default Output Device:\s*No\s*$/m;
    // Check if Karol block has Default Output Device: Yes
    const afterKarol = text.split(/^\s*Karol:\s*$/m)[1] || '';
    const defaultInBlock = /^\s*Default Output Device:\s*Yes\s*$/m.test(afterKarol.split(/^\S/m)[0] || afterKarol);

    if (hasKarol) console.log('[audio-check] Karol aggregate device: present');
    else console.warn('[audio-check] Karol aggregate device: MISSING');
    if (hasBlackHole) console.log('[audio-check] BlackHole 2ch: present');
    else console.warn('[audio-check] BlackHole 2ch: MISSING');
    if (hasUMC) console.log('[audio-check] UMC404HD: present');
    else console.warn('[audio-check] UMC404HD: MISSING');
    if (defaultInBlock) console.log('[audio-check] Karol is default output: yes');
    else console.warn('[audio-check] Karol is default output: NO');
  });
}

// ── UMC404HD volume lock: macOS volume keys can accidentally turn down
// the UMC master volume, killing the DAW return level (post-mix quiet).
// Lock it to 100% on every startup so the PA always gets full signal.
// Uses osascript (rock-solid, never crashes) instead of Swift exec. ──
function lockUmcVolume() {
  const { exec } = require('child_process');
  exec(
    `osascript -e 'set volume output volume 100'`,
    { timeout: 5000 },
    (err, stdout, stderr) => {
      if (err) console.warn('[umc-volume] Failed to lock: ' + (stderr || err.message).trim());
      else console.log('[umc-volume] System volume locked to 100%');
    }
  );
}

// ── Ableton auto-launch: opens the Karol template if Ableton isn't
// already running. Fire-and-forget — the audio announcement doesn't wait. ──
function launchAbletonIfNotRunning() {
  const { execFile, spawn } = require('child_process');

  const template = path.join(os.homedir(), 'Music', 'Ableton', 'User Library', 'Templates', 'Karol Live Set.als');
  if (!fs.existsSync(template)) {
    console.warn('[ableton] Template not found: ' + template);
    return;
  }

  // Check if Ableton is running (async, non-blocking)
  execFile('pgrep', ['-x', 'Live'], { timeout: 2000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' }, (err, stdout) => {
    if (!err && (stdout || '').trim()) {
      console.log('[ableton] Already running (pid ' + (stdout || '').trim().split('\n')[0] + ') — skipping launch');
      return;
    }
    // Not running — launch
    console.log('[ableton] Launching with Karol template...');
    const ableton = spawn('open', [
      '-a', 'Ableton Live 11 Suite',
      template,
    ], { stdio: 'ignore', detached: true });
    ableton.unref();
    ableton.on('error', (err) => {
      console.warn('[ableton] Failed: ' + err.message);
    });
  });
}

const server = http.createServer(app.callback());
server.maxConnections = 200;  // Prevent connection starvation from Firefox polling
server.timeout = 10000;       // Kill idle connections after 10s
server.keepAliveTimeout = 8000;
server.headersTimeout = 6000; // Don't wait forever for headers
server.requestTimeout = 60000; // 60s — library list response is ~1.1MB, needs time over network

// Connection tracking for health endpoint
server.on('connection', (socket) => {
  activeConnections++;
  if (activeConnections > peakConnections) peakConnections = activeConnections;
  socket.on('close', () => { activeConnections = Math.max(0, activeConnections - 1); });
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log('Karol API online at http://0.0.0.0:' + PORT);
  console.log('  YouTube DJ proxy target: mDNS-discovered');
  console.log('  Ableton, Hardware mixer routes ready');
  alignBlackHoleSampleRate();
  setDefaultAudioOutput();  // Set Karol as default output device
  tryLoadCacheFromDisk();  // Load pre-built cache if available, avoids re-scanning
  // Auto-recover tags.json if it was lost (deferred to avoid blocking startup)
  try {
    const tags = loadTags();
    let archiveCount = 0;
    try {
      if (fs.existsSync(ARCHIVE_PATH)) {
        archiveCount = fs.readFileSync(ARCHIVE_PATH, 'utf8').split('\n').filter(Boolean).length;
      }
    } catch (_) {}
    if (archiveCount > 10 && Object.keys(tags).length < archiveCount * 0.1) {
      console.log('[startup] Tags.json has ' + Object.keys(tags).length + ' entries but archive has ' + archiveCount + ' — rebuilding from info.json files ...');
      rebuildTagsFromDisk();
    }
  } catch (_) {}
  // Seed mDNS player cache from persisted file for instant cold-start connectivity
  try {
    const cached = fs.readFileSync('/tmp/karol-player-mdns.txt', 'utf8').trim();
    if (cached && cached.length > 3 && !_mdnsPlayerHost) {
      _mdnsPlayerHost = { host: cached, port: 3131, at: Date.now() };
      console.log('[mdns] Seeded player cache from disk: ' + cached);
      // Refresh in background so we get the current IP for the .local hostname
      refreshPlayerHostAsync().catch(() => {});
    }
  } catch {}
  startAbletonPoll();
  startMdnsBroadcaster(getLanIp());

  // Async mDNS player discovery — fire-and-forget, never block startup
  refreshPlayerHostAsync().then((ip) => {
    if (ip) console.log('[startup] Initial mDNS discovery: ' + ip);
    else console.warn('[startup] Could not discover player via mDNS — will retry on proxy request');
  });
  // verifyAudioChain();  // DISABLED — system_profiler hangs and kills server
  // Fire-and-forget: pre-build video library cache in a forked subprocess
  // so the first API request doesn't have to wait 20+ seconds for the scan.
  // Now lazy: buildLibraryCache() called on first /api/library/list request.
  // buildLibraryCache().catch(() => {});  // DISABLED — execFile kills server on macOS 26
  // Fire-and-forget Ableton launch
  launchAbletonIfNotRunning();

  // ── Audio cue: announce readiness via macOS 'say' ──
  const parts = [];
  // Include library info from the pre-loaded disk cache
  let videoCount = 0;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      videoCount = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')).count || 0;
    }
  } catch {}
  if (videoCount) {
    parts.push(videoCount + ' videos in library');
  }

  const announcement = 'Karol server is running. ' + (parts.length ? parts.join('. ') + '.' : '');
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
