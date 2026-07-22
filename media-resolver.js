const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.mp3', '.webm']);
const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.karol', 'media-cache');
const DEFAULT_STATS_FILE = path.join(os.homedir(), '.karol', 'media-cache-stats.json');
const DEFAULT_MANIFEST_FILE = path.join(os.homedir(), '.karol-r2-upload-manifest.json');
const DEFAULT_BUCKET = 'karol';
const inFlight = new Map();

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

async function acquireLock(lockPath, readyPath, timeoutMs = 30 * 60 * 1000) {
  const started = Date.now();
  while (true) {
    try {
      await fs.promises.mkdir(lockPath);
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (readyPath && fs.existsSync(readyPath) && fs.statSync(readyPath).size > 0) return false;
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > timeoutMs) await fs.promises.rm(lockPath, { recursive: true, force: true });
      } catch {}
      if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for media cache lock: ${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

function createMediaResolver(options = {}) {
  const cacheDir = options.cacheDir || process.env.KAROL_MEDIA_CACHE_DIR || DEFAULT_CACHE_DIR;
  const statsFile = options.statsFile || process.env.KAROL_MEDIA_CACHE_STATS_FILE || DEFAULT_STATS_FILE;
  const manifestFile = options.manifestFile || process.env.KAROL_R2_MANIFEST || DEFAULT_MANIFEST_FILE;
  const bucket = options.bucket || process.env.KAROL_R2_BUCKET || DEFAULT_BUCKET;
  const budgetGb = Number(process.env.KAROL_CLOUD_DATA_BUDGET_GB || options.budgetGb || 40);
  const budgetBytes = budgetGb * 1024 * 1024 * 1024;
  const wranglerPath = options.wranglerPath
    || process.env.KAROL_WRANGLER_PATH
    || path.join(__dirname, 'node_modules', '.bin', 'wrangler');
  let manifestIndex = null;

  function loadManifestIndex() {
    if (manifestIndex) return manifestIndex;
    manifestIndex = new Map();
    const files = readJson(manifestFile, {}).files || {};
    for (const [relpath, entry] of Object.entries(files)) {
      if (!entry || !entry.key || !VIDEO_EXTS.has(path.extname(relpath).toLowerCase())) continue;
      const base = path.basename(relpath, path.extname(relpath));
      const row = { key: entry.key, size: Number(entry.size) || 0, relpath };
      const rows = manifestIndex.get(base) || [];
      rows.push(row);
      manifestIndex.set(base, rows);
    }
    return manifestIndex;
  }

  function safeCachePath(key) {
    if (!key || !String(key).startsWith('library/')) return null;
    const relative = String(key).slice('library/'.length);
    const resolved = path.resolve(cacheDir, relative);
    const root = path.resolve(cacheDir) + path.sep;
    return resolved.startsWith(root) ? resolved : null;
  }

  function findCached(videoId) {
    const rows = loadManifestIndex().get(String(videoId)) || [];
    for (const row of rows) {
      const cached = safeCachePath(row.key);
      if (cached && fs.existsSync(cached) && fs.statSync(cached).size > 0) return cached;
    }
    return null;
  }

  function findExisting(videoId) {
    const local = options.findLocal ? options.findLocal(videoId) : null;
    if (local && fs.existsSync(local)) return local;
    return findCached(videoId);
  }

  async function lookupMedia(videoId) {
    const rows = loadManifestIndex().get(String(videoId)) || [];
    if (rows.length) {
      rows.sort((a, b) => {
        const exactA = path.basename(a.relpath, path.extname(a.relpath)) === videoId ? 1 : 0;
        const exactB = path.basename(b.relpath, path.extname(b.relpath)) === videoId ? 1 : 0;
        return exactB - exactA;
      });
      return rows[0];
    }
    if (options.catalogLookup) {
      const row = await options.catalogLookup(videoId);
      if (row && row.media_key && Number(row.r2_uploaded)) {
        const media = {
          key: row.media_key,
          size: Number(row.size_bytes) || 0,
          relpath: row.local_relpath || String(row.media_key).replace(/^library\//, ''),
        };
        const existing = manifestIndex.get(String(videoId)) || [];
        if (!existing.some((item) => item.key === media.key)) existing.push(media);
        manifestIndex.set(String(videoId), existing);
        return media;
      }
    }
    return null;
  }

  function runWrangler(key, tempPath) {
    return new Promise((resolve, reject) => {
      execFile(
        wranglerPath,
        ['r2', 'object', 'get', `${bucket}/${key}`, '--file', tempPath, '--remote'],
        { timeout: 30 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`R2 download failed for ${key}: ${(stderr || error.message).trim()}`));
          } else {
            resolve(stdout);
          }
        }
      );
    });
  }

  async function recordDownload(bytes) {
    fs.mkdirSync(path.dirname(statsFile), { recursive: true });
    const lock = `${statsFile}.lock`;
    await acquireLock(lock, null, 30_000);
    try {
      const stats = readJson(statsFile, { version: 1, months: {} });
      stats.version = 1;
      stats.months = stats.months || {};
      const month = monthKey();
      stats.months[month] = Number(stats.months[month] || 0) + bytes;
      stats.updatedAt = new Date().toISOString();
      const temp = `${statsFile}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(temp, JSON.stringify(stats, null, 2));
      fs.renameSync(temp, statsFile);
      if (stats.months[month] > budgetBytes) {
        console.warn(`[media-cache] WARNING: ${month} R2 downloads are ${(stats.months[month] / 1024 / 1024 / 1024).toFixed(2)} GB, above the ${budgetGb} GB budget`);
      }
      return stats;
    } finally {
      await fs.promises.rm(lock, { recursive: true, force: true });
    }
  }

  async function resolve(videoId) {
    const existing = findExisting(videoId);
    if (existing) return existing;
    const requestKey = String(videoId);
    if (inFlight.has(requestKey)) return inFlight.get(requestKey);

    const promise = (async () => {
      const media = await lookupMedia(requestKey);
      if (!media) return null;
      const destination = safeCachePath(media.key);
      if (!destination) throw new Error(`Unsafe or invalid R2 media key: ${media.key}`);
      if (fs.existsSync(destination) && fs.statSync(destination).size > 0) return destination;

      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const lock = `${destination}.lock`;
      const ownsLock = await acquireLock(lock, destination);
      if (!ownsLock) return destination;
      const temp = `${destination}.part-${process.pid}-${Date.now()}`;
      const displayMb = (media.size / 1024 / 1024).toFixed(1);
      console.log(`[media-cache] downloading ${displayMb} MB from R2: ${media.key}`);
      try {
        await runWrangler(media.key, temp);
        const stat = fs.statSync(temp);
        if (stat.size <= 0) throw new Error(`R2 returned an empty file for ${media.key}`);
        fs.renameSync(temp, destination);
        await recordDownload(stat.size);
        console.log(`[media-cache] cached ${(stat.size / 1024 / 1024).toFixed(1)} MB: ${destination}`);
        return destination;
      } catch (error) {
        try { fs.unlinkSync(temp); } catch {}
        throw error;
      } finally {
        await fs.promises.rm(lock, { recursive: true, force: true });
      }
    })().finally(() => inFlight.delete(requestKey));

    inFlight.set(requestKey, promise);
    return promise;
  }

  function getUsage() {
    const stats = readJson(statsFile, { version: 1, months: {} });
    const month = monthKey();
    const bytes = Number((stats.months || {})[month] || 0);
    return {
      ok: true,
      month,
      bytes,
      gigabytes: Number((bytes / 1024 / 1024 / 1024).toFixed(3)),
      budgetGb,
      remainingBytes: Math.max(0, budgetBytes - bytes),
      overBudget: bytes > budgetBytes,
      statsFile,
      cacheDir,
    };
  }

  return { resolve, findExisting, findCached, getUsage, cacheDir, statsFile };
}

module.exports = { createMediaResolver };
