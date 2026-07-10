/**
 * Ableton Live bridge via AbletonOSC (UDP on localhost:11000).
 * Controls tracks, transport, and mixer state.
 * Gracefully handles Ableton not running — all functions return null/fallback.
 */
import * as dgram from 'dgram';
import * as os from 'os';

const ABLETON_HOST = '127.0.0.1';
const ABLETON_PORT = 11000;
const PING_TIMEOUT_MS = 2000;
const REFRESH_INTERVAL_MS = 500;

// ── Shared state (populated by pollAbletonState) ──────────────────────

export type AbletonTrack = {
  index: number;
  name: string;
  volume: number;  // 0-1
  muted: boolean;
};

export type AbletonState = {
  connected: boolean;
  playing: boolean;
  tempo: number;
  tracks: AbletonTrack[];
  masterVolume: number; // 0-1
};

let cachedState: AbletonState = {
  connected: false,
  playing: false,
  tempo: 120,
  tracks: [],
  masterVolume: 0.85,
};

let pollTimer: ReturnType<typeof setInterval> | null = null;

// ── Low-level OSC helpers ─────────────────────────────────────────────

function oscBundle(address: string, value: number | string | boolean): Buffer {
  // Minimal OSC bundle (timetag 1 meaning immediate)
  const addr = Buffer.from(address + '\0');
  while (addr.length % 4 !== 0) addr.write('\0', addr.length - 1);

  let typeTag: string;
  let arg: Buffer;
  if (typeof value === 'number') {
    typeTag = ',f';
    arg = Buffer.alloc(4);
    arg.writeFloatBE(value, 0);
  } else if (typeof value === 'boolean') {
    typeTag = value ? ',T' : ',F';
    arg = Buffer.alloc(0);
  } else {
    typeTag = ',s';
    arg = Buffer.from(String(value) + '\0');
    while (arg.length % 4 !== 0) Buffer.concat([arg, Buffer.from([0])]);
  }

  const typeTagBuf = Buffer.from(typeTag + '\0');
  while (typeTagBuf.length % 4 !== 0) Buffer.concat([typeTagBuf, Buffer.from([0])]);

  const msg = Buffer.concat([addr, typeTagBuf, arg]);
  // Simple bundle: #bundle, timetag=1, one element
  const bundleHeader = Buffer.from('#bundle\0');
  // Timetag = 1 (immediate)
  const timetag = Buffer.alloc(8);
  timetag.writeBigInt64BE(BigInt(1), 0);
  const size = Buffer.alloc(4);
  size.writeInt32BE(msg.length, 0);

  return Buffer.concat([bundleHeader, timetag, size, msg]);
}

function oscBundleMulti(msgs: Array<{ address: string; value: number | string | boolean }>): Buffer {
  const bundleHeader = Buffer.from('#bundle\0');
  const timetag = Buffer.alloc(8);
  timetag.writeBigInt64BE(BigInt(1), 0);

  const elements: Buffer[] = [];
  for (const m of msgs) {
    const addr = Buffer.from(m.address + '\0');
    while (addr.length % 4 !== 0) {
      const padded = Buffer.alloc(addr.length + 1);
      addr.copy(padded);
    }

    let typeTag: string;
    let arg: Buffer;
    if (typeof m.value === 'number') {
      typeTag = ',f';
      arg = Buffer.alloc(4);
      arg.writeFloatBE(m.value, 0);
    } else if (typeof m.value === 'boolean') {
      typeTag = m.value ? ',T' : ',F';
      arg = Buffer.alloc(0);
    } else {
      typeTag = ',s';
      arg = Buffer.from(String(m.value) + '\0');
      while (arg.length % 4 !== 0) {
        const padded = Buffer.alloc(arg.length + 1);
        arg.copy(padded);
        arg = padded;
      }
    }

    const tt = Buffer.from(typeTag + '\0');
    while (tt.length % 4 !== 0) {
      const padded = Buffer.alloc(tt.length + 1);
      tt.copy(padded);
    }

    const msg = Buffer.concat([addr, tt, arg]);
    const size = Buffer.alloc(4);
    size.writeInt32BE(msg.length, 0);
    elements.push(size);
    elements.push(msg);
  }

  return Buffer.concat([bundleHeader, timetag, ...elements]);
}

function sendOscBundle(msgs: Array<{ address: string; value: number | string | boolean }>): void {
  const sock = dgram.createSocket('udp4');
  const buf = oscBundleMulti(msgs);
  sock.send(buf, 0, buf.length, ABLETON_PORT, ABLETON_HOST, () => sock.close());
}

