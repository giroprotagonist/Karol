'use strict';
/**
 * Gap Phone Mirror — USB/wireless scrcpy over the player B-roll slot + optional
 * BlackHole loopback for faded audio (Ableton setups with a second BH device).
 *
 * The HDMI player uses alwaysOnTop 'screen-saver', so we must drop that level
 * while mirroring or the scrcpy window stays invisible behind the player.
 */

const { spawn, execFileSync, execFile } = require('child_process');
const fs = require('fs');

const SCRCPY = '/opt/homebrew/bin/scrcpy';
const ADB = '/opt/homebrew/bin/adb';
const SAS = '/opt/homebrew/bin/SwitchAudioSource';

let scrcpyProc = null;
let savedOutputDevice = null;
let activeRouting = {
  mode: 'off', // off | loopback | direct
  tap: null,
  house: null,
  adbOk: false,
  scrcpyRunning: false,
  error: '',
  lastBounds: null,
  scrcpyNoAudio: false,
};
/** Desired phone loudness 0..1 from controller Gap Phone fader. */
let desiredPhoneAudioLevel = 0.85;
let lastAndroidMusicIndex = -1;
let androidVolumeTimer = null;
/** Periodic adb wake while mirroring (--stay-awake conflicts with --no-control). */
let phoneWakeTimer = null;
/** @type {null | (() => void)} restore player always-on-top */
let restorePlayerLayer = null;

/** Scrcpy restores this on exit; long enough for a full DJ set. */
const PHONE_SCREEN_OFF_TIMEOUT_SEC = 86400;

function binExists(p) {
  try { return fs.existsSync(p); } catch (_) { return false; }
}

