'use strict';

const path = require('path');
const fs = require('fs');
const { exec, execFile } = require('child_process');

const SAS = '/opt/homebrew/bin/SwitchAudioSource';
const TV_NAME = process.env.KAROL_TV_NAME || 'Living room TV';
const BLACKHOLE_NAME = process.env.KAROL_BLACKHOLE_NAME || 'BlackHole 2ch';

function resolveScriptsDir() {
  const candidates = [
    process.env.KAROL_SCRIPTS_DIR,
    path.join(process.resourcesPath || '', 'scripts'),
    path.resolve(__dirname),
    path.resolve(__dirname, '..', 'scripts'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'blackhole-44100.swift')) || fs.existsSync(path.join(dir, 'blackhole-44100'))) {
      return dir;
    }
  }
  return path.resolve(__dirname, '..', 'scripts');
}

const SCRIPTS_DIR = resolveScriptsDir();

function runScript(binName, cb) {
  const shPath = path.join(SCRIPTS_DIR, binName + '.sh');
  const binPath = path.join(SCRIPTS_DIR, binName);
  const target = fs.existsSync(shPath) ? shPath : binPath;
  if (!fs.existsSync(target)) {
    if (cb) cb(new Error('not found: ' + target));
    return;
  }
  execFile(target, { timeout: 8000 }, (err, stdout, stderr) => {
    if (cb) cb(err, stdout, stderr);
  });
}

function alignBlackHoleSampleRate(cb) {
  const binPath = path.join(SCRIPTS_DIR, 'blackhole-44100');
  if (!fs.existsSync(binPath)) {
    const msg = '[blackhole-sr] Binary not found at ' + binPath + ' (run: swiftc -o scripts/blackhole-44100 scripts/blackhole-44100.swift)';
    console.log(msg);
    if (cb) cb(new Error(msg));
    return;
  }
  execFile(binPath, { timeout: 8000 }, (err, stdout, stderr) => {
    if (err) {
      console.warn('[blackhole-sr] Failed: ' + (stderr || err.message).trim());
      if (cb) cb(err);
      return;
    }
    console.log('[blackhole-sr] ' + (stdout || '').trim());
    if (cb) cb(null, stdout);
  });
}

function setDefaultKarolAggregate(cb) {
  runScript('set-default-karol', (err, stdout, stderr) => {
    if (err) console.warn('[audio-default] Failed: ' + (stderr || err.message).trim());
    else console.log('[audio-default] ' + (stdout || '').trim());
    if (cb) cb(err);
  });
}

function getCurrentOutputSync() {
  if (!fs.existsSync(SAS)) return null;
  try {
    const { execFileSync } = require('child_process');
    return execFileSync(SAS, ['-c', '-t', 'output'], { encoding: 'utf8', timeout: 5000 }).trim() || null;
  } catch (_) {
    return null;
  }
}

function probeUmcPresent(cb) {
  exec('system_profiler SPAudioDataType', { timeout: 8000, encoding: 'utf8' }, (err, text) => {
    if (err) {
      if (cb) cb(false);
      return;
    }
    cb(/UMC404/i.test(text));
  });
}

/**
 * On startup: align BlackHole to 44100 when mirroring to TV through Live.
 * Skips when UMC DJ path is active (unless KAROL_AUDIO_MODE=live-tv).
 */
function configureAudioOnStartup() {
  const mode = String(process.env.KAROL_AUDIO_MODE || '').trim().toLowerCase();
  const currentOut = getCurrentOutputSync();
  const liveTvPath = mode === 'live-tv' || currentOut === TV_NAME;

  probeUmcPresent((umcPresent) => {
    if (!liveTvPath) {
      if (umcPresent) {
        console.log('[karol-audio] UMC404HD detected — 48 kHz DJ path (Karol aggregate). BlackHole align skipped.');
      } else {
        console.log('[karol-audio] Output: ' + (currentOut || 'unknown') + ' — set KAROL_AUDIO_MODE=live-tv for mirror+Live path');
      }
      return;
    }

    console.log('[karol-audio] Live→TV path' +
      (currentOut === TV_NAME ? ' (TV is default output)' : '') +
      (mode === 'live-tv' ? ' (KAROL_AUDIO_MODE=live-tv)' : '') +
      ' — aligning BlackHole to 44100 Hz');
    if (umcPresent) {
      console.warn('[karol-audio] UMC404HD is connected — do not route UMC/Shure in Live for this mode (48 kHz only)');
    }
    alignBlackHoleSampleRate();
  });
}

module.exports = {
  SCRIPTS_DIR,
  alignBlackHoleSampleRate,
  setDefaultKarolAggregate,
  configureAudioOnStartup,
  getCurrentOutputSync,
  TV_NAME,
  BLACKHOLE_NAME,
};
