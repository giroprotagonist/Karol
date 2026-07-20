// Karol Electron — Song Requests module
// Local JSON store for song requests (replaces MySQL/Bluehost).
// Simple: write to a JSON file in the .karol directory.

const fs = require('fs');
const path = require('path');
const playerState = require('./player-state');

const REQUESTS_FILE = path.resolve(__dirname, '..', '.karol', 'song-requests.json');

// ── Helpers ──

function load() {
  try {
    if (fs.existsSync(REQUESTS_FILE)) {
      return JSON.parse(fs.readFileSync(REQUESTS_FILE, 'utf8'));
    }
  } catch (e) { console.error('[requests] Load error:', e.message); }
  return [];
}

function save(requests) {
  try {
    const dir = path.dirname(REQUESTS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(REQUESTS_FILE, JSON.stringify(requests, null, 2), 'utf8');
  } catch (e) { console.error('[requests] Save error:', e.message); }
}

// ── Public API ──

function add(videoId, requester, title) {
  const all = load();
  const request = {
    videoId,
    requester: requester || 'Anonymous',
    title: title || videoId,
    requestedAt: new Date().toISOString(),
    timestamp: Date.now(),
  };
  all.push(request);
  save(all);

  // Also add to the player queue
  playerState.addToQueue(videoId, '', title, requester);

  return { ok: true, request };
}

function list() {
  return load();
}

function clear() {
  save([]);
  return { ok: true };
}

module.exports = { add, list, clear };
