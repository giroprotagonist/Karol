// Karol Electron — Downloads module
// yt-dlp download management and karaoke pipeline.
// Ported from api-server/index.js download handling.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const library = require('./library');

const YT_DLP_PATH = '/opt/homebrew/bin/yt-dlp';
const FFPROBE_PATH = '/opt/homebrew/bin/ffprobe';
const HOMEBREW_BIN = '/opt/homebrew/bin';
// Dir with both ffmpeg + ffprobe — required when Electron PATH lacks Homebrew
const FFMPEG_LOCATION = HOMEBREW_BIN;
// Must use absolute path — electron-builder's .asar archive doesn't include parent directories
const MAKE_KARAOKE_SCRIPT = '/Users/macdonk/Documents/GitHub/Karol/tools/make-karaoke-video.py';
const YT_COOKIES = '/Users/macdonk/Documents/GitHub/Karol/.karol/yt-cookies.txt';

// Prefer H.264 ≤1080p — AV1 "best" often yields corrupt/short video that freezes Chromium.
// mweb first: web/tv clients frequently lose adaptive HTTPS formats under SABR.
const YTDLP_FORMAT =
  'bv*[vcodec^=avc1][height<=1080]+ba/bv*[vcodec*=avc1][height<=1080]+ba/b[ext=mp4][vcodec*=avc1][height<=1080]/b[height<=720]/b[height<=1080]/b';
const YTDLP_PLAYER_CLIENT = 'youtube:player_client=mweb,tv,web';

/** Env for child processes: GUI/Dock launches omit Homebrew from PATH. */
function childEnv(extra = {}) {
  const base = process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin';
  const parts = base.split(':').filter(Boolean);
  const path = [HOMEBREW_BIN, ...parts.filter((p) => p !== HOMEBREW_BIN)].join(':');
  return { ...process.env, PATH: path, PYTHONUNBUFFERED: '1', ...extra };
}

function ytdlpFfmpegArgs() {
  return ['--ffmpeg-location', FFMPEG_LOCATION];
}

// Prefer exported logged-in cookie jar (refreshed from Chrome by Electron / pipeline)
function ytdlpAuthArgs() {
  const args = ytdlpFfmpegArgs();
  try {
    if (fs.existsSync(YT_COOKIES) && fs.statSync(YT_COOKIES).size > 100) {
      return [...args, '--cookies', YT_COOKIES];
    }
  } catch {}
  return [...args, '--cookies-from-browser', 'chrome'];
}

/**
 * Reject truncated/corrupt muxes that still open in players (frozen video, short AV1).
 * Compares video-stream duration to container (+ optional info.json) duration/filesize.
 */