function sasList(type) {
  if (!binExists(SAS)) return [];
  try {
    return execFileSync(SAS, ['-a', '-t', type], { encoding: 'utf8', timeout: 5000 })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function sasCurrent(type) {
  if (!binExists(SAS)) return null;
  try {
    return execFileSync(SAS, ['-c', '-t', type], { encoding: 'utf8', timeout: 5000 }).trim() || null;
  } catch (_) {
    return null;
  }
}

function clamp01(n, fallback) {
  const x = Number(n);
  if (!isFinite(x)) return fallback;
  return Math.max(0, Math.min(1, x));
}

/**
 * Map Gap Phone fader (0..1) → Android STREAM_MUSIC index (0..15).
 * This is the only continuous volume control that works in direct/overlay mode
 * where scrcpy audio never passes through Electron.
 */
function setAndroidMusicVolume(level01, force) {
  if (!binExists(ADB)) return { ok: false, error: 'adb missing' };
  const max = 15;
  const idx = Math.max(0, Math.min(max, Math.round(clamp01(level01, 0) * max)));
  if (!force && idx === lastAndroidMusicIndex) {
    return { ok: true, index: idx, skipped: true };
  }
  lastAndroidMusicIndex = idx;
  try {
    // Sync so controller fader steps don't race (scrcpy restart / debounce).
    execFileSync(ADB, [
      'shell', 'cmd', 'media_session', 'volume',
      '--stream', '3', '--set', String(idx),
    ], {
      timeout: 4000,
      encoding: 'utf8',
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH || ''}` },
    });
    console.log('[phone-mirror] android STREAM_MUSIC →', idx + '/' + max);
    try {
      fs.appendFileSync('/tmp/karol-phone-mirror.log',
        new Date().toISOString() + ' android STREAM_MUSIC → ' + idx + '/' + max + '\n');
    } catch (_) {}
    return { ok: true, index: idx };
  } catch (e) {
    console.warn('[phone-mirror] android volume failed:', e && e.message);
    return { ok: false, error: e && e.message };
  }
}

/**
 * Apply controller Gap Phone level while mirror is (or will be) running.
 * - loopback: Electron <audio>.volume does continuous gain; keep phone media near full
 * - direct/overlay: duck via Android media volume (scrcpy mirrors that audio)
 * Also restarts scrcpy if --no-audio flag must flip (hard mute ↔ audible).
 */
function setPhoneAudioLevel(level01, opts) {
  opts = opts || {};
  desiredPhoneAudioLevel = clamp01(level01, desiredPhoneAudioLevel);
  const wantMute = desiredPhoneAudioLevel < 0.02;
  const mode = activeRouting.mode || 'direct';

  if (mode === 'loopback') {
    // Electron applies the fader; keep Android hot so loopback has headroom
    setAndroidMusicVolume(wantMute ? 0 : 1);
  } else {
    setAndroidMusicVolume(wantMute ? 0 : desiredPhoneAudioLevel);
  }

  if (!isRunning()) {
    return {
      ok: true,
      level: desiredPhoneAudioLevel,
      mode,
      scrcpyRunning: false,
    };
  }

  // Only restart to *restore* audio when scrcpy was started with --no-audio.
  // Muting uses Android STREAM_MUSIC=0 — no scrcpy restart (avoids volume races).
  const currentlyNoAudio = !!activeRouting.scrcpyNoAudio;
  if (!wantMute && currentlyNoAudio && opts.allowRestart !== false) {
    const bounds = activeRouting.lastBounds;
    console.log('[phone-mirror] unmute → restart scrcpy with audio', {
      level: desiredPhoneAudioLevel,
    });
    const result = startPhoneMirror(opts.playBounds || null, {
      playWin: opts.playWin,
      hostOnPrimary: !!(bounds && bounds.hostOnPrimary),
      slotBounds: bounds && !bounds.hostOnPrimary ? {
        x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      } : null,
      fullscreenDisplay: false,
      forceRestart: true,
      noAudio: false,
    });
    return {
      ok: !!result.ok,
      level: desiredPhoneAudioLevel,
      mode: activeRouting.mode,
      restarted: true,
      noAudio: false,
      error: result.error,
    };
  }

  return {
    ok: true,
    level: desiredPhoneAudioLevel,
    mode,
    scrcpyRunning: true,
    noAudio: currentlyNoAudio,
    androidIndex: lastAndroidMusicIndex,
  };
}

function schedulePhoneAudioLevel(level01, opts) {
  desiredPhoneAudioLevel = clamp01(level01, desiredPhoneAudioLevel);
  if (androidVolumeTimer) clearTimeout(androidVolumeTimer);
  androidVolumeTimer = setTimeout(() => {
    androidVolumeTimer = null;
    setPhoneAudioLevel(desiredPhoneAudioLevel, opts);
  }, 80);
  return { ok: true, scheduled: true, level: desiredPhoneAudioLevel };
}

function sasSet(name, type) {
  if (!binExists(SAS) || !name) return false;
  try {
    execFileSync(SAS, ['-s', name, '-t', type], { encoding: 'utf8', timeout: 5000 });
    return true;
  } catch (e) {
    console.warn('[phone-mirror] SwitchAudioSource -s failed:', name, e && e.message);
    return false;
  }
}

function listAdbDevices() {
  if (!binExists(ADB)) return [];
  try {
    const out = execFileSync(ADB, ['devices'], { encoding: 'utf8', timeout: 8000 });
    return out.split('\n').slice(1)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('*'))
      .map((l) => {
        const parts = l.split(/\s+/);
        return { id: parts[0], status: parts[1] || '' };
      })
      .filter((d) => d.id);
  } catch (_) {
    return [];
  }
}

function adbShellArgs(args) {
  return execFileSync(ADB, ['shell', ...args], {
    timeout: 5000,
    encoding: 'utf8',
    env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH || ''}` },
  });
}

/**
 * Keep the S24 awake without scrcpy --stay-awake (incompatible with --no-control).
 * Uses USB-powered stay-on + a long screen-off timeout; scrcpy also gets
 * --screen-off-timeout which restores the prior value on exit.
 */
function applyPhoneStayAwake() {
  if (!binExists(ADB)) return { ok: false, error: 'adb missing' };
  try {
    // Stay on while USB (or AC) powered — does not require scrcpy control channel.
    try { adbShellArgs(['svc', 'power', 'stayon', 'usb']); } catch (_) {
      try { adbShellArgs(['svc', 'power', 'stayon', 'true']); } catch (__) {}
    }
    try {
      adbShellArgs([
        'settings', 'put', 'system', 'screen_off_timeout',
        String(PHONE_SCREEN_OFF_TIMEOUT_SEC * 1000),
      ]);
    } catch (_) {}
    try { adbShellArgs(['input', 'keyevent', 'KEYCODE_WAKEUP']); } catch (_) {}
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message };
  }
}

