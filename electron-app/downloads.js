// Karol Electron — Downloads module
// yt-dlp download management and karaoke pipeline.
// Ported from api-server/index.js download handling.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const library = require('./library');

const YT_DLP_PATH = '/opt/homebrew/bin/yt-dlp';
// Must use absolute path — electron-builder's .asar archive doesn't include parent directories
const MAKE_KARAOKE_SCRIPT = '/Users/macdonk/Documents/GitHub/Karol/tools/make-karaoke-video.py';
const YT_COOKIES = '/Users/macdonk/Documents/GitHub/Karol/.karol/yt-cookies.txt';

// Prefer exported logged-in cookie jar (refreshed from Chrome by Electron / pipeline)
function ytdlpAuthArgs() {
  try {
    if (fs.existsSync(YT_COOKIES) && fs.statSync(YT_COOKIES).size > 100) {
      return ['--cookies', YT_COOKIES];
    }
  } catch {}
  return ['--cookies-from-browser', 'chrome'];
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
        if (code === 0 && fs.existsSync(resultPath)) {
          resolve({ ok: true, videoId, path: resultPath, joined: true });
        } else {
          reject(new Error('Existing download failed (code ' + code + ')'));
        }
      });
      return;
    }

    // Already have a regular download
    if (fs.existsSync(mp4) && !makeKaraoke) {
      resolve({ ok: true, videoId, alreadyExists: true, path: mp4 });
      return;
    }
    // Already have the karaoke version — unless this is a re-lyric (reprocess), which always needs to run
    if (makeKaraoke && fs.existsSync(karaokeMp4) && !opts.isReLyric) {
      resolve({ ok: true, videoId, alreadyExists: true, path: karaokeMp4, karaokeDone: true });
      return;
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
      '-f', 'b[height<=1080]',
      '--merge-output-format', 'mp4',
      '--write-info-json', '--write-thumbnail',
      '--write-subs', '--write-auto-subs', '--sub-langs', 'en.*,en',
      '--convert-subs', 'lrc',
      '-o', path.join(outDir, '%(id)s.%(ext)s'),
      '--no-playlist',
      '--socket-timeout', '30',
      '--retries', '5',
      '--fragment-retries', '5',
      '--extractor-args', 'youtube:player_client=web,ios',
      ...ytdlpAuthArgs(),
      'https://www.youtube.com/watch?v=' + videoId,
    ];

    const proc = spawn(YT_DLP_PATH, args, { timeout: 300_000, env: { ...process.env } });

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
        library.init();
        resolve({ ok: true, videoId, path: resultPath });
      } else {
        reject(new Error(formatYtdlError(stderr, code)));
      }
    });

    proc.on('error', (e) => { activeDownloads.delete(videoId); reject(e); });
    activeDownloads.set(videoId, { proc, status: 'downloading', progress: 0 });
  });
}

// Run the full Python karaoke pipeline (download + demucs + lyrics + render)
function fullKaraokePipeline(videoId, url, opts, resolve, reject) {
  const ytUrl = url || 'https://www.youtube.com/watch?v=' + videoId;
  console.log('[downloads] Starting karaoke pipeline for: ' + videoId + (opts.isReLyric ? ' (re-lyric)' : ''));

  // Build args
  const args = [MAKE_KARAOKE_SCRIPT];
  if (opts.isReLyric) {
    args.push('--reprocess');
    // Always rebuild from a fresh YouTube download + Demucs; mux audio onto
    // the video stream (-c:v copy). Never leave degraded karaoke AAC in place.
    args.push('--rebuild-audio');
    // Explore YouTube karaoke versions before Whisper invent
    args.push('--find-karaoke');
    // Re-Lyric always intends to replace the on-disk LRC (including garbage
    // WEBVTT dumps from older parses).
    args.push('--force-overwrite-lyrics');
  }
  if (opts.forceWhisper) args.push('--force-whisper');
  if (opts.forceOverwriteLyrics) args.push('--force-overwrite-lyrics');
  if (opts.karaokeMatch) args.push('--karaoke-match', opts.karaokeMatch);
  // Prefer medium.en when UI omits a model — large-v3 often OOMs / stalls on laptop.
  if (opts.whisperModel) {
    args.push('--whisper-model', opts.whisperModel);
  } else if (opts.isReLyric) {
    args.push('--whisper-model', 'medium.en');
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
  let lyricsFilePath = null;
  if (opts.lyricsText && opts.lyricsText.trim()) {
    lyricsFilePath = path.join('/tmp', 'karol-lyrics-' + videoId + '.txt');
    fs.writeFileSync(lyricsFilePath, opts.lyricsText.trim(), 'utf8');
    args.push('--lyrics-file', lyricsFilePath);
    console.log('[downloads] Custom lyrics provided:', opts.lyricsText.length, 'chars');
  }

  args.push(ytUrl);

  // Clean stale temp dir for this videoId before starting
  try {
    const tempDir = path.join('/Users/macdonk/Documents/GitHub/Karol/.karol/karaoke-temp', videoId);
    if (fs.existsSync(tempDir)) {
      const { rmSync } = require('fs');
      rmSync(tempDir, { recursive: true, force: true });
      console.log('[downloads] Cleared stale temp dir before pipeline:', videoId);
    }
  } catch {}

  const proc = spawn('/opt/homebrew/bin/python3', args, {
    timeout: 900_000,
    env: { ...process.env, PATH: '/opt/homebrew/bin:' + (process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'), PYTHONUNBUFFERED: '1' },
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
    const isWhisper = chunk.includes('whisper');
    const isRender = chunk.includes('render');
    const isDownload = chunk.includes('download') || chunk.includes('reprocess');
    const isLyrics = chunk.includes('lyrics:') || chunk.includes('Stage ');
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
      reject(new Error('Pipeline interrupted (' + signal + '). Try Re-Lyric again.'));
      return;
    }
    if (code === 0 && fs.existsSync(karaokeMp4)) {
      console.log('[downloads] Karaoke pipeline complete: ' + videoId);
      library.init();
      const size = fs.statSync(karaokeMp4).size;
      const kept = combined.includes('LYRICS_KEPT');
      resolve({
        ok: true,
        videoId,
        path: karaokeMp4,
        karaokeDone: true,
        size,
        message: kept ? 'Kept existing lyrics (new result was worse)' : undefined,
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
  if (fs.existsSync(mp4)) return { downloading: false, exists: true, path: mp4 };
  return { downloading: false, exists: false };
}

function cancel(videoId) {
  const info = activeDownloads.get(videoId);
  if (!info) return false;
  try { info.proc.kill('SIGTERM'); } catch (e) { /* ignore */ }
  activeDownloads.delete(videoId);
  return true;
}

module.exports = { start, getStatus, cancel };