function verifyDownloadedVideo(mp4Path, infoPath) {
  if (!mp4Path || !fs.existsSync(mp4Path)) {
    return { ok: false, detail: 'missing-file' };
  }
  let size = 0;
  try { size = fs.statSync(mp4Path).size; } catch { return { ok: false, detail: 'stat-fail' }; }
  if (size < 50_000) return { ok: false, detail: 'too-small:' + size };

  let expectedDuration = null;
  let expectedSize = null;
  const infoCandidates = [
    infoPath,
    mp4Path.replace(/\.mp4$/i, '.info.json'),
    mp4Path.replace(/-karaoke\.mp4$/i, '-karaoke.info.json'),
  ].filter(Boolean);
  for (const p of infoCandidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const info = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (info.duration != null) expectedDuration = Number(info.duration);
      expectedSize = info.filesize || info.filesize_approx || null;
      if (expectedDuration || expectedSize) break;
    } catch { /* ignore */ }
  }

  const probe = spawnSync(FFPROBE_PATH, [
    '-v', 'error',
    '-show_entries', 'format=duration,size:stream=codec_type,codec_name,duration',
    '-of', 'json',
    mp4Path,
  ], { encoding: 'utf8', timeout: 60_000 });
  if (probe.status !== 0) {
    return { ok: false, detail: 'ffprobe-fail:' + String(probe.stderr || probe.error || '').slice(0, 120) };
  }
  let data;
  try { data = JSON.parse(probe.stdout || '{}'); } catch (e) {
    return { ok: false, detail: 'ffprobe-json:' + e.message };
  }
  const streams = data.streams || [];
  const fmt = data.format || {};
  const videos = streams.filter((s) => s.codec_type === 'video' && s.codec_name !== 'png');
  const audios = streams.filter((s) => s.codec_type === 'audio');
  if (!videos.length || !audios.length) {
    return { ok: false, detail: 'missing-av' };
  }
  const fdur = Number(fmt.duration) || 0;
  const vdur = Number(videos[0].duration) || 0;
  const adur = Number(audios[0].duration) || 0;
  const ref = Math.max(fdur, expectedDuration || 0);
  if (ref < 5 && Math.max(vdur, adur, fdur) < 5) {
    return { ok: false, detail: 'too-short:' + Math.max(vdur, adur, fdur).toFixed(2) };
  }
  // Classic freeze: container/audio claim full length but video ends early
  if (ref > 15 && vdur > 0 && vdur < ref * 0.85) {
    return { ok: false, detail: `truncated-video vid=${vdur.toFixed(2)}s ref=${ref.toFixed(1)}s` };
  }
  if (ref > 15 && adur > 0 && adur < ref * 0.85) {
    return { ok: false, detail: `truncated-audio aud=${adur.toFixed(2)}s ref=${ref.toFixed(1)}s` };
  }
  if (expectedDuration && fdur > 0 && fdur < expectedDuration * 0.90) {
    return { ok: false, detail: `short-container fmt=${fdur.toFixed(1)}s meta=${expectedDuration}s` };
  }
  // Only enforce filesize when metadata matches this mux (same order of magnitude)
  if (expectedSize && expectedSize > 500_000 && size < expectedSize * 0.50 && size < expectedSize - 5_000_000) {
    return { ok: false, detail: `filesize size=${size} meta=${expectedSize}` };
  }
  return {
    ok: true,
    detail: `${videos[0].codec_name}+${audios[0].codec_name} ${Math.max(vdur, fdur).toFixed(1)}s`,
  };
}

function quarantineBadDownload(mp4Path, reason) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
    const dest = mp4Path + '.bad-' + stamp;
    fs.renameSync(mp4Path, dest);
    console.warn('[downloads] Quarantined incomplete/corrupt video:', dest, reason);
    return dest;
  } catch (e) {
    console.warn('[downloads] Could not quarantine', mp4Path, e.message);
    return null;
  }
}

// ── Active downloads tracker ──
const activeDownloads = new Map(); // videoId → { proc, status, progress }

