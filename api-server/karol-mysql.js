/**
 * karol-mysql.js — Node.js client for the PHP MySQL proxy on Bluehost.
 * All persistence goes through this module; no JSON files on disk.
 */
const https = require('https');

const PROXY = 'https://karol.rideyrbike.com/db.php';
const AUTH = 'kar0l_my5ql_pr0xy_2026';
const USER_AGENT = 'Karol-API-Server/3.0';

function fetch(params, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(PROXY);
    url.searchParams.set('table', params.table);
    url.searchParams.set('action', params.action);
    for (const [k, v] of Object.entries(params.query || {})) {
      url.searchParams.set(k, v);
    }
    const opts = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: body ? 'POST' : 'GET',
      headers: {
        'X-Karol-Auth': AUTH,
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      timeout: 15000,
    };
    if (body) {
      const b = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(b);
    }
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Invalid JSON from proxy: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Library tags ──

async function tagGet(videoId) {
  const r = await fetch({ table: 'library_tags', action: 'get', query: { video_id: videoId } });
  return r.ok ? r.row : null;
}

async function tagSet(videoId, tag, artist, year, source) {
  // library_tags.video_id is VARCHAR(11) and db.php truncates longer ids, so
  // writing 'X-karaoke' would silently overwrite base row 'X' with the
  // variant's tag/source. Variant rows are durable in song_catalog instead.
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(videoId || ''))) {
    return { ok: false, skipped: true, error: 'variant/invalid id not stored in library_tags' };
  }
  return fetch({ table: 'library_tags', action: 'set' }, { video_id: videoId, tag, artist, year, source });
}

async function tagListAll(limit = 5000) {
  const r = await fetch({ table: 'library_tags', action: 'list_all', query: { limit: String(limit) } });
  return r.ok ? r.tags : null;
}

async function tagCountByTag() {
  const r = await fetch({ table: 'library_tags', action: 'count_by_tag' });
  return r.ok ? r.counts : null;
}

// ── Song requests ──

async function requestAdd(videoId, requesterName, songTitle, sourceUrl = '', karaokeify = false, { requestType = '', artist = '' } = {}) {
  return fetch({ table: 'song_requests', action: 'add' }, {
    video_id: videoId,
    requester_name: requesterName,
    song_title: songTitle,
    artist,
    source_url: sourceUrl,
    karaokeify,
    request_type: requestType,
  });
}

async function requestMap() {
  const r = await fetch({ table: 'song_requests', action: 'get_map' });
  return r.ok ? r.requestMap : null;
}

async function requestList(status = '', limit = 200) {
  const query = { limit: String(limit) };
  if (status) query.status = status;
  const r = await fetch({ table: 'song_requests', action: 'list', query });
  return r.ok ? r.rows : null;
}

async function requestUpdate(id, status, lastError = '') {
  return fetch({ table: 'song_requests', action: 'update' }, { id, status, last_error: lastError });
}

// By-name requests waiting for the DJ to attach a YouTube video.
async function requestListNeedsMatch(limit = 100) {
  const r = await fetch({ table: 'song_requests', action: 'list_needs_match', query: { limit: String(limit) } });
  return r.ok ? r.rows : null;
}

// DJ resolves a by-name request: attach a video + type → row goes back to queued.
async function requestFillMatch(id, { videoId = '', url = '', requestType = 'karaokify', title = '' } = {}) {
  return fetch({ table: 'song_requests', action: 'fill_match' }, {
    id,
    video_id: videoId,
    url,
    request_type: requestType,
    title,
  });
}

// Atomically claim queued (or expired-lease) requests for this host.
async function requestClaimBatch(owner = 'mac', leaseSeconds = 180, limit = 25) {
  return fetch({ table: 'song_requests', action: 'claim_batch' }, {
    owner,
    lease_seconds: leaseSeconds,
    limit,
  });
}

// ACK a claimed request: it is durably in the local Electron queue.
async function requestAck(id, leaseSeconds = 7200) {
  return fetch({ table: 'song_requests', action: 'ack' }, { id, lease_seconds: leaseSeconds });
}

async function requestReclaimExpired(stalePlayingMinutes = 180) {
  return fetch({ table: 'song_requests', action: 'reclaim_expired' }, {
    stale_playing_minutes: stalePlayingMinutes,
  });
}

async function requestSetJob(id, jobId) {
  return fetch({ table: 'song_requests', action: 'set_job' }, { id, job_id: jobId });
}

