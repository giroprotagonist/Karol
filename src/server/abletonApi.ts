import Router from 'koa-router';
import type { Context } from 'koa';
import {
  checkAbletonConnection,
  getAbletonState,
  abletonPlay,
  abletonStop,
  abletonSetTempo,
  abletonTrackVolume,
  abletonTrackMute,
  abletonMasterVolume,
  setTrackMix,
  type AbletonState,
} from './abletonBridge';

function setCors(ctx: Context): void {
  ctx.set('Access-Control-Allow-Origin', '*');
  ctx.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  ctx.set('Access-Control-Allow-Headers', 'Content-Type');
}

export function registerAbletonApi(router: Router): void {
  // ── Health / connection check ──────────────────────────────────────
  router.get('/api/ableton/health', async (ctx: Context) => {
    setCors(ctx);
    try {
      const connected = await checkAbletonConnection();
      ctx.body = { ok: true, connected };
    } catch {
      ctx.body = { ok: true, connected: false };
    }
  });

  // ── Full state ─────────────────────────────────────────────────────
  router.get('/api/ableton/state', async (ctx: Context) => {
    setCors(ctx);
    try {
      // Refresh connection status
      const connected = await checkAbletonConnection();
      const state = getAbletonState();
      ctx.body = { ...state, connected };
    } catch {
      ctx.body = getAbletonState();
    }
  });

  // ── Transport ──────────────────────────────────────────────────────
  router.post('/api/ableton/transport/play', async (ctx: Context) => {
    setCors(ctx);
    abletonPlay();
    ctx.body = { ok: true };
  });

  router.post('/api/ableton/transport/stop', async (ctx: Context) => {
    setCors(ctx);
    abletonStop();
    ctx.body = { ok: true };
  });

  // ── Track volume ───────────────────────────────────────────────────
  router.post('/api/ableton/track/:index/volume', async (ctx: Context) => {
    setCors(ctx);
    const index = parseInt(ctx.params.index, 10);
    if (isNaN(index) || index < 0 || index > 7) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid track index (0-7)' };
      return;
    }
    const level = parseFloat(String(ctx.query.level ?? ctx.request.body?.level ?? 0.75));
    abletonTrackVolume(index, level);
    ctx.body = { ok: true };
  });

  // ── Track mute ─────────────────────────────────────────────────────
  router.post('/api/ableton/track/:index/mute', async (ctx: Context) => {
    setCors(ctx);
    const index = parseInt(ctx.params.index, 10);
    if (isNaN(index) || index < 0 || index > 7) {
      ctx.status = 400;
      ctx.body = { error: 'Invalid track index (0-7)' };
      return;
    }
    const muted = ctx.query.muted === 'true' || ctx.request.body?.muted === true;
    abletonTrackMute(index, muted);
    ctx.body = { ok: true };
  });

  // ── Master volume ──────────────────────────────────────────────────
  router.post('/api/ableton/master/volume', async (ctx: Context) => {
    setCors(ctx);
    const level = parseFloat(String(ctx.query.level ?? ctx.request.body?.level ?? 0.85));
    abletonMasterVolume(level);
    ctx.body = { ok: true };
  });

  // ── Tempo ──────────────────────────────────────────────────────────
  router.post('/api/ableton/tempo', async (ctx: Context) => {
    setCors(ctx);
    const bpm = parseFloat(String(ctx.query.bpm ?? ctx.request.body?.bpm ?? 120));
    abletonSetTempo(bpm);
    ctx.body = { ok: true };
  });

  // ── Bulk mixer state (set all at once) ──────────────────────────────
  router.post('/api/ableton/mix', async (ctx: Context) => {
    setCors(ctx);
    try {
      const body = ctx.request.body || {};
      const karaokeVol = typeof body.karaokeVolume === 'number' ? body.karaokeVolume : 0.75;
      const karaokeMuted = body.karaokeMuted === true;
      const vlcVol = typeof body.vlcVolume === 'number' ? body.vlcVolume : 0.75;
      const vlcMuted = body.vlcMuted === true;
      const masterVol = typeof body.masterVolume === 'number' ? body.masterVolume : 0.85;
      setTrackMix(karaokeVol, karaokeMuted, vlcVol, vlcMuted, masterVol);
      ctx.body = { ok: true };
    } catch (error) {
      ctx.status = 500;
      ctx.body = { error: error instanceof Error ? error.message : 'Mix update failed' };
    }
  });
}
