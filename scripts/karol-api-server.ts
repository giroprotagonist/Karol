#!/usr/bin/env tsx
import http from 'http';
import Koa from 'koa';
import cors from 'kcors';
import Router from 'koa-router';
import bodyParser from 'koa-bodyparser';
import fs from 'fs';
import path from 'path';
import os from 'os';

const PORT = 3131;
const app = new Koa();
const router = new Router();
app.use(cors());
app.use(bodyParser());

const VLC_AUTH = 'Basic ' + Buffer.from(':karol').toString('base64');

function vlcGet(endpoint: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http.get({
      hostname: '127.0.0.1', port: 8080, path: endpoint,
      headers: { Authorization: VLC_AUTH },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    }).on('error', reject);
  });
}

function findCoverPath(filePath: string): string | null {
  if (!filePath) return null;
  const dir = path.dirname(filePath);
  const candidates = ['cover.jpg', 'cover.png', 'folder.jpg', 'albumart.jpg', 'artwork.jpg'];
  for (const c of candidates) {
    const p = path.join(dir, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

router.get('/api/vlc-dj/health', async (ctx) => {
  ctx.body = { ok: true, vlcAvailable: true, hardwareAvailable: true };
});

router.get('/api/vlc-dj/now-playing', async (ctx) => {
  try {
    const d = await vlcGet('/requests/status.json');
    if (!d) { ctx.body = { title: '', artist: '', album: '', duration: 0, position: 0 }; return; }
    const meta = d.information?.category?.meta || {};
    let fullPath = '';
    if (d.currentplid != null) {
      const pl = await vlcGet('/requests/playlist.json');
      if (pl) {
        const items = (pl.children?.[0]?.children || []) as any[];
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
      coverUrl: fullPath ? `/api/vlc-dj/cover?path=${encodeURIComponent(fullPath)}` : undefined,
    };
  } catch { ctx.body = { title: '', artist: '', album: '', duration: 0, position: 0 }; }
});

router.get('/api/vlc-dj/playlist', async (ctx) => {
  try {
    const [pl, st] = await Promise.all([
      vlcGet('/requests/playlist.json'),
      vlcGet('/requests/status.json'),
    ]);
    const items = (pl?.children?.[0]?.children || []) as any[];
    const tracks = items.map((item: any, i: number) => {
      const uri = String(item.uri || '');
      const fullPath = uri.startsWith('file://') ? decodeURIComponent(uri.replace('file://', '')) : String(item.name || '');
      const coverPath = findCoverPath(fullPath);
      return {
        id: String(item.id || i),
        name: String(item.name || `Track ${i + 1}`),
        uri,
        duration: typeof item.duration === 'number' ? item.duration : undefined,
        coverUrl: coverPath ? `/api/vlc-dj/cover?path=${encodeURIComponent(fullPath)}` : undefined,
      };
    });
    const cid = Number(st?.currentplid);
    const currentIndex = !isNaN(cid) ? tracks.findIndex((t: any) => Number(t.id) === cid) : -1;
    ctx.body = { tracks, currentIndex };
  } catch { ctx.body = { tracks: [], currentIndex: -1 }; }
});

router.get('/api/vlc-dj/cover', async (ctx) => {
  const fp = ctx.query.path as string;
  if (!fp) { ctx.status = 400; return; }
  const coverPath = findCoverPath(fp);
  if (!coverPath) { ctx.status = 404; return; }
  ctx.type = path.extname(coverPath) === '.png' ? 'image/png' : 'image/jpeg';
  ctx.body = fs.createReadStream(coverPath);
});

router.get('/api/vlc-dj/library', async (ctx) => {
  const musicDir = path.join(os.homedir(), 'Music');
  const tracks: any[] = [];
  try {
    const walk = (dir: string, depth: number) => {
      if (depth > 4) return;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full, depth + 1);
          else if (/\.(mp3|flac|wav|m4a|aiff|ogg)$/i.test(entry.name)) {
            const cp = findCoverPath(full);
            tracks.push({
              title: path.basename(full, path.extname(full)), path: full,
              artist: path.basename(path.dirname(path.dirname(full))) || '',
              album: path.basename(path.dirname(full)) || '', duration: 0,
              coverUrl: cp ? `/api/vlc-dj/cover?path=${encodeURIComponent(full)}` : undefined,
            });
          }
        }
      } catch { /* skip */ }
    };
    walk(musicDir, 0);
  } catch { /* skip */ }
  ctx.body = { tracks };
});

router.get('/api/vlc-dj/status', async (ctx) => {
  try {
    const d = await vlcGet('/requests/status.json');
    ctx.body = { state: d?.state || 'stopped', volume: d?.volume || 0, time: d?.time || 0, length: d?.length || 0 };
  } catch { ctx.body = { state: 'stopped', volume: 0, time: 0, length: 0 }; }
});

// Ableton API routes (stubs until AbletonOSC installed)
router.get('/api/ableton/health', (ctx) => { ctx.body = { ok: true, connected: false }; });
router.get('/api/ableton/state', (ctx) => { ctx.body = { ok: true, connected: false, playing: false, tempo: 120, tracks: [], masterVolume: 0.85 }; });
router.post('/api/ableton/transport/play', (ctx) => { ctx.body = { ok: true }; });
router.post('/api/ableton/transport/stop', (ctx) => { ctx.body = { ok: true }; });
router.post('/api/ableton/track/:i/volume', (ctx) => { ctx.body = { ok: true }; });
router.post('/api/ableton/track/:i/mute', (ctx) => { ctx.body = { ok: true }; });
router.post('/api/ableton/master/volume', (ctx) => { ctx.body = { ok: true }; });
router.post('/api/ableton/tempo', (ctx) => { ctx.body = { ok: true }; });
router.post('/api/ableton/mix', (ctx) => { ctx.body = { ok: true }; });

router.get('/api/youtube-dj/health', (ctx) => {
  ctx.body = { ok: true, djActive: true, youtubeSignedIn: true };
});

app.use(router.routes());

// Static SPA
const djDistDir = path.resolve(__dirname, '..', 'src', 'dj-controller', 'dist');
if (fs.existsSync(djDistDir)) {
  app.use(async (ctx, next) => {
    if (ctx.method === 'GET' && !ctx.path.startsWith('/api/')) {
      let filePath = path.join(djDistDir, ctx.path.slice(1) || 'index.html');
      try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(filePath);
          ctx.type = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : ext === '.js' ? 'application/javascript' : 'application/octet-stream';
          ctx.body = fs.createReadStream(filePath);
          return;
        }
      } catch { /* fall through */ }
      ctx.type = 'text/html';
      ctx.body = fs.createReadStream(path.join(djDistDir, 'index.html'));
      return;
    }
    await next();
  });
  console.log(`SPA served from: ${djDistDir}`);
}

const server = http.createServer(app.callback());
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Karol API online at http://0.0.0.0:${PORT}`);
  console.log(`  VLC: /api/vlc-dj/*`);
  console.log(`  Ableton: /api/ableton/*`);
});

process.on('SIGINT', () => { server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