function start(videoId, makeKaraoke = false, url = null, opts = {}) {
  return new Promise((resolve, reject) => {
    const mp4 = library.getVideoPath(videoId);
    const karaokeMp4 = path.join(library.LIBRARY_KARAOKE_DIR, videoId + '-karaoke.mp4');

    // Join an in-flight download instead of spawning a second yt-dlp
    const existing = activeDownloads.get(videoId);
    if (existing && existing.proc && !makeKaraoke) {
      existing.proc.once('close', (code) => {
        const resultPath = library.getVideoPath(videoId);
        const check = verifyDownloadedVideo(resultPath);
        if (code === 0 && check.ok) {
          resolve({ ok: true, videoId, path: resultPath, joined: true });
        } else {
          if (resultPath && fs.existsSync(resultPath) && !check.ok) {
            quarantineBadDownload(resultPath, check.detail);
          }
          reject(new Error('Existing download failed: ' + (check.ok ? ('code ' + code) : check.detail)));
        }
      });
      return;
    }

    // Already have a regular download — only skip if integrity checks pass
    if (fs.existsSync(mp4) && !makeKaraoke) {
      const check = verifyDownloadedVideo(mp4);
      if (check.ok) {
        resolve({ ok: true, videoId, alreadyExists: true, path: mp4 });
        return;
      }
      console.warn('[downloads] Existing file failed integrity check, re-downloading:', videoId, check.detail);
      quarantineBadDownload(mp4, check.detail);
    }
    // Already have the karaoke version — unless this is a re-lyric (reprocess), which always needs to run
    if (makeKaraoke && fs.existsSync(karaokeMp4) && !opts.isReLyric) {
      const check = verifyDownloadedVideo(karaokeMp4);
      if (check.ok) {
        resolve({ ok: true, videoId, alreadyExists: true, path: karaokeMp4, karaokeDone: true });
        return;
      }
      console.warn('[downloads] Existing karaoke failed integrity check, re-running pipeline:', videoId, check.detail);
      quarantineBadDownload(karaokeMp4, check.detail);
    }

    // If karaoke mode, delegate entirely to the Python pipeline
    // (it handles download, demucs, lyrics, render in one shot)
    if (makeKaraoke) {
      fullKaraokePipeline(videoId, url, opts, resolve, reject);
      return;
    }

    // Non-karaoke: just download with yt-dlp
    const outDir = library.getDownloadDir(videoId);
    console.log('[downloads] Downloading: ' + videoId + ' → ' + outDir);

    const args = [
      '-f', YTDLP_FORMAT,
      '--merge-output-format', 'mp4',
      '--write-info-json', '--write-thumbnail',
      '--write-subs', '--write-auto-subs', '--sub-langs', 'en.*,en',
      '--convert-subs', 'lrc',
      '-o', path.join(outDir, '%(id)s.%(ext)s'),
      '--no-playlist',
      '--socket-timeout', '30',
      '--retries', '5',
      '--fragment-retries', '5',
      '--extractor-args', YTDLP_PLAYER_CLIENT,
      ...ytdlpAuthArgs(),
      'https://www.youtube.com/watch?v=' + videoId,
    ];

    const proc = spawn(YT_DLP_PATH, args, { timeout: 300_000, env: childEnv() });

    let stderr = '';
    proc.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderr += chunk;
      const progressMatch = chunk.match(/(\d+\.?\d*)%/);
      if (progressMatch) {
        activeDownloads.set(videoId, { proc, status: 'downloading', progress: parseFloat(progressMatch[1]) });
      }
    });

    proc.on('close', (code) => {
      activeDownloads.delete(videoId);
      const resultPath = library.getVideoPath(videoId);
      if (code === 0 && fs.existsSync(resultPath)) {
        const check = verifyDownloadedVideo(resultPath);
        if (!check.ok) {
          quarantineBadDownload(resultPath, check.detail);
          reject(new Error('Download incomplete/corrupt: ' + check.detail));
          return;
        }
        library.init();
        resolve({ ok: true, videoId, path: resultPath, verified: check.detail });
      } else {
        reject(new Error(formatYtdlError(stderr, code)));
      }
    });

    proc.on('error', (e) => { activeDownloads.delete(videoId); reject(e); });
    activeDownloads.set(videoId, { proc, status: 'downloading', progress: 0 });
  });
}

