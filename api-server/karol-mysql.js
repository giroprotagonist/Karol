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

async function requestAdd(videoId, requesterName, songTitle) {
  return fetch({ table: 'song_requests', action: 'add' }, { video_id: videoId, requester_name: requesterName, song_title: songTitle });
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
  archiveCheck,
  archiveAdd,
  archiveCount,
  archiveCheckBatch,
};