// ── Durable karaoke jobs ──

async function jobUpsert(videoId, sourceUrl = '', recipe = 'karaoke-v1', idempotencyKey = '') {
  return fetch({ table: 'karaoke_jobs', action: 'upsert' }, {
    video_id: videoId,
    source_url: sourceUrl,
    recipe,
    idempotency_key: idempotencyKey || `${videoId}:${recipe}`,
  });
}

async function jobClaimBatch(owner = 'mac', leaseSeconds = 1800, limit = 5) {
  return fetch({ table: 'karaoke_jobs', action: 'claim_batch' }, {
    owner,
    lease_seconds: leaseSeconds,
    limit,
  });
}

async function jobUpdate(id, fields = {}) {
  return fetch({ table: 'karaoke_jobs', action: 'update' }, { id, ...fields });
}

async function jobGet({ id, videoId, recipe } = {}) {
  const query = {};
  if (id) query.id = String(id);
  if (videoId) query.video_id = videoId;
  if (recipe) query.recipe = recipe;
  const r = await fetch({ table: 'karaoke_jobs', action: 'get', query });
  return r.ok ? r.job : null;
}

async function jobList(status = '', limit = 100) {
  const query = { limit: String(limit) };
  if (status) query.status = status;
  const r = await fetch({ table: 'karaoke_jobs', action: 'list', query });
  return r.ok ? r.rows : null;
}

async function jobReclaimExpired() {
  return fetch({ table: 'karaoke_jobs', action: 'reclaim_expired' }, {});
}

// ── Media asset / replication tracking ──

async function assetUpsertBatch(assets) {
  return fetch({ table: 'media_assets', action: 'upsert_batch' }, { assets });
}

async function assetMarkState(videoId, r2State, roles = []) {
  return fetch({ table: 'media_assets', action: 'mark_state' }, {
    video_id: videoId,
    r2_state: r2State,
    roles,
  });
}

async function assetList(videoId) {
  const r = await fetch({ table: 'media_assets', action: 'list', query: { video_id: videoId } });
  return r.ok ? r.rows : null;
}

// ── Authoritative song catalog ──

async function catalogUpsertBatch(songs) {
  return fetch({ table: 'song_catalog', action: 'upsert_batch' }, { songs });
}

async function catalogMarkR2Batch(videoIds) {
  return fetch({ table: 'song_catalog', action: 'mark_r2_batch' }, { video_ids: videoIds });
}

async function catalogCount() {
  return fetch({ table: 'song_catalog', action: 'count' });
}

async function catalogGetMedia(videoId) {
  const r = await fetch({ table: 'song_catalog', action: 'get_media', query: { video_id: videoId } });
  return r.ok ? r.row : null;
}

async function catalogGetPublic(videoId) {
  const r = await fetch({ table: 'song_catalog', action: 'get_public', query: { video_id: videoId } });
  return r.ok ? r.video : null;
}

// ── Download archive ──

async function archiveCheck(videoId) {
  const r = await fetch({ table: 'download_archive', action: 'check', query: { video_id: videoId } });
  return r.ok ? r.exists : false;
}

async function archiveAdd(videoId) {
  return fetch({ table: 'download_archive', action: 'add' }, { video_id: videoId });
}

async function archiveCount() {
  const r = await fetch({ table: 'download_archive', action: 'count' });
  return r.ok ? r.count : 0;
}

async function archiveCheckBatch(videoIds) {
  const r = await fetch({ table: 'download_archive', action: 'check_batch', query: { video_ids: videoIds.join(',') } });
  return r.ok ? new Set(r.found) : new Set();
}

module.exports = {
  tagGet,
  tagSet,
  tagListAll,
  tagCountByTag,
  requestAdd,
  requestMap,
  requestList,
  requestUpdate,
  requestListNeedsMatch,
  requestFillMatch,
  requestClaimBatch,
  requestAck,
  requestReclaimExpired,
  requestSetJob,
  jobUpsert,
  jobClaimBatch,
  jobUpdate,
  jobGet,
  jobList,
  jobReclaimExpired,
  assetUpsertBatch,
  assetMarkState,
  assetList,
  catalogUpsertBatch,
  catalogMarkR2Batch,
  catalogCount,
  catalogGetMedia,
  catalogGetPublic,
  archiveCheck,
  archiveAdd,
  archiveCount,
  archiveCheckBatch,
};
