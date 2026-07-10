import * as fs from 'fs';
import * as path from 'path';
import type { LibraryState, LibraryTrack } from '../common/VlcControllerTypes';
import { getVlcConfig, findCoverPath } from './vlcBridge';

let cachedLibrary: LibraryTrack[] = [];
let cachedFolder = '';

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.aiff']);

function getDefaultLibraryFolder(): string {
  const home = require('os').homedir();
  return path.join(home, 'Music');
}

function getLibraryFolder(): string {
  const config = getVlcConfig();
  return config.libraryFolder || getDefaultLibraryFolder();
}

export async function scanLibrary(folderPath: string): Promise<LibraryTrack[]> {
  const tracks: LibraryTrack[] = [];

  if (!fs.existsSync(folderPath)) {
    return tracks;
  }

  function walk(dir: string, depth: number = 0) {
    if (depth > 5) return; // safety limit
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (AUDIO_EXTENSIONS.has(ext)) {
            tracks.push(fastMeta(fullPath));
          }
        }
      }
    } catch {
      // skip unreadable dirs
    }
  }

  walk(folderPath);
  return tracks;
}

function fastMeta(filePath: string): LibraryTrack {
  const base = path.basename(filePath, path.extname(filePath));
  const albumDir = path.basename(path.dirname(filePath));
  // audio/ArtistName/Album/Track.m4a → artist is ArtistName
  const artistDirName = path.basename(path.dirname(path.dirname(filePath)));
  const isArtistDir = artistDirName && artistDirName !== 'audio';
  const coverPath = findCoverPath(filePath);
  const coverUrl = coverPath
    ? `/api/vlc-dj/cover?path=${encodeURIComponent(filePath)}`
    : undefined;
  return {
    path: filePath,
    title: base,
    artist: isArtistDir ? artistDirName : undefined,
    album: albumDir !== artistDirName ? albumDir : undefined,
    coverUrl,
  };
}

export async function getLibrary(): Promise<LibraryState> {
  const folder = getLibraryFolder();

  if (cachedFolder !== folder || cachedLibrary.length === 0) {
    cachedLibrary = await scanLibrary(folder);
    cachedFolder = folder;
  }

  return {
    tracks: cachedLibrary,
    folder,
  };
}

export function getCachedLibrary(): LibraryTrack[] {
  return cachedLibrary;
}

export function searchLibrary(query: string): LibraryTrack[] {
  const q = query.toLowerCase().trim();
  if (!q) {
    return cachedLibrary;
  }

  return cachedLibrary.filter((track) => {
    const title = track.title.toLowerCase();
    const artist = (track.artist || '').toLowerCase();
    const album = (track.album || '').toLowerCase();
    const filename = path.basename(track.path).toLowerCase();

    return (
      title.includes(q) ||
      artist.includes(q) ||
      album.includes(q) ||
      filename.includes(q)
    );
  });
}