/** Infer Whisper / romanize language from LRC track meta, lyric script, or title. */
function inferLanguage(videoId, opts) {
  if (opts && opts.language) {
    return String(opts.language).split('-')[0].toLowerCase();
  }
  try {
    const candidates = [
      path.join(library.LIBRARY_KARAOKE_DIR, videoId + '-karaoke.lrc.json'),
      path.join(library.LIBRARY_KARAOKE_DIR, videoId + '.lrc.json'),
    ];
    for (const lrcPath of candidates) {
      if (!fs.existsSync(lrcPath)) continue;
      const lrc = JSON.parse(fs.readFileSync(lrcPath, 'utf8'));
      const tracks = lrc.tracks || {};
      const primaryKey = (lrc.display && lrc.display.primary) || 'sung';
      let language = (tracks[primaryKey] && tracks[primaryKey].lang)
        || (tracks.native && tracks.native.lang)
        || (tracks.sung && tracks.sung.lang)
        || lrc.whisperLanguage
        || lrc.language
        || null;
      if (language) return String(language).split('-')[0].toLowerCase();

      const sampleParts = [];
      const primaryLines = (tracks[primaryKey] && tracks[primaryKey].lines)
        || (tracks.sung && tracks.sung.lines)
        || lrc.lines
        || [];
      for (const line of primaryLines.slice(0, 12)) sampleParts.push(line.text || '');
      sampleParts.push(lrc.title || '', lrc.artist || '');
      const sample = sampleParts.join(' ');
      if (/[\u0E00-\u0E7F]/.test(sample)) return 'th';
      if (/[\u0E80-\u0EFF]/.test(sample)) return 'lo';
      if (/[\uAC00-\uD7AF]/.test(sample)) return 'ko';
      // Kana → Japanese; Han without kana → Chinese (don't conflate)
      if (/[\u3040-\u30FF]/.test(sample)) return 'ja';
      if (/[\u3400-\u9FFF]/.test(sample)) return 'zh';
      if (/[\u0400-\u04FF]/.test(sample)) return 'ru';
      if (/[\u0600-\u06FF]/.test(sample)) return 'ar';
    }
  } catch (_) {}

  // Title/artist from tags often carries Thai/Japanese even when LRC is Latin gibberish
  try {
    if (fs.existsSync(library.TAGS_PATH)) {
      const tags = JSON.parse(fs.readFileSync(library.TAGS_PATH, 'utf8'));
      for (const key of [videoId, videoId + '-karaoke']) {
        const entry = tags[key] || {};
        const sample = [entry.title, entry.artist].filter(Boolean).join(' ');
        if (/[\u0E00-\u0E7F]/.test(sample)) return 'th';
        if (/[\u0E80-\u0EFF]/.test(sample)) return 'lo';
        if (/[\uAC00-\uD7AF]/.test(sample)) return 'ko';
        if (/[\u3040-\u30FF]/.test(sample)) return 'ja';
        if (/[\u3400-\u9FFF]/.test(sample)) return 'zh';
      }
    }
  } catch (_) {}
  return null;
}

const ROMANIZE_LANGS = new Set(['th', 'ja', 'ko', 'zh', 'lo']);
const LATIN_SKIP_LANGS = new Set(['id', 'vi', 'en', 'fr', 'es']);

/**
 * Lightweight romanize-only: existing sung/native → tracks.romanized.
 * No Whisper, Demucs, download, or English translation.
 */
function romanizeOnly(videoId, lang) {
  return new Promise((resolve, reject) => {
    const karaokeId = String(videoId || '').replace(/-karaoke$/, '');
    const romanizeLang = (lang || 'th').split('-')[0].toLowerCase();
    if (LATIN_SKIP_LANGS.has(romanizeLang)) {
      reject(new Error('Language "' + romanizeLang + '" is already Latin — romanize not applicable'));
      return;
    }
    if (!ROMANIZE_LANGS.has(romanizeLang)) {
      reject(new Error('Unsupported romanize language "' + romanizeLang + '" (use th/ja/ko/zh/lo)'));
      return;
    }
    const ytUrl = 'https://www.youtube.com/watch?v=' + karaokeId;
    const args = [
      MAKE_KARAOKE_SCRIPT,
      '--romanize-only',
      '--romanize', romanizeLang,
      ytUrl,
    ];
    console.log('[downloads] Romanize-only:', args.join(' '));
    const proc = spawn('/opt/homebrew/bin/python3', args, {
      timeout: 120_000,
      env: childEnv(),
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); console.log('[romanize]', d.toString().trim()); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); console.error('[romanize]', d.toString().trim()); });
    proc.on('close', (code) => {
      const combined = stderr + stdout;
      if (code === 0 && combined.includes('ROMANIZE_OK')) {
        try { library.init(); } catch (_) {}
        const m = combined.match(/lines=(\d+)/);
        resolve({
          ok: true,
          videoId: karaokeId,
          lang: romanizeLang,
          lineCount: m ? parseInt(m[1], 10) : undefined,
          message: 'Romanized (' + romanizeLang + ') → tracks.romanized',
        });
        return;
      }
      reject(new Error((stderr || stdout || 'Romanize failed').trim().split('\n').slice(-3).join(' ') || 'Romanize failed'));
    });
    proc.on('error', (e) => reject(e));
  });
}

