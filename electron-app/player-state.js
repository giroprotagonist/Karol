// Karol Electron — Player State Machine
// Queue management, play/pause/skip/seek, auto-advance.
// Ported from api-server/index.js local player mode (lines 3277-3468).
// All WebSocket.send() replaced by IPC-based forwarding in main.js.

const fs = require('fs');
const path = require('path');
const library = require('./library');

// ── State ──
let queue = [];
let currentIndex = -1;
let playerState = {
  videoId: null,
  isYouTube: true,
  currentTime: 0,
  duration: 0,
  state: 'idle', // 'idle' | 'playing' | 'paused' | 'ended'
};
let skipRequested = false;

// ── Forward callback — set by main.js so we can send events to windows ──
let onStateChange = null; // (event) => void
let onQueueUpdate = null; // () => void

function setCallbacks(stateChange, queueUpdate) {
  onStateChange = stateChange;
  onQueueUpdate = queueUpdate;
}

// ── Helpers ──

function isYouTube(videoId, url) {
  if (!url) {
    // Check if local file exists
    try {
      const mp4Path = library.getVideoPath(videoId);
      if (fs.existsSync(mp4Path)) return false;
    } catch (e) { /* ignore */ }
    // Check karaoke variant
    try {
      const karaokePath = path.join(library.LIBRARY_KARAOKE_DIR, videoId + '-karaoke.mp4');
      if (fs.existsSync(karaokePath)) return false;
    } catch (e) { /* ignore */ }
    return true;
  }
  return true;
}

function resolveVideoId(videoId, url) {
  // Check for karaoke variant
  try {
    const karaokePath = path.join(library.LIBRARY_KARAOKE_DIR, videoId + '-karaoke.mp4');
    if (fs.existsSync(karaokePath)) return videoId + '-karaoke';
  } catch (e) { /* ignore */ }
  return videoId;
}

// ── Core operations ──

function addToQueue(videoId, url, title, requester) {
  console.log('[player-state] addToQueue called:', videoId, title, requester, new Error().stack.split('\n')[2]);
  const isYT = isYouTube(videoId, url);
  const actualVideoId = resolveVideoId(videoId, url);

  const queueItem = {
    videoId: actualVideoId,
    url: url || '',
    title: title || actualVideoId,
    requester: requester || '',
    singer: requester || '',
    isYouTube: isYT,
    addedAt: Date.now(),
  };

  queue.push(queueItem);

  // Start playing if nothing is currently active
  if (currentIndex < 0 || playerState.state === 'idle' || playerState.state === 'ended') {
    currentIndex = queue.length - 1;
    const next = queue[currentIndex];
    if (onStateChange) onStateChange({ type: 'play', ...next });
  }

  if (onQueueUpdate) onQueueUpdate();
  return { ok: true, videoId: actualVideoId, queued: true };
}

function playNow(videoId, url, title, requester) {
  const isYT = isYouTube(videoId, url);
  const actualVideoId = resolveVideoId(videoId, url);

  const queueItem = {
    videoId: actualVideoId,
    url: url || '',
    title: title || actualVideoId,
    requester: requester || '',
    singer: requester || '',
    isYouTube: isYT,
    addedAt: Date.now(),
  };

  // Insert at next position
  queue.splice(currentIndex + 1, 0, queueItem);
  // Skip to it
  skipTo(currentIndex + 1);

  if (onQueueUpdate) onQueueUpdate();
  return { ok: true, videoId: actualVideoId, playing: true };
}

function removeFromQueue(index) {
  if (index < 0 || index >= queue.length) return { ok: false, error: 'Invalid index' };

  const wasCurrent = index === currentIndex;
  queue.splice(index, 1);

  if (wasCurrent) {
    if (queue.length === 0) {
      currentIndex = -1;
      playerState = { videoId: null, isYouTube: true, currentTime: 0, duration: 0, state: 'idle' };
      if (onStateChange) onStateChange({ type: 'stop' });
    } else if (currentIndex >= queue.length) {
      currentIndex = 0;
      const next = queue[currentIndex];
      if (onStateChange) onStateChange({ type: 'play', ...next });
    }
  } else if (index < currentIndex) {
    currentIndex--;
  }

  if (onQueueUpdate) onQueueUpdate();
  return { ok: true };
}

function clearQueue() {
  queue = [];
  currentIndex = -1;
  playerState = { videoId: null, isYouTube: true, currentTime: 0, duration: 0, state: 'idle' };
  if (onStateChange) onStateChange({ type: 'stop' });
  if (onQueueUpdate) onQueueUpdate();
  return { ok: true };
}

