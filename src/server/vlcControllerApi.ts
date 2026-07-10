import Router from 'koa-router';
import type { Context } from 'koa';
import * as fs from 'fs';
import * as path from 'path';
import {
  getVlcStatus,
  getVlcPlaylist,
  getNowPlaying,
  isVlcRunning,
  findCoverPath,
  vlcPlay,
  vlcPause,
  vlcSkipNext,
  vlcSkipPrev,
  vlcSeek,
  vlcSetVolume,
  vlcEnqueueFile,
  vlcPlayId,
  vlcClearPlaylist,
  vlcRemoveFromPlaylist,
} from './vlcBridge';
import { getMicVolume, setMicVolume, getMicMuted, setMicMuted } from './macAudioControl';
import { getLibrary, searchLibrary } from './trackLibrary';

function setCors(ctx: Context): void {
  ctx.set('Access-Control-Allow-Origin', '*');
  ctx.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  ctx.set('Access-Control-Allow-Headers', 'Content-Type');
}

export function registerVlcControllerApi(router: Router): void {
  router.get('/api/vlc-dj/health', async (ctx: Context) => {
    setCors(ctx);
    try {
      const running = await isVlcRunning();
      ctx.body = { ok: true, vlcAvailable: running, hardwareAvailable: true };
    } catch {
      ctx.body = { ok: true, vlcAvailable: false, hardwareAvailable: true };
    }
  });

  router.get('/api/vlc-dj/status', async (ctx: Context) => {
    setCors(ctx);
    try {
      const status = await getVlcStatus();
      ctx.body = status;
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error instanceof Error ? error.message : 'Failed to get VLC status' };
    }
  });

  router.get('/api/vlc-dj/now-playing', async (ctx: Context) => {
    setCors(ctx);
    try {
      const np = await getNowPlaying();
      ctx.body = np ?? { title: '', artist: '', album: '', duration: 0, position: 0 };
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error instanceof Error ? error.message : 'Failed to get now playing' };
    }
  });

  // Cover art — serves the actual image binary for browser caching
  router.get('/api/vlc-dj/cover', async (ctx: Context) => {
    setCors(ctx);
    const trackPath = (ctx.query.path as string) || '';
    if (!trackPath) {
      ctx.status = 400;
      ctx.body = { error: 'path query parameter is required' };
      return;
    }
    const coverPath = findCoverPath(trackPath);
    if (!coverPath || !fs.existsSync(coverPath)) {
      ctx.status = 404;
      ctx.set('Content-Type', 'image/svg+xml');
      ctx.body = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect fill="#1a1a2e" width="300" height="300"/><text fill="#555" font-size="40" text-anchor="middle" x="150" y="170">♪</text></svg>';
      return;
    }
    try {
      const ext = path.extname(coverPath).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
      ctx.set('Content-Type', mime);
      ctx.set('Cache-Control', 'public, max-age=86400, immutable');
      ctx.body = fs.createReadStream(coverPath);
    } catch {
      ctx.status = 500;
      ctx.body = { error: 'Failed to serve cover art' };
    }
  });

  // Audio preview — streams the actual audio file for local preview on the controller
  router.get('/api/vlc-dj/audio', async (ctx: Context) => {
    setCors(ctx);
    const filePath = (ctx.query.path as string) || '';
    if (!filePath || !fs.existsSync(filePath)) {
      ctx.status = 400;
      ctx.body = { error: 'path query parameter is required and must point to an existing file' };
      return;
    }
    try {
      const stat = fs.statSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.mp3': 'audio/mpeg',
        '.m4a': 'audio/mp4',
        '.flac': 'audio/flac',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
        '.aiff': 'audio/aiff',
      };
      const mime = mimeMap[ext] || 'audio/mpeg';
      ctx.set('Content-Type', mime);
      ctx.set('Content-Length', String(stat.size));
      ctx.set('Accept-Ranges', 'bytes');
      ctx.set('Cache-Control', 'public, max-age=86400, immutable');
      ctx.body = fs.createReadStream(filePath);
    } catch {
      ctx.status = 500;
      ctx.body = { error: 'Failed to stream audio file' };
    }
  });

  router.get('/api/vlc-dj/playlist', async (ctx: Context) => {
    setCors(ctx);
    try {
      const playlist = await getVlcPlaylist();
      ctx.body = playlist;
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error instanceof Error ? error.message : 'Failed to get playlist' };
    }
  });

  router.get('/api/vlc-dj/library', async (ctx: Context) => {
    setCors(ctx);
    try {
      const library = await getLibrary();
      ctx.body = library;
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error instanceof Error ? error.message : 'Failed to get library' };
    }
  });

  router.get('/api/vlc-dj/library/search', async (ctx: Context) => {
    setCors(ctx);
    const q = (ctx.query.q as string) || '';
    const results = searchLibrary(q);
    ctx.body = { results };
  });

  // Transport
  router.post('/api/vlc-dj/transport/play', async (ctx: Context) => {
    setCors(ctx);
    try {
      await vlcPlay();
      ctx.body = { ok: true };
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error instanceof Error ? error.message : 'Failed to play' };
    }
  });

  router.post('/api/vlc-dj/transport/pause', async (ctx: Context) => {
    setCors(ctx);
    try {
      await vlcPause();
      ctx.body = { ok: true };
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error instanceof Error ? error.message : 'Failed to pause' };
    }
  });

  router.post('/api/vlc-dj/transport/skip-next', async (ctx: Context) => {
    setCors(ctx);
    try {
      await vlcSkipNext();
      ctx.body = { ok: true };
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error instanceof Error ? error.message : 'Failed to skip next' };
    }
  });

  router.post('/api/vlc-dj/transport/skip-prev', async (ctx: Context) => {
    setCors(ctx);
    try {
      await vlcSkipPrev();
      ctx.body = { ok: true };
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error instanceof Error ? error.message : 'Failed to skip previous' };
    }
  });

  router.post('/api/vlc-dj/transport/seek', async (ctx: Context) => {
    setCors(ctx);
    const body = (ctx.request as Context['request'] & { body?: { seconds?: number } }).body ?? {};
    const seconds = body.seconds ?? 0;
    try {
      await vlcSeek(seconds);
      ctx.body = { ok: true };
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error instanceof Error ? error.message : 'Failed to seek' };
    }
  });

  router.post('/api/vlc-dj/transport/seek-relative', async (ctx: Context) => {
    setCors(ctx);
    const body = (ctx.request as Context['request'] & { body?: { delta?: number } }).body ?? {};
    const delta = body.delta ?? 0;
    try {
      const status = await getVlcStatus();
      const target = status.position + delta;
      await vlcSeek(Math.max(0, target));
      ctx.body = { ok: true };
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error instanceof Error ? error.message : 'Failed to seek' };
    }
  });

  router.post('/api/vlc-dj/transport/volume', async (ctx: Context) => {
    setCors(ctx);
    const body = (ctx.request as Context['request'] & { body?: { level?: number } }).body ?? {};
    const level = typeof body.level === 'number' ? body.level : 50;
    const vlcLevel = Math.round((level / 100) * 256);
    try {
      await vlcSetVolume(vlcLevel);
      ctx.body = { ok: true };
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error instanceof Error ? error.message : 'Failed to set volume' };
    }
  });

  // Queue
  router.post('/api/vlc-dj/queue', async (ctx: Context) => {
    setCors(ctx);
    const body = (ctx.request as Context['request'] & { body?: { path?: string } }).body ?? {};
    const filePath = body.path;
    if (!filePath) {
      ctx.status = 400;
      ctx.body = { error: 'path is required' };
      return;
    }
    try {
      await vlcEnqueueFile(filePath);
      ctx.body = { ok: true };
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error instanceof Error ? error.message : 'Failed to enqueue file' };
    }
  });

  router.post('/api/vlc-dj/queue/:id/play', async (ctx: Context) => {
    setCors(ctx);
    try {
      await vlcPlayId(ctx.params.id);
      ctx.body = { ok: true };
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error instanceof Error ? error.message : 'Failed to play item' };
    }
  });

  router.delete('/api/vlc-dj/queue/:id', async (ctx: Context) => {
    setCors(ctx);
    try {
      await vlcRemoveFromPlaylist(ctx.params.id);
      ctx.body = { ok: true };
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error instanceof Error ? error.message : 'Failed to remove from queue' };
    }
  });

  router.post('/api/vlc-dj/queue/clear', async (ctx: Context) => {
    setCors(ctx);
    try {
      await vlcClearPlaylist();
      ctx.body = { ok: true };
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error instanceof Error ? error.message : 'Failed to clear queue' };
    }
  });

  router.post('/api/vlc-dj/queue/reorder', async (ctx: Context) => {
    setCors(ctx);
    ctx.status = 501;
    ctx.body = { error: 'VLC HTTP API does not support reordering' };
  });

  // Hardware mixer
  router.get('/api/vlc-dj/hardware/mic', async (ctx: Context) => {
    setCors(ctx);
    try {
      const [volume, muted] = await Promise.all([getMicVolume(), getMicMuted()]);
      ctx.body = { micVolume: volume, micMuted: muted };
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error instanceof Error ? error.message : 'Failed to get mic state' };
    }
  });

  router.post('/api/vlc-dj/hardware/mic', async (ctx: Context) => {
    setCors(ctx);
    const body = (ctx.request as Context['request'] & { body?: { level?: number } }).body ?? {};
    const level = typeof body.level === 'number' ? body.level : 50;
    try {
      await setMicVolume(level);
      ctx.body = { ok: true };
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error instanceof Error ? error.message : 'Failed to set mic volume' };
    }
  });

  router.post('/api/vlc-dj/hardware/mic/mute', async (ctx: Context) => {
    setCors(ctx);
    const body = (ctx.request as Context['request'] & { body?: { muted?: boolean } }).body ?? {};
    const muted = Boolean(body.muted);
    try {
      await setMicMuted(muted);
      ctx.body = { ok: true };
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error instanceof Error ? error.message : 'Failed to toggle mic mute' };
    }
  });
}