/** Demucs-only: refresh vocal + instrumental stems; remux karaoke; keep lyrics. */
function rebuildStemsOnly(videoId) {
  return new Promise((resolve, reject) => {
    const karaokeId = String(videoId || '').replace(/-karaoke$/, '');
    const ytUrl = 'https://www.youtube.com/watch?v=' + karaokeId;
    const args = [MAKE_KARAOKE_SCRIPT, '--rebuild-stems-only', ytUrl];
    console.log('[downloads] Rebuild-stems-only:', args.join(' '));
    const proc = spawn('/opt/homebrew/bin/python3', args, {
      timeout: 900_000,
      env: childEnv(),
    });
    let stdout = '';
    let stderr = '';
    const logPath = path.join('/tmp', 'karol-stems-' + karaokeId + '.log');
    let logStream = null;
    try { logStream = fs.createWriteStream(logPath, { flags: 'w' }); } catch (_) {}
    proc.stdout.on('data', (d) => {
      const s = d.toString(); stdout += s;
      if (logStream) try { logStream.write(s); } catch (_) {}
      console.log('[stems]', s.trim());
      activeDownloads.set(karaokeId, { proc, status: 'demucs', progress: undefined });
    });
    proc.stderr.on('data', (d) => {
      const s = d.toString(); stderr += s;
      if (logStream) try { logStream.write(s); } catch (_) {}
      console.error('[stems]', s.trim());
    });
    proc.on('close', (code) => {
      activeDownloads.delete(karaokeId);
      if (logStream) try { logStream.end(); } catch (_) {}
      const combined = stderr + stdout;
      if (code === 0 && combined.includes('STEMS_OK')) {
        try { library.init(); } catch (_) {}
        resolve({
          ok: true,
          videoId: karaokeId,
          karaokeDone: true,
          message: 'Stems rebuilt (lyrics kept)',
          path: path.join(library.LIBRARY_KARAOKE_DIR, karaokeId + '-karaoke.mp4'),
        });
        return;
      }
      reject(new Error((stderr || stdout || 'Stem rebuild failed').trim().split('\n').slice(-4).join(' ') || 'Stem rebuild failed'));
    });
    proc.on('error', (e) => {
      activeDownloads.delete(karaokeId);
      reject(e);
    });
    activeDownloads.set(karaokeId, { proc, status: 'demucs', progress: 0 });
  });
}

