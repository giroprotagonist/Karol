# YouTube DJ API Contract (Android Direct)

Base path: `/api/youtube-dj`  
Host mode: `direct` (tablet player). Mac Cast host is legacy subset.

## Discovery

| Method | Path | Response |
|--------|------|----------|
| GET | `/api/discover.json` | `{ hostMode, port, ... }` |
| GET | `/api/health.json` | `{ ready: true, hostMode: "direct" }` |
| GET | `/api/youtube-dj/health` | Same as `/status` |

## State (read)

| Method | Path | Response |
|--------|------|----------|
| GET | `/status` | `YouTubeDjStatus` + `hostMode: "direct"` |
| GET | `/now-playing` | `{ title, videoId, currentTime, duration, state, volumeLevel? }` |
| GET | `/queue` | `YouTubeKaraokeState` (`queue`, `currentIndex`, `mode`, `shuffleEnabled`, `isPlaying`, `currentTitle`, `currentThumbnail`, `currentTime`, `duration`) |
| GET | `/playlist` | `{ ok, config: YouTubeDjPlaylistModeConfig }` |
| GET | `/events` | SSE stream: `event: session\ndata: <PlaybackSession JSON>\n\n` |

## Queue mutations

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/queue` | `{ url, action?: "queue" \| "play-now" }` | `{ ok, videoId? }` |
| POST | `/queue/clear` | `{}` | `{ ok }` |
| POST | `/queue/reorder` | `{ fromIndex, toIndex }` | `{ ok, state? }` |
| POST | `/queue/sort` | `{ mode }` | `{ ok }` |
| POST | `/queue/shuffle-upcoming` | `{}` | `{ ok }` |
| POST | `/queue/{id}/play` | `{}` | `{ ok, videoId? }` |
| DELETE | `/queue/{id}` | — | `{ ok }` |
| PATCH | `/shuffle` | `{ enabled: boolean }` | `{ ok }` |

## Transport

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | `/transport/play` | `{}` | `{ ok, nowPlaying? }` |
| POST | `/transport/pause` | `{}` | `{ ok, nowPlaying? }` |
| POST | `/transport/seek` | `{ seconds }` | `{ ok, nowPlaying? }` |
| POST | `/transport/seek-relative` | `{ delta }` | `{ ok, nowPlaying? }` |
| POST | `/transport/volume` | `{ level }` | `{ ok }` |
| POST | `/transport/skip-next` | `{}` | `{ ok, nowPlaying? }` |
| POST | `/transport/skip-prev` | `{}` | `{ ok, nowPlaying? }` |
| POST | `/mode` | `{ mode: "queue" \| "hotswap" \| "manual" }` | `{ ok }` |

## Playlist library (Direct only)

| Method | Path | Response |
|--------|------|----------|
| POST | `/playlists` | `{ ok, config }` |
| DELETE | `/playlists/{id}` | `{ ok, config }` |
| POST | `/playlists/{id}/activate` | `{ ok, config, state? }` |
| POST | `/playlists/{id}/sync` | sync result |
| POST | `/sync` | legacy single-playlist sync |
| POST | `/import-playlist` | `{ ok, added? }` |

## Error responses

HTTP 400: `{ ok: false, error: string }`

## Acceptance

Run `npm run verify:queue-contract` against a running tablet player.