function clearPhoneStayAwake() {
  if (!binExists(ADB)) return;
  try {
    // Return to normal: only stay on while charging if user prefers; false is safest restore.
    adbShellArgs(['svc', 'power', 'stayon', 'false']);
  } catch (_) {}
}

function startPhoneWakeKeepalive() {
  stopPhoneWakeKeepalive();
  applyPhoneStayAwake();
  phoneWakeTimer = setInterval(() => {
    try { applyPhoneStayAwake(); } catch (_) {}
  }, 60_000);
  if (typeof phoneWakeTimer.unref === 'function') phoneWakeTimer.unref();
}

function stopPhoneWakeKeepalive(restore) {
  if (phoneWakeTimer) {
    clearInterval(phoneWakeTimer);
    phoneWakeTimer = null;
  }
  if (restore) clearPhoneStayAwake();
}

function pickRouting() {
  const outputs = sasList('output');
  const inputs = sasList('input');
  const house = sasCurrent('output') || outputs.find((n) => /BlackHole 2ch/i.test(n)) || null;
  const bh2Out = outputs.find((n) => /^BlackHole 2ch$/i.test(n));
  const hasInput = (name) => !!(name && inputs.some((i) => i === name || i.toLowerCase() === name.toLowerCase()));

  let tap = null;
  if (bh2Out && house && bh2Out !== house && hasInput(bh2Out)) tap = bh2Out;

  if (tap && house && tap !== house) {
    return { mode: 'loopback', tap, house };
  }
  return { mode: 'direct', tap: null, house };
}

function getStatus() {
  const adb = listAdbDevices().filter((d) => d.status === 'device');
  const unauthorized = listAdbDevices().filter((d) => d.status === 'unauthorized');
  let error = activeRouting.error || '';
  if (!binExists(SCRCPY)) error = error || 'scrcpy not found at /opt/homebrew/bin/scrcpy';
  else if (!binExists(ADB)) error = error || 'adb not found';
  else if (!adb.length && unauthorized.length) error = error || 'Phone unauthorized — accept USB debugging on the S24';
  else if (!adb.length) error = error || 'No USB phone — plug in S24 and enable USB debugging';
  else if (!binExists(SAS)) error = error || 'SwitchAudioSource missing (brew install switchaudio-osx)';
  return {
    adbOk: adb.length > 0,
    adbCount: adb.length,
    scrcpyRunning: !!(scrcpyProc && !scrcpyProc.killed),
    scrcpyInstalled: binExists(SCRCPY),
    switchAudioInstalled: binExists(SAS),
    blackHoleInstalled: sasList('output').some((n) => /BlackHole/i.test(n)),
    mode: activeRouting.mode,
    tap: activeRouting.tap,
    house: activeRouting.house,
    error,
  };
}

function stopScrcpyProcess() {
  if (!scrcpyProc) return;
  const proc = scrcpyProc;
  scrcpyProc = null;
  try { proc.kill('SIGKILL'); } catch (_) {}
  activeRouting.scrcpyRunning = false;
}

function restoreOutputDevice() {
  if (savedOutputDevice) {
    const name = savedOutputDevice;
    savedOutputDevice = null;
    sasSet(name, 'output');
    console.log('[phone-mirror] Restored output device:', name);
  }
}

function restorePlayerAlwaysOnTop() {
  if (typeof restorePlayerLayer === 'function') {
    try { restorePlayerLayer(); } catch (e) {
      console.warn('[phone-mirror] restore player layer failed:', e && e.message);
    }
    restorePlayerLayer = null;
  }
}

/**
 * Do NOT leave macOS simpleFullscreen/fullscreen — that triggers
 * NSWindow setStyleMask crashes (EXC_BREAKPOINT) on pause.
 *
 * Prefer laptop-hosted scrcpy + desktopCapturer when Screen Recording is
 * granted. HDMI overlay mode drops the player from 'screen-saver' so the
 * always-on-top scrcpy window can sit in the phone slot on the external display.
 */
