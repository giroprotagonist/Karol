// Karol Electron — preload script
// Exposes a safe IPC bridge to renderer processes via contextBridge

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('karolAPI', {
  // ── Player commands (from controller → main → player window) ──
  transport: {
    play: () => ipcRenderer.send('transport-play'),
    pause: () => ipcRenderer.send('transport-pause'),
    skip: () => ipcRenderer.send('transport-skip'),
    prev: () => ipcRenderer.send('transport-prev'),
    seek: (time) => ipcRenderer.send('transport-seek', time),
    volume: (level) => ipcRenderer.send('transport-volume', level),
  },

  // ── Player commands (forwarded to player window) ──
  commands: {
    toggleLyricSlider: (active) => ipcRenderer.send('toggle-lyric-slider', active),
    toggleFullLyrics: (videoId, show) => ipcRenderer.send('toggle-full-lyrics', { videoId, show }),
  },

  // ── Queue management ──
  queue: {
    add: (videoId, title, requester, url) =>
      ipcRenderer.invoke('queue-add', { videoId, title, requester, url }),
    remove: (index) => ipcRenderer.invoke('queue-remove', index),
    reorder: (from, to) => ipcRenderer.invoke('queue-reorder', { from, to }),
    clear: () => ipcRenderer.invoke('queue-clear'),
    skipTo: (index) => ipcRenderer.invoke('queue-skip-to', index),
    get: () => ipcRenderer.invoke('queue-get'),
    playNow: (videoId, title, requester, url) =>
      ipcRenderer.invoke('queue-play-now', { videoId, title, requester, url }),
  },

  // ── Player status ──
  status: {
    get: () => ipcRenderer.invoke('status-get'),
    nowPlaying: () => ipcRenderer.invoke('now-playing'),
  },

  // ── Library ──
  library: {
    list: (opts) => ipcRenderer.invoke('library-list', opts || {}),
    search: (q, opts) => ipcRenderer.invoke('library-list', { q, ...opts }),
    metadata: (videoId) => ipcRenderer.invoke('library-metadata', videoId),
    tags: () => ipcRenderer.invoke('library-tags'),
    setTag: (videoId, tag) => ipcRenderer.invoke('library-set-tag', { videoId, tag }),
    status: (videoId) => ipcRenderer.invoke('library-status', videoId),
    lyrics: (videoId) => ipcRenderer.invoke('library-lyrics', videoId),
    filePath: (videoId) => ipcRenderer.invoke('library-file-path', videoId),
    scan: () => ipcRenderer.invoke('library-scan'),
  },

  // ── Downloads ──
  downloads: {
    start: (videoId, karaoke) => ipcRenderer.invoke('download-start', { videoId, karaoke }),
    status: (videoId) => ipcRenderer.invoke('download-status', videoId),
    cancel: (videoId) => ipcRenderer.invoke('download-cancel', videoId),
  },

  // ── Processing jobs (karaoke pipeline progress) ──
  jobs: {
    list: () => ipcRenderer.invoke('jobs-list'),
  },

  // ── Song requests ──
  requests: {
    add: (videoId, requester, title, url, karaoke) =>
      ipcRenderer.invoke('request-add', { videoId, requester, title, url, karaoke }),
    list: () => ipcRenderer.invoke('request-list'),
  },

  // ── Window management ──
  window: {
    launchPlayer: () => ipcRenderer.send('launch-player'),
    closePlayer: () => ipcRenderer.send('close-player'),
    setMonitorMode: (enabled) => ipcRenderer.invoke('monitor-mode-set', { enabled }),
    getMonitorMode: () => ipcRenderer.invoke('monitor-mode-get'),
  },

  // ── Player state reporting (player window → main) ──
  reportState: (state) => ipcRenderer.send('player-state-report', state),

  // ── Events (main → renderer) ──
  on: (channel, callback) => {
    const validChannels = [
      'player-status', 'queue-update', 'player-event',
      'download-progress', 'library-scan-progress', 'health-report',
      'monitor-mode', 'lyrics-updated',
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => callback(...args));
    }
  },
  removeListener: (channel, callback) => {
    ipcRenderer.removeListener(channel, callback);
  },

  // ── App info ──
  app: {
    getVersion: () => ipcRenderer.invoke('app-version'),
    getDisplayInfo: () => ipcRenderer.invoke('display-info'),
  },

  // ── Health ──
  health: () => ipcRenderer.invoke('health-check'),
  retryJob: (videoId) => ipcRenderer.invoke('retry-job', { videoId }),
  clearErrors: () => ipcRenderer.invoke('clear-errors'),
  rescan: () => ipcRenderer.invoke('library-rescan'),

  // ── Lyric management ──
  lyrics: {
    reprocess: (videoId, forceWhisper, options) => ipcRenderer.invoke('reprocess-lyrics', { videoId, forceWhisper, ...options }),
    getOffset: (videoId) => ipcRenderer.invoke('get-lyric-offset', { videoId }),
    saveOffset: (videoId, offset) => ipcRenderer.invoke('save-lyric-offset', { videoId, offset }),
    diagnose: (videoId) => ipcRenderer.invoke('diagnose-lyrics', { videoId }),
    findKaraoke: (videoId) => ipcRenderer.invoke('find-karaoke', { videoId }),
    saveKaraokeMatch: (videoId, karaokeVideoId) => ipcRenderer.invoke('save-karaoke-match', { videoId, karaokeVideoId }),
    provenance: (videoId) => ipcRenderer.invoke('get-lyric-provenance', videoId),
    saveLines: (videoId, lines) => ipcRenderer.invoke('save-lyrics-lines', { videoId, lines }),
  },

});