function reorderQueue(from, to) {
  if (from < 0 || from >= queue.length || to < 0 || to >= queue.length) return { ok: false };
  const [item] = queue.splice(from, 1);
  queue.splice(to, 0, item);

  // Adjust currentIndex
  if (from === currentIndex) {
    currentIndex = to;
  } else if (from < currentIndex && to >= currentIndex) {
    currentIndex--;
  } else if (from > currentIndex && to <= currentIndex) {
    currentIndex++;
  }

  if (onQueueUpdate) onQueueUpdate();
  return { ok: true };
}

function skipTo(index) {
  if (index < 0 || index >= queue.length) return null;
  currentIndex = index;
  const next = queue[currentIndex];
  playerState = { videoId: next.videoId, isYouTube: next.isYouTube, currentTime: 0, duration: 0, state: 'playing' };
  if (onStateChange) onStateChange({ type: 'play', ...next });
  return next;
}

function skip() {
  if (queue.length === 0) return null;
  const nextIndex = (currentIndex + 1) % queue.length;
  return skipTo(nextIndex);
}

function prev() {
  if (queue.length === 0) return null;
  const prevIndex = currentIndex <= 0 ? 0 : currentIndex - 1;
  return skipTo(prevIndex);
}

function play() {
  console.log('[player-state] play() called, current state:', playerState.state, 'queue:', queue.length, new Error().stack.split('\n')[2]);
  if (playerState.state === 'paused') {
    playerState.state = 'playing';
  } else if (queue.length > 0 && (playerState.state === 'idle' || playerState.state === 'ended')) {
    if (currentIndex < 0) currentIndex = 0;
    const next = queue[currentIndex];
    if (next && onStateChange) {
      playerState = { videoId: next.videoId, isYouTube: next.isYouTube, currentTime: 0, duration: 0, state: 'playing' };
      onStateChange({ type: 'play', ...next });
    }
  }
}

function pause() {
  playerState.state = 'paused';
  if (onStateChange) onStateChange({ type: 'pause' });
}

function seek(time) {
  playerState.currentTime = time;
  if (onStateChange) onStateChange({ type: 'seek', time });
}

function volume(level) {
  if (onStateChange) onStateChange({ type: 'volume', level });
}

function stop() {
  if (onStateChange) onStateChange({ type: 'stop' });
}

function updatePlaybackState(state) {
  // Called from player window via IPC when playback state changes
  if (state.videoId) playerState.videoId = state.videoId;
  if (state.currentTime !== undefined) playerState.currentTime = state.currentTime;
  if (state.duration !== undefined) playerState.duration = state.duration;
  if (state.state) playerState.state = state.state;

  // Handle auto-advance
  if (state.state === 'ended' && !skipRequested) {
    console.log('[player-state] Auto-advancing from ended state');
    skip();
  }
  skipRequested = false;
}

// ── Getters ──

function getQueue() {
  return {
    ok: true,
    queue: queue.map((item, i) => ({ ...item, index: i })),
    currentIndex,
  };
}

function getQueueLength() {
  return queue.length;
}

function getCurrentTitle() {
  if (currentIndex >= 0 && currentIndex < queue.length) {
    return queue[currentIndex].title || '';
  }
  return '';
}

function getPlayerState() {
  return playerState.state;
}

function getNowPlaying() {
  if (currentIndex >= 0 && currentIndex < queue.length) {
    const item = queue[currentIndex];
    return {
      title: item.title || '',
      videoId: item.videoId,
      requester: item.requester || '',
      currentTime: playerState.currentTime,
      duration: playerState.duration,
      state: playerState.state === 'playing' ? 1 : (playerState.state === 'paused' ? 2 : -2),
      isYouTube: item.isYouTube,
    };
  }
  return { title: '', videoId: '', currentTime: 0, duration: 0, state: -2 };
}

function getStatus() {
  return {
    ok: true,
    djActive: true,
    queueLength: queue.length,
    currentTitle: (currentIndex >= 0 && currentIndex < queue.length) ? (queue[currentIndex].title || '') : '',
    currentTime: playerState.currentTime,
    duration: playerState.duration,
    state: playerState.state,
  };
}

module.exports = {
  setCallbacks,
  addToQueue,
  playNow,
  removeFromQueue,
  clearQueue,
  reorderQueue,
  skipTo,
  skip,
  prev,
  play,
  pause,
  seek,
  volume,
  stop,
  updatePlaybackState,
  getQueue,
  getQueueLength,
  getCurrentTitle,
  getPlayerState,
  getNowPlaying,
  getStatus,
};