function lowerPlayerForMirror(playWin) {
  if (!playWin || (typeof playWin.isDestroyed === 'function' && playWin.isDestroyed())) return;
  if (restorePlayerLayer) {
    // Already lowered — keep floating / off for overlay
    try { playWin.setAlwaysOnTop(false); } catch (_) {}
    return;
  }
  try {
    restorePlayerLayer = () => {
      try {
        if (playWin && !(typeof playWin.isDestroyed === 'function' && playWin.isDestroyed())) {
          playWin.setAlwaysOnTop(true, 'screen-saver');
        }
      } catch (_) {
        try { playWin.setAlwaysOnTop(true); } catch (__) {}
      }
    };
    // Fully drop always-on-top so scrcpy --always-on-top wins z-order on HDMI
    playWin.setAlwaysOnTop(false);
    console.log('[phone-mirror] Player alwaysOnTop dropped for HDMI overlay');
  } catch (e) {
    console.warn('[phone-mirror] lowerPlayerForMirror failed:', e && e.message);
    try { playWin.setAlwaysOnTop(false); } catch (_) {}
  }
}

/** Prefer B-roll slot rect; or primary-display host window for capture. */
function resolveMirrorBounds(bounds, slotBounds, opts) {
  opts = opts || {};
  if (opts.hostOnPrimary) {
    try {
      const { screen } = require('electron');
      const primary = screen.getPrimaryDisplay();
      const wa = primary.workArea || primary.bounds;
      // Small portrait host on the laptop — captured into HDMI interstitial.
      return {
        x: Math.round(wa.x + 24),
        y: Math.round(wa.y + 24),
        width: 360,
        height: 780,
        fullscreen: false,
        hostOnPrimary: true,
      };
    } catch (_) {
      return { x: 40, y: 40, width: 360, height: 780, fullscreen: false, hostOnPrimary: true };
    }
  }
  if (slotBounds
    && Number.isFinite(slotBounds.x) && Number.isFinite(slotBounds.y)
    && Number(slotBounds.width) > 80 && Number(slotBounds.height) > 80) {
    return {
      x: Math.round(slotBounds.x),
      y: Math.round(slotBounds.y),
      width: Math.round(slotBounds.width),
      height: Math.round(slotBounds.height),
      fullscreen: false,
    };
  }
  if (bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) {
    const w = Math.max(320, Math.round(bounds.width || 1280));
    const h = Math.max(240, Math.round(bounds.height || 720));
    const padX = Math.round(w * 0.04);
    const padY = Math.round(h * 0.16);
    const centerH = Math.round(h * 0.52);
    const qr = Math.min(centerH, Math.round(w * 0.28));
    const gap = Math.round(w * 0.02);
    return {
      x: Math.round(bounds.x + padX + qr + gap),
      y: Math.round(bounds.y + padY),
      width: Math.max(200, w - padX * 2 - qr - gap),
      height: centerH,
      fullscreen: false,
    };
  }
  return { x: 100, y: 80, width: 720, height: 480, fullscreen: false };
}

/**
 * @param {{ x:number, y:number, width:number, height:number }|null} bounds playWin bounds
 * @param {{ playWin?: object, slotBounds?: object, fullscreenDisplay?: boolean }|null} opts
 */
