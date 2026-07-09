/**
 * VLC control bridge via HTTP API (localhost:8080).
 * Reliable, no AppleScript, no M3U tracking needed.
 */
import type { VlcNowPlaying, VlcPlaylistState, VlcStatus, VlcTrack } from '../common/VlcControllerTypes';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';

const CONFIG_PATH = path.join(os.homedir(), '.deskreen', 'vlc-config.json');
const VLC_HOST = '127.0.0.1';
const VLC_PORT = 8080;
const VLC_PASSWORD = 'karol'; // set by CLI launch flag

type VlcConfig = {
  port: number;
  password: string;
  libraryFolder?: string;
};

function readConfig(): VlcConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  const def: VlcConfig = { port: VLC_PORT, password: VLC_PASSWORD };
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(def, null, 2));
  return def;
}

export function getVlcConfig(): VlcConfig {
  return readConfig();
}

function authHeader(): string {
  return 'Basic ' + Buffer.from(':' + VLC_PASSWORD).toString('base64');
}

function vlcGet(path: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: VLC_HOST, port: VLC_PORT, path, headers: { Authorization: authHeader() }, timeout: 8000 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve({});
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Health ───────────────────────────────────────────────────────

export async function isVlcRunning(): Promise<boolean> {
  try {
    await vlcGet('/requests/status.json');
    return true;
  } catch {
    return false;
  }
}

// ── Status ───────────────────────────────────────────────────────

export async function getVlcStatus(): Promise<VlcStatus> {
  try {
    const d = await vlcGet('/requests/status.json');
    const s = String(d.state ?? 'stopped');
    const state: VlcStatus['state'] =
      s === 'playing' ? 'playing' :
      s === 'paused' ? 'paused' : 'stopped';
    return {
      state,
      position: Number(d.position ?? 0),
      duration: Number(d.length ?? 0),
      volume: Number(d.volume ?? 128),
      time: Number(d.time ?? 0),
      length: Number(d.length ?? 0),
      fullscreen: d.fullscreen === true || d.fullscreen === 'true',
      loop: d.loop === true || d.loop === 'true',
      random: d.random === true || d.random === 'true',
      repeat: d.repeat === true || d.repeat === 'true',
      playlistLength: undefined,
    };
  } catch {
    return {
      state: 'stopped', position: 0, duration: 0, volume: 128,
      time: 0, length: 0, fullscreen: false, loop: false, random: false, repeat: false,
      playlistLength: 0,
    };
  }
}

// ── Now Playing ──────────────────────────────────────────────────

function extractMeta(d: Record<string, unknown>): {
  title: string; artist?: string; album?: string; filename?: string;
} {
  const info = d.information as Record<string, unknown> | undefined;
  const cat = info?.category as Record<string, unknown> | undefined;
  const meta = cat?.meta as Record<string, unknown> | undefined;
  return {
    title: String(meta?.title ?? ''),
    artist: meta?.artist ? String(meta.artist) : undefined,
    album: meta?.album ? String(meta.album) : undefined,
    filename: meta?.filename ? String(meta.filename) : undefined,
  };
}

export async function getNowPlaying(): Promise<VlcNowPlaying | null> {
  try {
    const d = await vlcGet('/requests/status.json');
    const meta = extractMeta(d);
    if (!meta.title && !meta.filename) return null;
    return {
      title: meta.title || meta.filename || '',
      artist: meta.artist,
      album: meta.album,
      duration: Number(d.length ?? 0),
      position: Number(d.time ?? 0),
      filePath: meta.filename,
      id: d.currentplid != null ? String(d.currentplid) : undefined,
      coverArt: meta.filename ? findCoverForTrack(meta.filename) : undefined,
    };
  } catch {
    return null;
  }
}

// ── Playlist ────────────────────────────────────────────────────

export async function getVlcPlaylist(): Promise<VlcPlaylistState> {
  try {
    const [plData, stData] = await Promise.all([
      vlcGet('/requests/playlist.json'),
      vlcGet('/requests/status.json'),
    ]);
    const rootChildren = plData.children as unknown[] | undefined;
    const first = (rootChildren?.[0] ?? {}) as Record<string, unknown>;
    const items = (first.children ?? []) as unknown[];
    const tracks: VlcTrack[] = items.map((item: unknown, i: number) => {
      const t = item as Record<string, unknown>;
      return {
        id: String(t.id ?? i),
        name: String(t.name ?? ''),
        uri: String(t.uri ?? ''),
        duration: typeof t.duration === 'number' ? t.duration : undefined,
      };
    });
    const cid = Number(stData.currentplid);
    const currentIndex = !isNaN(cid) ? tracks.findIndex(t => Number(t.id) === cid) : -1;
    return { tracks, currentIndex };
  } catch {
    return { tracks: [], currentIndex: -1 };
  }
}

// ── Cover Art ───────────────────────────────────────────────────

const coverCache = new Map<string, string>(); // path → data URI

function findCoverForTrack(trackPath: string): string | undefined {
  if (!trackPath || !fs.existsSync(trackPath)) return undefined;
  const cached = coverCache.get(trackPath);
  if (cached) return cached;

  const dir = path.dirname(trackPath);
  const candidates = ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png', 'artwork.jpg'];
  for (const c of candidates) {
    const coverPath = path.join(dir, c);
    if (fs.existsSync(coverPath)) {
      try {
        const buf = fs.readFileSync(coverPath);
        const b64 = buf.toString('base64');
        const mime = coverPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
        const uri = `data:${mime};base64,${b64}`;
        coverCache.set(trackPath, uri);
        // Also cache for all tracks in same directory
        return uri;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

// Cleanup cache periodically (keep last 50)
setInterval(() => {
  if (coverCache.size > 50) {
    const keys = [...coverCache.keys()].slice(0, coverCache.size - 50);
    keys.forEach(k => coverCache.delete(k));
  }
}, 60_000);

// ── Transport ────────────────────────────────────────────────────

export async function vlcPlay(): Promise<void> {
  await vlcGet('/requests/status.json?command=pl_play');
}

export async function vlcPause(): Promise<void> {
  await vlcGet('/requests/status.json?command=pl_pause');
}

export async function vlcSkipNext(): Promise<void> {
  await vlcGet('/requests/status.json?command=pl_next');
}

export async function vlcSkipPrev(): Promise<void> {
  await vlcGet('/requests/status.json?command=pl_previous');
}

export async function vlcSeek(seconds: number): Promise<void> {
  await vlcGet(`/requests/status.json?command=seek&val=${Math.max(0, Math.round(seconds))}`);
}

export async function vlcSetVolume(level: number): Promise<void> {
  const clamped = Math.max(0, Math.min(256, Math.round(level)));
  await vlcGet(`/requests/status.json?command=volume&val=${clamped}`);
}

// ── Queue ops ────────────────────────────────────────────────────

export async function vlcEnqueueFile(path: string): Promise<void> {
  await vlcGet(`/requests/status.json?command=in_enqueue&input=${encodeURIComponent(path)}`);
}

export async function vlcPlayId(id: string): Promise<void> {
  await vlcGet(`/requests/status.json?command=pl_play&id=${id}`);
}

export async function vlcClearPlaylist(): Promise<void> {
  await vlcGet('/requests/status.json?command=pl_empty');
}

export async function vlcRemoveFromPlaylist(id: string): Promise<void> {
  await vlcGet(`/requests/status.json?command=pl_delete&id=${id}`);
}
