/**
 * Standalone Koa server for VLC controller API.
 * Runs independently of the Electron app on port 3131.
 */

import Koa from 'koa';
import Router from 'koa-router';
import cors from 'kcors';
import bodyParser from 'koa-bodyparser';
import { registerVlcControllerApi } from '../src/server/vlcControllerApi';

const PORT = 3131;

const app = new Koa();
const router = new Router();

app.use(cors());
app.use(bodyParser());

// VLC API routes
registerVlcControllerApi(router);

// Health endpoint to confirm server is alive
router.get('/api/health.json', (ctx) => {
  ctx.type = 'application/json';
  ctx.body = { ok: true, server: 'standalone-vlc' };
});

app.use(router.routes());
app.use(router.allowedMethods());

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Standalone VLC server running on http://0.0.0.0:${PORT}`);
  console.log(`VLC API available at http://localhost:${PORT}/api/vlc-dj/`);
});