function startPhoneMirror(bounds, opts) {
  opts = opts || {};
  activeRouting.error = '';
  if (typeof opts.audioLevel === 'number' && isFinite(opts.audioLevel)) {
    desiredPhoneAudioLevel = clamp01(opts.audioLevel, desiredPhoneAudioLevel);
  }
  const status0 = getStatus();
  if (!status0.scrcpyInstalled) {
    activeRouting.error = status0.error;
    return { ok: false, error: activeRouting.error, status: getStatus() };
  }
  if (!status0.adbOk) {
    activeRouting.error = status0.error;
    return { ok: false, error: activeRouting.error, status: getStatus() };
  }

  // Reuse a healthy scrcpy instead of kill/restart — rapid dual ensurePhoneMirror
  // calls were SIGKILL-racing the window (~200ms) and breaking HDMI capture.
  if (scrcpyProc && !scrcpyProc.killed && activeRouting.scrcpyRunning && !opts.forceRestart) {
    console.log('[phone-mirror] Already running — reuse existing window');
    try {
      fs.appendFileSync('/tmp/karol-phone-mirror.log',
        new Date().toISOString() + ' reuse\n');
    } catch (_) {}
    // Still apply live phone fader (may flip --no-audio via restart)
    try {
      setPhoneAudioLevel(desiredPhoneAudioLevel, {
        allowRestart: true,
        playWin: opts.playWin,
        playBounds: bounds,
      });
    } catch (_) {}
    return {
      ok: true,
      reused: true,
      routing: {
        mode: activeRouting.mode,
        tap: activeRouting.tap,
        house: activeRouting.house,
      },
      status: getStatus(),
    };
  }

  stopScrcpyProcess();
  try {
    execFileSync('/usr/bin/pkill', ['-f', 'Karol Phone Mirror'], { timeout: 2000 });
  } catch (_) {}
  // Brief settle so pkill doesn't race the next spawn
  try {
    const { execFileSync } = require('child_process');
    execFileSync('/bin/sleep', ['0.15'], { timeout: 1000 });
  } catch (_) {}
  restoreOutputDevice();

  const routing = pickRouting();
  activeRouting.mode = routing.mode;
  activeRouting.tap = routing.tap;
  activeRouting.house = routing.house;

  savedOutputDevice = sasCurrent('output');
  if (routing.mode === 'loopback' && routing.tap) {
    if (!sasSet(routing.tap, 'output')) {
      console.warn('[phone-mirror] Could not switch to tap device; falling back to direct');
      activeRouting.mode = 'direct';
      activeRouting.tap = null;
    } else {
      console.log('[phone-mirror] Loopback: scrcpy →', routing.tap, '→ Electron →', routing.house);
    }
  } else {
    console.log('[phone-mirror] Direct audio mode (house=', routing.house, ') — hard cut');
  }

  if (opts.playWin) lowerPlayerForMirror(opts.playWin);

  const win = resolveMirrorBounds(bounds, opts.slotBounds, opts);
  console.log('[phone-mirror] scrcpy window', win);
  try {
    fs.appendFileSync('/tmp/karol-phone-mirror.log',
      new Date().toISOString() + ' start ' + JSON.stringify(win) + '\n');
  } catch (_) {}

  // --stay-awake is incompatible with --no-control (scrcpy exits).
  // --screen-off-timeout uses adb settings (works with --no-control) and
  // restores the previous timeout when scrcpy exits. Karol also runs
  // `svc power stayon usb` + a 60s wakeup keepalive while mirroring.
  const args = [
    '--no-control',
    '--window-borderless',
    '--no-window-aspect-ratio-lock',
    '--render-fit=letterbox',
    '--max-size', '1280',
    '--video-bit-rate', '6M',
    '--audio-buffer', '50',
    '--screen-off-timeout', String(PHONE_SCREEN_OFF_TIMEOUT_SEC),
    '--window-title', 'Karol Phone Mirror',
    '--window-x', String(win.x),
    '--window-y', String(win.y),
    '--window-width', String(win.width),
    '--window-height', String(win.height),
  ];
  try { startPhoneWakeKeepalive(); } catch (_) {}
  // Direct audio can't be ducked from Electron — mute at fader near zero
  const noAudio = !!(opts.noAudio || opts.muteAudio
    || (opts.noAudio !== false && desiredPhoneAudioLevel < 0.02));
  activeRouting.scrcpyNoAudio = noAudio;
  if (noAudio) {
    args.push('--no-audio');
    console.log('[phone-mirror] --no-audio (phone fader muted)');
  }
  // Host on laptop for capture — keep it visible but not forever-on-top of DJ UI
  if (!win.hostOnPrimary) args.splice(1, 0, '--always-on-top');

  try {
    scrcpyProc = spawn(SCRCPY, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH || ''}` },
      detached: false,
    });
  } catch (e) {
    stopPhoneWakeKeepalive(true);
    restoreOutputDevice();
    restorePlayerAlwaysOnTop();
    activeRouting.mode = 'off';
    activeRouting.error = e.message || 'Failed to spawn scrcpy';
    return { ok: false, error: activeRouting.error, status: getStatus() };
  }

  const thisProc = scrcpyProc;
  activeRouting.scrcpyRunning = true;
  activeRouting.lastBounds = win;
  // Re-apply Android media volume after connect (apps often reset STREAM_MUSIC)
  try {
    lastAndroidMusicIndex = -1;
    setPhoneAudioLevel(desiredPhoneAudioLevel, { allowRestart: false });
  } catch (_) {}
  scrcpyProc.stdout.on('data', (d) => {
    const s = String(d || '').trim();
    if (s) {
      console.log('[scrcpy]', s.slice(0, 200));
      try { fs.appendFileSync('/tmp/karol-phone-mirror.log', s.slice(0, 300) + '\n'); } catch (_) {}
    }
  });
  scrcpyProc.stderr.on('data', (d) => {
    const s = String(d || '').trim();
    if (s) {
      console.warn('[scrcpy]', s.slice(0, 300));
      try { fs.appendFileSync('/tmp/karol-phone-mirror.log', 'ERR ' + s.slice(0, 300) + '\n'); } catch (_) {}
    }
  });
  scrcpyProc.on('exit', (code, signal) => {
    console.log('[phone-mirror] scrcpy exited', code, signal || '');
    try {
      fs.appendFileSync('/tmp/karol-phone-mirror.log',
        new Date().toISOString() + ' exit ' + code + ' ' + (signal || '') + '\n');
    } catch (_) {}
    // Ignore stale exit from a forceRestart'd process — don't clobber the replacement
    // or bounce the player back to screen-saver over the new overlay window.
    if (scrcpyProc !== thisProc) return;
    scrcpyProc = null;
    activeRouting.scrcpyRunning = false;
    stopPhoneWakeKeepalive(true);
    restorePlayerAlwaysOnTop();
  });

  return {
    ok: true,
    routing: {
      mode: activeRouting.mode,
      tap: activeRouting.tap,
      house: activeRouting.house,
    },
    bounds: win,
    status: getStatus(),
  };
}

/**
 * Reposition by restarting scrcpy once the player reports the B-roll slot rect.
 * Skips if already within ~24px to avoid flicker.
 */
function repositionPhoneMirror(slotBounds, opts) {
  opts = opts || {};
  if (!isRunning()) return { ok: false, error: 'not running' };
  if (!slotBounds || !(Number(slotBounds.width) > 80)) return { ok: false, error: 'bad slot' };
  const prev = activeRouting.lastBounds;
  if (prev) {
    const dx = Math.abs(prev.x - slotBounds.x) + Math.abs(prev.y - slotBounds.y)
      + Math.abs(prev.width - slotBounds.width) + Math.abs(prev.height - slotBounds.height);
    // Ignore tiny layout jitter / double reports (was forceRestart-thrashing scrcpy)
    if (dx < 48) return { ok: true, skipped: true, bounds: prev };
  }
  console.log('[phone-mirror] Reposition to B-roll slot', slotBounds);
  return startPhoneMirror(opts.playBounds || null, {
    playWin: opts.playWin,
    slotBounds,
    fullscreenDisplay: false,
    forceRestart: true,
  });
}

function stopPhoneMirror() {
  stopScrcpyProcess();
  stopPhoneWakeKeepalive(true);
  restoreOutputDevice();
  restorePlayerAlwaysOnTop();
  activeRouting.mode = 'off';
  activeRouting.tap = null;
  activeRouting.house = null;
  activeRouting.error = '';
  return { ok: true, status: getStatus() };
}

function isRunning() {
  return !!(scrcpyProc && !scrcpyProc.killed);
}

function checkAdbAsync() {
  return new Promise((resolve) => {
    if (!binExists(ADB)) {
      resolve({ adbOk: false, error: 'adb not found' });
      return;
    }
    execFile(ADB, ['devices'], { timeout: 8000 }, (err, stdout) => {
      if (err) {
        resolve({ adbOk: false, error: err.message });
        return;
      }
      const devices = String(stdout || '').split('\n').slice(1)
        .map((l) => l.trim())
        .filter((l) => /\sdevice$/.test(l));
      resolve({
        adbOk: devices.length > 0,
        adbCount: devices.length,
        error: devices.length ? '' : 'No USB phone',
      });
    });
  });
}

module.exports = {
  startPhoneMirror,
  stopPhoneMirror,
  repositionPhoneMirror,
  getStatus,
  isRunning,
  pickRouting,
  checkAdbAsync,
  setPhoneAudioLevel,
  schedulePhoneAudioLevel,
  SCRCPY,
  ADB,
};