// Run the full Python karaoke pipeline (download + demucs + lyrics + render)
function fullKaraokePipeline(videoId, url, opts, resolve, reject) {
  const ytUrl = url || 'https://www.youtube.com/watch?v=' + videoId;
  console.log('[downloads] Starting karaoke pipeline for: ' + videoId + (opts.isReLyric ? ' (re-lyric)' : ''));

  // Rebuild stems only — Demucs + remux; keep lyrics
  if (opts.mode === 'stems' || opts.rebuildStemsOnly) {
    rebuildStemsOnly(videoId).then(resolve).catch(reject);
    return;
  }

  // Build args
  const args = [MAKE_KARAOKE_SCRIPT];
  const isRetime = opts.mode === 'retime' || !!opts.retimeKeepText;
  let lyricsFilePath = null;

  // Re-time only: keep lyric text, force-align to vocals (no Demucs / rebuild)
  if (isRetime) {
    args.push('--retime-keep-text');
    let language = inferLanguage(videoId, opts);
    if (language) args.push('--language', language);
    // Re-Lyric / retime always prefers large-v3. Strip .en for non-English (multilingual).
    let model = opts.whisperModel || 'large-v3';
    if (language && language !== 'en' && /\.en$/.test(model)) {
      model = model.replace(/\.en$/, '') || 'large-v3';
    }
    args.push('--whisper-model', model);
    args.push(ytUrl);
    console.log('[downloads] Retime-keep-text pipeline:', args.join(' '));
  } else {
    if (opts.isReLyric) {
      args.push('--reprocess');
      // Always rebuild from a fresh YouTube download + Demucs; mux audio onto
      // the video stream (-c:v copy). Never leave degraded karaoke AAC in place.
      args.push('--rebuild-audio');
      // Explore YouTube karaoke versions before Whisper invent
      args.push('--find-karaoke');
      // Re-Lyric replaces the *target* track (default sung) but must not wipe
      // an existing tracks.english unless lyricsTrack === 'english'.
      args.push('--force-overwrite-lyrics');
      // Default Re-Lyric writes as-sung / regenerated primary — never english
      if (!opts.lyricsTrack) opts.lyricsTrack = 'sung';
    }
    if (opts.forceWhisper) args.push('--force-whisper');
    if (opts.forceOverwriteLyrics) args.push('--force-overwrite-lyrics');
    if (opts.karaokeMatch) args.push('--karaoke-match', opts.karaokeMatch);
    if (opts.lyricsTrack) args.push('--lyrics-track', opts.lyricsTrack);
    // Opt-in only — never auto-romanize on every reprocess
    if (opts.romanize) args.push('--romanize', opts.romanize);
    // Language for Whisper (rebuild). Infer from LRC/title when UI left Auto.
    let language = inferLanguage(videoId, opts);
    if (language) {
      args.push('--language', language);
      console.log('[downloads] Whisper language:', language);
    }
    // Always prefer large-v3 for Demucs-vocal keep-text align + invent (gold path).
    // UI can still override via whisperModel.
    if (opts.whisperModel) {
      let model = opts.whisperModel;
      if (language && language !== 'en' && /\.en$/.test(model)) {
        model = model.replace(/\.en$/, '') || 'large-v3';
      }
      args.push('--whisper-model', model);
    } else {
      args.push('--whisper-model', 'large-v3');
    }

    // Pass artist/title from tags or opts so LRCLIB search has clean metadata
    try {
      let artist = opts.artist || '';
      let title = opts.title || '';
      if ((!artist || !title) && fs.existsSync(library.TAGS_PATH)) {
        const tags = JSON.parse(fs.readFileSync(library.TAGS_PATH, 'utf8'));
        for (const key of [videoId, videoId + '-karaoke']) {
          const entry = tags[key] || {};
          if (!artist && entry.artist) artist = entry.artist;
          if (!title && entry.title) title = entry.title;
        }
      }
      // Fall back to info.json title parsing
      if (!artist || !title) {
        const infoCandidates = [
          path.join(library.LIBRARY_KARAOKE_DIR, videoId + '-karaoke.info.json'),
          path.join(library.LIBRARY_KARAOKE_DIR, videoId + '.info.json'),
        ];
        for (const infoPath of infoCandidates) {
          if (!fs.existsSync(infoPath)) continue;
          try {
            const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
            if (!artist && info.uploader) artist = info.uploader;
            if (!title && info.title) {
              title = String(info.title)
                .replace(/\s*\(?(?:official\s*(?:music\s*)?video|lyric\s*video|hd|4k|1080p)\)?\s*$/i, '')
                .trim();
              if (artist && title.toLowerCase().startsWith(artist.toLowerCase() + ' - ')) {
                title = title.slice(artist.length + 3).trim();
              }
            }
          } catch {}
          break;
        }
      }
      if (artist) args.push('--artist', artist);
      if (title) args.push('--title', title);
      if (artist || title) {
        console.log('[downloads] Lyric lookup metadata:', { artist, title });
      }
    } catch (e) {
      console.warn('[downloads] Could not resolve artist/title:', e.message);
    }

    // If user provided custom lyrics, write to temp file and pass --lyrics-file
    if (opts.lyricsText && opts.lyricsText.trim()) {
      lyricsFilePath = path.join('/tmp', 'karol-lyrics-' + videoId + '.txt');
      fs.writeFileSync(lyricsFilePath, opts.lyricsText.trim(), 'utf8');
      args.push('--lyrics-file', lyricsFilePath);
      console.log('[downloads] Custom lyrics provided:', opts.lyricsText.length, 'chars');
    }

    args.push(ytUrl);
  }

  // Clean stale temp dir for this videoId before starting
  try {
    const tempDir = path.join('/Users/macdonk/Documents/GitHub/Karol/.karol/karaoke-temp', videoId);
    if (fs.existsSync(tempDir)) {
      const { rmSync } = require('fs');
      rmSync(tempDir, { recursive: true, force: true });
      console.log('[downloads] Cleared stale temp dir before pipeline:', videoId);
    }
  } catch {}

  // Demucs + multi-chunk Whisper (with repetition retries) routinely exceeds 15m.
  // Node's spawn timeout kills with SIGTERM — was surfacing as a vague interrupt.
  const PIPELINE_TIMEOUT_MS = 60 * 60 * 1000;
  const pipelineStartedAt = Date.now();
  const proc = spawn('/opt/homebrew/bin/python3', args, {
    timeout: PIPELINE_TIMEOUT_MS,
    env: childEnv(),
  });

  const logPath = path.join('/tmp', 'karol-pipeline-' + videoId + '.log');
  let logStream = null;
  try {
    logStream = fs.createWriteStream(logPath, { flags: 'w' });
    console.log('[downloads] Pipeline log:', logPath);
  } catch {}

  let stdout = '';
  let stderr = '';

  function appendLog(chunk) {
    if (logStream) {
      try { logStream.write(chunk); } catch {}
    }
  }

  proc.stdout.on('data', (d) => {
    const chunk = d.toString();
    stdout += chunk;
    appendLog(chunk);
    console.log('[karaoke]', chunk.trim());
    // Track progress from Python script output
    const pct = chunk.match(/(\d+)%/);
    const isDemucs = chunk.includes('demucs');
    const isWhisper = chunk.includes('whisper') || chunk.includes('retime') || chunk.includes('Force-align');
    const isRender = chunk.includes('render');
    const isDownload = chunk.includes('download') || chunk.includes('reprocess');
    const isLyrics = chunk.includes('lyrics:') || chunk.includes('Stage ') || chunk.includes('RETIME');
    let status = isDemucs ? 'demucs' : (isWhisper ? 'whisper' : (isRender ? 'rendering' : (isDownload ? 'downloading' : (isLyrics ? 'lyrics' : undefined))));
    if (!status) {
      // Don't overwrite current status with undefined
      const current = activeDownloads.get(videoId);
      status = current ? current.status : 'downloading';
    }
    activeDownloads.set(videoId, { proc, status, progress: pct ? parseInt(pct[1]) : undefined });
  });

  proc.stderr.on('data', (d) => {
    const chunk = d.toString();
    stderr += chunk;
    appendLog(chunk);
    console.error('[karaoke]', chunk.trim());
  });

  proc.on('close', (code, signal) => {
    activeDownloads.delete(videoId);
    if (logStream) { try { logStream.end(); } catch {} }
    // Clean up temp lyrics file if we created one
    if (lyricsFilePath) { try { fs.unlinkSync(lyricsFilePath); } catch {} }
    const karaokeMp4 = path.join(library.LIBRARY_KARAOKE_DIR, videoId + '-karaoke.mp4');
    const combined = (stderr + stdout);

    if (code === 2 || combined.includes('LYRICS_BLOCKED')) {
      reject(new Error('Quality gate blocked lyric update — paste correct lyrics in Re-Lyric, or pick a karaoke match'));
      return;
    }
    if (signal) {
      const elapsedMs = Date.now() - pipelineStartedAt;
      if (elapsedMs >= PIPELINE_TIMEOUT_MS - 2000) {
        reject(new Error(
          'Pipeline timed out after ' + Math.round(elapsedMs / 60000) +
          ' min (Demucs/Whisper). Try Re-Lyric again.'
        ));
        return;
      }
      reject(new Error('Pipeline interrupted (' + signal + '). Try Re-Lyric again.'));
      return;
    }
    if (code === 0 && (fs.existsSync(karaokeMp4) || combined.includes('RETIME_OK'))) {
      if (fs.existsSync(karaokeMp4)) {
        const check = verifyDownloadedVideo(karaokeMp4);
        if (!check.ok) {
          quarantineBadDownload(karaokeMp4, check.detail);
          reject(new Error('Karaoke output incomplete/corrupt — not marking done: ' + check.detail));
          return;
        }
      }
      console.log('[downloads] Karaoke pipeline complete: ' + videoId);
      library.init();
      const size = fs.existsSync(karaokeMp4) ? fs.statSync(karaokeMp4).size : 0;
      const kept = combined.includes('LYRICS_KEPT');
      const retimed = combined.includes('RETIME_OK');
      resolve({
        ok: true,
        videoId,
        path: karaokeMp4,
        karaokeDone: true,
        size,
        message: retimed
          ? 'Re-timed lyrics (text kept)'
          : (kept ? 'Kept existing lyrics (new result was worse)' : undefined),
      });
    } else {
      // Build a human-readable error
      const lastLine = combined.split('\n').filter(l => l.trim()).pop() || '';
      let message = 'Pipeline failed (exit code ' + code + ')';
      if (combined.includes('HTTP Error 403') || combined.includes('Forbidden')) {
        message = 'YouTube blocked the download (403 Forbidden). Try again or use a different video.';
      } else if (combined.includes('HTTP Error 404') || combined.includes('Not Found')) {
        message = 'Video not found on YouTube. Check the URL.';
      } else if (combined.includes('timed out') || combined.includes('ETIMEDOUT')) {
        message = 'Download timed out. Check your internet connection and try again.';
      } else if (combined.includes('Disk quota') || combined.includes('ENOSPC')) {
        message = 'Disk is full. Free up space and try again.';
      } else if (lastLine) {
        message = lastLine.slice(-300);
      }
      if (fs.existsSync(logPath)) message += ' (log: ' + logPath + ')';
      reject(new Error(message));
    }
  });

  proc.on('error', (e) => {
    activeDownloads.delete(videoId);
    if (logStream) { try { logStream.end(); } catch {} }
    reject(new Error('Pipeline could not start: ' + e.message));
  });

  activeDownloads.set(videoId, { proc, status: 'starting', progress: 0 });
}

function formatYtdlError(stderr, code) {
  const lines = stderr.split('\n').filter(l => l.includes('ERROR:') || l.includes('HTTP Error') || l.includes('403') || l.includes('Forbidden'));
  return lines.length ? lines[lines.length - 1].trim().slice(0, 200) : ('code ' + code);
}

function getStatus(videoId) {
  const info = activeDownloads.get(videoId);
  if (info) return { downloading: true, status: info.status, progress: info.progress };
  const mp4 = library.getVideoPath(videoId);
  if (fs.existsSync(mp4)) {
    const check = verifyDownloadedVideo(mp4);
    return { downloading: false, exists: check.ok, path: mp4, verified: check.ok, detail: check.detail };
  }
  return { downloading: false, exists: false };
}

function cancel(videoId) {
  const info = activeDownloads.get(videoId);
  if (!info) return false;
  try { info.proc.kill('SIGTERM'); } catch (e) { /* ignore */ }
  activeDownloads.delete(videoId);
  return true;
}

module.exports = { start, getStatus, cancel, romanizeOnly, rebuildStemsOnly, inferLanguage, verifyDownloadedVideo };
