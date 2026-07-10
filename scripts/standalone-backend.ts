#!/usr/bin/env tsx
/**
 * Standalone Karol backend server (no Electron dependency).
 * Runs the Koa HTTP server on port 3131 with DJ controller, VLC, and Ableton routes.
 *
 * Usage: npx tsx scripts/standalone-backend.ts
 */
import http from 'http';
import Koa from 'koa';
import cors from 'kcors';
import Router from 'koa-router';
import koaStatic from 'koa-static';
import koaSend from 'koa-send';
import bodyParser from 'koa-bodyparser';
import { registerYouTubeKaraokeApi } from '../src/server/youtubeKaraokeApi';
import { registerVlcControllerApi } from '../src/server/vlcControllerApi';
import { registerAbletonApi } from '../src/server/abletonApi';
import { initAbletonBridge, shutdownAbletonBridge } from '../src/server/abletonBridge';

const PORT = 3131;
const HOST = '0.0.0.0';

const app = new Koa();
const router = new Router();

app.use(cors());
app.use(bodyParser());

// ── API routes ────────────────────────────────────────────────────────
registerYouTubeKaraokeApi(router);
registerVlcControllerApi(router);
registerAbletonApi(router);
app.use(router.routes());

// ── Static: DJ controller (built React SPA) ───────────────────────────
import path from 'path';
const djDist = path.resolve(__dirname, '..', 'src', 'dj-controller', 'dist');
try {
	const fs = require('fs');
	if (fs.existsSync(djDist)) {
		app.use(koaStatic(djDist));
		app.use(async (ctx) => {
			await koaSend(ctx, 'index.html', { root: djDist });
		});
		console.log(`DJ controller served from: ${djDist}`);
	}
} catch {
	console.log('DJ controller dist not found, skipping static serving.');
}

// ── Health check ──────────────────────────────────────────────────────
app.use(async (ctx) => {
	ctx.body = { ready: true, routes: ['youtube-dj', 'vlc-dj', 'ableton'] };
});

// ── Start ─────────────────────────────────────────────────────────────
const server = http.createServer(app.callback());
server.listen(PORT, HOST, () => {
	console.log(`🚀 Karol standalone backend online at http://${HOST}:${PORT}`);
	initAbletonBridge();
});

// ── Graceful shutdown ─────────────────────────────────────────────────
function shutdown() {
	console.log('Shutting down...');
	shutdownAbletonBridge();
	server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
