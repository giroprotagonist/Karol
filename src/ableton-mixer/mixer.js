/* ── Ableton Mixer SPA — iPhone SE 2 Landscape, Pure Vanilla JS ── */

(function () {
  'use strict';

  const POLL_MS = 500;
  const DEBOUNCE_MS = 80;
  const ADJUSTMENT_GUARD_MS = 2000;

  let state = null;
  let lastRenderTracks = null;
  let playing = false;

  // Track user-initiated adjustments to prevent poll overwrite
  const recentlyAdjusted = {
    volume: {},
    pan: {},
    send: {},
  };

  function markAdjusted(category, idx, subIdx) {
    const key = subIdx != null ? idx + '_' + subIdx : String(idx);
    recentlyAdjusted[category][key] = Date.now();
  }

  function isRecentlyAdjusted(category, idx, subIdx) {
    const key = subIdx != null ? idx + '_' + subIdx : String(idx);
    const ts = recentlyAdjusted[category][key];
    return ts && (Date.now() - ts) < ADJUSTMENT_GUARD_MS;
  }

  // ── Debounce helpers ──
  const debounceTimers = {};

  function debounceSend(key, fn, ms) {
    if (debounceTimers[key]) clearTimeout(debounceTimers[key]);
    debounceTimers[key] = setTimeout(fn, ms || DEBOUNCE_MS);
  }

  // ── API helpers ──
  async function apiGet(path) {
    try {
      const res = await fetch(path);
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  async function apiPost(path, body) {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return await res.json();
    } catch (e) {
      return { ok: false };
    }
  }

  // ── DOM refs ──
  const els = {};
  function cacheDom() {
    els.container = document.getElementById('channel-strips');
    els.btnPlay = document.getElementById('btn-play');
    els.btnStop = document.getElementById('btn-stop');
    els.btnTap = document.getElementById('btn-tap-tempo');
    els.beatPos = document.getElementById('beat-position');
    els.tempoVal = document.getElementById('tempo-value');
    els.statusDot = document.getElementById('connection-status');
  }

  // ── Beat position formatting ──
  // beatPosition is 0-indexed within the bar (e.g. 0, 1, 2, 3 for 4/4)
  function formatBeat(pos) {
    if (pos == null) return '---';
    const bar = Math.floor(pos / 4) + 1;
    const beat = Math.floor(pos % 4) + 1;
    const frac = Math.round((pos % 1) * 4) + 1;
    return bar + '.' + beat + '.' + frac;
  }

  // ── Volume to dB display ──
  function volToDb(v) {
    if (v <= 0) return '-∞';
    const db = 20 * Math.log10(v);
    if (db > -0.5) return '0.0';
    return db.toFixed(1);
  }

  // ── Update transport UI ──
  function updateTransport(data) {
    if (data.connected !== undefined) {
      els.statusDot.className = 'status-dot' + (data.connected ? ' connected' : '');
      els.statusDot.title = data.connected ? 'Ableton connected' : 'Ableton disconnected';
    }
    if (data.playing !== undefined) {
      playing = data.playing;
      els.btnPlay.classList.toggle('playing', playing);
    }
    if (data.tempo !== undefined) {
      els.tempoVal.textContent = data.tempo.toFixed(2);
    }
    if (data.beatPosition !== undefined) {
      els.beatPos.textContent = formatBeat(data.beatPosition);
    }
  }

  // ── Render all channel strips ──
  function renderStrips(tracks, masterVolume, masterMeters) {
    // Quick diff check — only re-render if track data changed meaningfully
    const renderKey = JSON.stringify({
      t: tracks.map(t => ({ i: t.index, v: t.volume, m: t.muted, s: t.solo, p: t.pan, sd: t.sends, n: t.name, c: t.color, ip: t.isPlaying, hc: t.hasClip, ml: t.meterLeft, mr: t.meterRight })),
      mv: masterVolume, mml: masterMeters ? masterMeters.left : 0, mmr: masterMeters ? masterMeters.right : 0,
    });
    if (renderKey === lastRenderTracks) return;
    lastRenderTracks = renderKey;

    let html = '';

    for (const track of tracks) {
      const idx = track.index;
      const name = (track.name || 'Track ' + (idx + 1)).length > 14
        ? (track.name || '').slice(0, 13) + '\u2026'
        : (track.name || 'Track ' + (idx + 1));
      const color = track.color || '#666';
      const volume = track.volume != null ? track.volume : 0.75;
      const muted = !!track.muted;
      const soloed = !!track.solo;
      const pan = track.pan != null ? track.pan : 0;
      const sends = track.sends || [0, 0, 0, 0];
      const hasClip = !!track.hasClip;
      const isPlaying = !!track.isPlaying;
      const meterL = track.meterLeft != null ? track.meterLeft : 0;
      const meterR = track.meterRight != null ? track.meterRight : 0;

      // Only update fader if not recently adjusted by user
      const volAdjKey = 'volume_' + idx;
      const panAdjKey = 'pan_' + idx;

      html += '<div class="channel-strip" data-track="' + idx + '">';

      // Color bar
      html += '<div class="track-color-bar" style="background:' + color + '"></div>';

      // Track name
      html += '<div class="track-name">' + escapeHtml(name) + '</div>';

      // Clip indicator
      const clipClass = isPlaying ? 'clip-indicator playing' : 'clip-indicator';
      html += '<div class="' + clipClass + '"></div>';

      // Meter row
      const meterClassL = meterL > 0.9 ? 'meter-fill clip' : meterL > 0.7 ? 'meter-fill hot' : 'meter-fill';
      const meterClassR = meterR > 0.9 ? 'meter-fill clip' : meterR > 0.7 ? 'meter-fill hot' : 'meter-fill';
      html += '<div class="meter-row">';
      html += '<div class="meter-bar"><div class="' + meterClassL + '" style="width:' + (meterL * 100) + '%"></div></div>';
      html += '<div class="meter-bar"><div class="' + meterClassR + '" style="width:' + (meterR * 100) + '%"></div></div>';
      html += '</div>';

      // Pan slider
      html += '<div class="pan-container">';
      html += '<input type="range" class="pan-slider" min="-1" max="1" step="0.01" value="' + pan + '" data-track="' + idx + '" data-type="pan">';
      html += '</div>';

      // Volume fader
      html += '<div class="fader-container">';
      html += '<input type="range" class="volume-fader" min="0" max="1" step="0.001" value="' + volume + '" data-track="' + idx + '" data-type="volume" orient="vertical">';
      html += '</div>';

      // Volume readout
      html += '<div class="volume-readout">' + volToDb(volume) + '</div>';

      // Mute / Solo buttons
      html += '<div class="mute-solo-row">';
      html += '<button class="mute-btn' + (muted ? ' muted' : '') + '" data-track="' + idx + '" data-type="mute">M</button>';
      html += '<button class="solo-btn' + (soloed ? ' soloed' : '') + '" data-track="' + idx + '" data-type="solo">S</button>';
      html += '</div>';

      // Send sliders
      html += '<div class="sends-row">';
      for (let s = 0; s < 4; s++) {
        html += '<div class="send-item">';
        html += '<span class="send-label-mini">' + String.fromCharCode(65 + s) + '</span>';
        html += '<input type="range" class="send-slider" min="0" max="1" step="0.001" value="' + sends[s] + '" data-track="' + idx + '" data-send="' + s + '" data-type="send">';
        html += '</div>';
      }
      html += '</div>';

      html += '</div>';
    }

    // Master strip
    const mv = masterVolume != null ? masterVolume : 0.85;
    const mml = masterMeters ? masterMeters.left : 0;
    const mmr = masterMeters ? masterMeters.right : 0;
    const meterClassML = mml > 0.9 ? 'meter-fill clip' : mml > 0.7 ? 'meter-fill hot' : 'meter-fill';
    const meterClassMR = mmr > 0.9 ? 'meter-fill clip' : mmr > 0.7 ? 'meter-fill hot' : 'meter-fill';

    html += '<div class="channel-strip master">';
    html += '<div class="track-color-bar" style="background:#e0533d"></div>';
    html += '<div class="track-name master-name">MASTER</div>';
    html += '<div class="clip-indicator"></div>';
    html += '<div class="meter-row">';
    html += '<div class="meter-bar"><div class="' + meterClassML + '" style="width:' + (mml * 100) + '%"></div></div>';
    html += '<div class="meter-bar"><div class="' + meterClassMR + '" style="width:' + (mmr * 100) + '%"></div></div>';
    html += '</div>';
    // Master pan (disabled — master pan is rarely used)
    html += '<div class="pan-container" style="opacity:0.3"><input type="range" class="pan-slider" min="-1" max="1" value="0" disabled></div>';
    html += '<div class="fader-container">';
    html += '<input type="range" class="volume-fader" min="0" max="1" step="0.001" value="' + mv + '" data-track="-1" data-type="master-volume" orient="vertical">';
    html += '</div>';
    html += '<div class="volume-readout">' + volToDb(mv) + '</div>';
    // Empty mute/solo row for visual alignment
    html += '<div class="mute-solo-row" style="opacity:0"><button class="mute-btn">M</button><button class="solo-btn">S</button></div>';
    html += '<div class="sends-row" style="opacity:0"></div>';
    html += '</div>';

    els.container.innerHTML = html;
  }

  // ── Update dynamic values (faders, buttons, meters) without full re-render ──
  function updateDynamicValues(tracks, masterVolume, masterMeters) {
    for (const track of tracks) {
      const idx = track.index;
      const strip = els.container.querySelector('.channel-strip[data-track="' + idx + '"]');
      if (!strip) continue;

      // Volume fader — only if not recently adjusted
      if (!isRecentlyAdjusted('volume', idx)) {
        const fader = strip.querySelector('.volume-fader');
        if (fader && track.volume != null && Math.abs(parseFloat(fader.value) - track.volume) > 0.001) {
          fader.value = track.volume;
          const readout = strip.querySelector('.volume-readout');
          if (readout) readout.textContent = volToDb(track.volume);
        }
      }

      // Pan slider
      if (!isRecentlyAdjusted('pan', idx)) {
        const panSlider = strip.querySelector('.pan-slider');
        if (panSlider && track.pan != null && Math.abs(parseFloat(panSlider.value) - track.pan) > 0.001) {
          panSlider.value = track.pan;
        }
      }

      // Sends
      for (let s = 0; s < 4; s++) {
        if (!isRecentlyAdjusted('send', idx, s)) {
          const sendSlider = strip.querySelector('.send-slider[data-send="' + s + '"]');
          const sendVal = (track.sends || [])[s] || 0;
          if (sendSlider && Math.abs(parseFloat(sendSlider.value) - sendVal) > 0.001) {
            sendSlider.value = sendVal;
          }
        }
      }

      // Mute button
      const muteBtn = strip.querySelector('.mute-btn');
      if (muteBtn) muteBtn.classList.toggle('muted', !!track.muted);

      // Solo button
      const soloBtn = strip.querySelector('.solo-btn');
      if (soloBtn) soloBtn.classList.toggle('soloed', !!track.solo);

      // Clip indicator
      const clipDot = strip.querySelector('.clip-indicator');
      if (clipDot) {
        clipDot.className = track.isPlaying ? 'clip-indicator playing' : 'clip-indicator';
      }

      // Meter — always update (not user-controlled)
      const meterBars = strip.querySelectorAll('.meter-fill');
      const ml = track.meterLeft != null ? track.meterLeft : 0;
      const mr = track.meterRight != null ? track.meterRight : 0;
      if (meterBars[0]) {
        meterBars[0].style.width = (ml * 100) + '%';
        meterBars[0].className = ml > 0.9 ? 'meter-fill clip' : ml > 0.7 ? 'meter-fill hot' : 'meter-fill';
      }
      if (meterBars[1]) {
        meterBars[1].style.width = (mr * 100) + '%';
        meterBars[1].className = mr > 0.9 ? 'meter-fill clip' : mr > 0.7 ? 'meter-fill hot' : 'meter-fill';
      }
    }

    // Master strip
    const masterStrip = els.container.querySelector('.channel-strip.master');
    if (masterStrip) {
      const masterFader = masterStrip.querySelector('.volume-fader');
      if (masterFader && masterVolume != null && Math.abs(parseFloat(masterFader.value) - masterVolume) > 0.001) {
        masterFader.value = masterVolume;
        const readout = masterStrip.querySelector('.volume-readout');
        if (readout) readout.textContent = volToDb(masterVolume);
      }
      const mMeters = masterStrip.querySelectorAll('.meter-fill');
      const mml = masterMeters ? masterMeters.left : 0;
      const mmr = masterMeters ? masterMeters.right : 0;
      if (mMeters[0]) {
        mMeters[0].style.width = (mml * 100) + '%';
        mMeters[0].className = mml > 0.9 ? 'meter-fill clip' : mml > 0.7 ? 'meter-fill hot' : 'meter-fill';
      }
      if (mMeters[1]) {
        mMeters[1].style.width = (mmr * 100) + '%';
        mMeters[1].className = mmr > 0.9 ? 'meter-fill clip' : mmr > 0.7 ? 'meter-fill hot' : 'meter-fill';
      }
    }
  }

  // ── Poll state ──
  async function pollState() {
    const data = await apiGet('/api/ableton/mixer-state');
    if (!data || !data.ok) return;

    updateTransport(data);

    const tracks = data.tracks || [];
    const masterVol = data.masterVolume != null ? data.masterVolume : 0.85;
    const masterMeters = { left: data.masterMeterLeft || 0, right: data.masterMeterRight || 0 };

    // On first load or track count change, do full render
    if (!state || state.tracks.length !== tracks.length) {
      renderStrips(tracks, masterVol, masterMeters);
    } else {
      updateDynamicValues(tracks, masterVol, masterMeters);
    }

    state = data;
  }

  // ── Event delegation for mixer interactions ──
  function setupEventDelegation() {
    els.container.addEventListener('input', handleInput);
    els.container.addEventListener('change', handleInput);
    els.container.addEventListener('click', handleClick);

    // Transport
    els.btnPlay.addEventListener('click', onPlay);
    els.btnStop.addEventListener('click', onStop);
    els.btnTap.addEventListener('click', onTapTempo);
  }

  function handleInput(e) {
    const el = e.target;
    const type = el.dataset.type;
    if (!type) return;

    const trackIdx = parseInt(el.dataset.track, 10);
    const sendIdx = el.dataset.send != null ? parseInt(el.dataset.send, 10) : null;
    const val = parseFloat(el.value);

    if (isNaN(trackIdx)) return;

    switch (type) {
      case 'volume':
        markAdjusted('volume', trackIdx);
        debounceSend('vol_' + trackIdx, () => {
          apiPost('/api/ableton/track/' + trackIdx + '/volume', { volume: val });
        });
        // Update readout immediately for UX
        {
          const strip = els.container.querySelector('.channel-strip[data-track="' + trackIdx + '"]');
          if (strip) {
            const readout = strip.querySelector('.volume-readout');
            if (readout) readout.textContent = volToDb(val);
          }
        }
        break;

      case 'master-volume':
        markAdjusted('volume', -1);
        debounceSend('vol_-1', () => {
          apiPost('/api/ableton/master/volume', { volume: val });
        });
        {
          const masterStrip = els.container.querySelector('.channel-strip.master');
          if (masterStrip) {
            const readout = masterStrip.querySelector('.volume-readout');
            if (readout) readout.textContent = volToDb(val);
          }
        }
        break;

      case 'pan':
        markAdjusted('pan', trackIdx);
        debounceSend('pan_' + trackIdx, () => {
          apiPost('/api/ableton/track/' + trackIdx + '/pan', { pan: val });
        });
        break;

      case 'send':
        markAdjusted('send', trackIdx, sendIdx);
        debounceSend('send_' + trackIdx + '_' + sendIdx, () => {
          apiPost('/api/ableton/track/' + trackIdx + '/send/' + sendIdx, { value: val });
        });
        break;
    }
  }

  function handleClick(e) {
    const el = e.target.closest('[data-type]');
    if (!el) return;

    const type = el.dataset.type;
    const trackIdx = parseInt(el.dataset.track, 10);
    if (isNaN(trackIdx)) return;

    if (type === 'mute') {
      const muted = el.classList.contains('muted');
      const next = !muted;
      // Optimistic UI
      el.classList.toggle('muted', next);
      apiPost('/api/ableton/track/' + trackIdx + '/mute', { muted: next });
    }

    if (type === 'solo') {
      const soloed = el.classList.contains('soloed');
      const next = !soloed;
      el.classList.toggle('soloed', next);
      apiPost('/api/ableton/track/' + trackIdx + '/solo');
    }
  }

  async function onPlay() {
    await apiPost('/api/ableton/transport/play');
  }

  async function onStop() {
    await apiPost('/api/ableton/transport/stop');
  }

  // ── Tap Tempo ──
  let tapTimes = [];
  function onTapTempo() {
    const now = Date.now();
    tapTimes.push(now);
    // Keep only the last 5 taps
    if (tapTimes.length > 5) tapTimes.shift();

    // Flash the button
    els.btnTap.classList.add('tapping');
    setTimeout(() => els.btnTap.classList.remove('tapping'), 150);

    if (tapTimes.length >= 2) {
      // Average the intervals
      let total = 0;
      for (let i = tapTimes.length - 1; i >= Math.max(1, tapTimes.length - 4); i--) {
        total += tapTimes[i] - tapTimes[i - 1];
      }
      const count = Math.min(tapTimes.length - 1, 4);
      const avgMs = total / count;
      const bpm = Math.round(60000 / avgMs);
      if (bpm >= 20 && bpm <= 999) {
        els.tempoVal.textContent = bpm.toFixed(2);
        apiPost('/api/ableton/tempo', { bpm });
      }
    }

    // Reset taps if gap > 2 seconds
    if (tapTimes.length > 1 && (now - tapTimes[tapTimes.length - 2]) > 2000) {
      tapTimes = [now];
    }
  }

  // ── Safe HTML escaping ──
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Init ──
  function init() {
    cacheDom();
    setupEventDelegation();
    pollState();
    setInterval(pollState, POLL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