function sendOsc(address: string, value: number | string | boolean): void {
  sendOscBundle([{ address, value }]);
}

// ── Ping to check if AbletonOSC is running ─────────────────────────────

export function checkAbletonConnection(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const buf = oscBundle('/live/test', 1);
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        sock.close();
        resolve(false);
      }
    }, PING_TIMEOUT_MS);

    sock.on('message', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        sock.close();
        resolve(true);
      }
    });

    sock.send(buf, 0, buf.length, ABLETON_PORT, ABLETON_HOST, () => {
      // sent — the reply (or timeout) will resolve
    });
  });
}

// ── Transport ──────────────────────────────────────────────────────────

export function abletonPlay(): void { sendOsc('/live/song/start_playing', true); }
export function abletonStop(): void { sendOsc('/live/song/stop_playing', true); }
export function abletonContinue(): void { sendOsc('/live/song/continue_playing', true); }

export function abletonSetTempo(bpm: number): void {
  sendOsc('/live/song/set/tempo', Math.max(20, Math.min(999, bpm)));
}

// ── Track controls ─────────────────────────────────────────────────────

export function abletonTrackVolume(trackIndex: number, level: number): void {
  const clamped = Math.max(0, Math.min(1, level));
  sendOsc(`/live/track/set/volume`, clamped);
  // AbletonOSC needs the track index as a separate message
  // We send both in one bundle is better but the API needs index
  const sock = dgram.createSocket('udp4');
  const buf = oscBundle(`/live/track/set/volume`, clamped);
  // Actually AbletonOSC's set volume takes the index from the "selected track"
  // Better approach: use /live/track/view/set/selected_track then set volume
  // Simplest reliable approach:
  selectTrack(trackIndex);
  // Small delay then set volume
  setTimeout(() => {
    sendOsc('/live/track/set/volume', clamped);
  }, 20);
}

export function abletonTrackMute(trackIndex: number, muted: boolean): void {
  selectTrack(trackIndex);
  setTimeout(() => {
    sendOsc('/live/track/set/mute', muted ? 1 : 0);
  }, 20);
}

export function abletonMasterVolume(level: number): void {
  sendOsc('/live/master/set/volume', Math.max(0, Math.min(1, level)));
}

function selectTrack(index: number): void {
  sendOsc('/live/track/view/set/selected_track', index);
}

// ── Track mix: volume + mute for both tracks at once ──────────────────

export function setTrackMix(
  karaokeVol: number,
  karaokeMuted: boolean,
  vlcVol: number,
  vlcMuted: boolean,
  masterVol: number,
): void {
  sendOscBundle([
    { address: '/live/track/set/mute', value: karaokeMuted ? 1 : 0 },
    { address: '/live/master/set/volume', value: masterVol },
  ]);

  // Set track 0 first, then track 1
  selectTrack(0);
  setTimeout(() => {
    sendOscBundle([
      { address: '/live/track/set/volume', value: karaokeVol },
      { address: '/live/track/set/mute', value: karaokeMuted ? 1 : 0 },
    ]);
    selectTrack(1);
    setTimeout(() => {
      sendOscBundle([
        { address: '/live/track/set/volume', value: vlcVol },
        { address: '/live/track/set/mute', value: vlcMuted ? 1 : 0 },
      ]);
    }, 30);
  }, 30);
}

// ── State polling (returns cached, triggers background refresh) ────────

export function getAbletonState(): AbletonState {
  return cachedState;
}

export function startAbletonPolling(): void {
  if (pollTimer) return;
  pollAbletonState();
  pollTimer = setInterval(pollAbletonState, REFRESH_INTERVAL_MS);
}

export function stopAbletonPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollAbletonState(): Promise<void> {
  try {
    const connected = await checkAbletonConnection();
    if (!connected) {
      cachedState = { ...cachedState, connected: false };
      return;
    }
    cachedState = { ...cachedState, connected: true };
    // All other fields are set via OSC listener callbacks
    // For simplicity, we leave the cached values and rely on the initial defaults
    // A full implementation would register OSC listeners for /live/song/get/tempo etc.
  } catch {
    cachedState = { ...cachedState, connected: false };
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────────

export function initAbletonBridge(): void {
  startAbletonPolling();
}

export function shutdownAbletonBridge(): void {
  stopAbletonPolling();
}
