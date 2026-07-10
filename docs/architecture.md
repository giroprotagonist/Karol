# Karol Architecture

## System Overview

```mermaid
graph TD
    subgraph Mac["macOS Host"]
        KAPI[karol-api-server.js<br/>port 3131<br/>LaunchAgent]
        DESKREEN[Deskreen CE Electron<br/>port 3131+<br/>signaling + sharing]
        VLC[VLC media player<br/>HTTP API :8080]
        ABLETON[Ableton Live<br/>AbletonOSC UDP :11000]
        TIDAL[~/.deskreen/tidal-exports/audio<br/>local music library]

        KAPI -->|osascript| VLC
        KAPI -->|UDP OSC| ABLETON
        KAPI -->|filesystem| TIDAL
        KAPI -->|static serve| SPA_DJ[ /dj-controller/ SPA]
        KAPI -->|static serve| SPA_MIX[ /ableton-mixer/ SPA]
    end

    subgraph S8["Samsung Tab S8 — Player"]
        KTOR[Ktor HTTP server<br/>port 3131]
        YTWV[YouTube WebView<br/>watch page]
        PROXY[proxyToMacHost<br/>→ 192.168.68.51:3131]

        KTOR -->|serve| SPA_DJ2[ /dj-controller/ SPA]
        KTOR -->|proxy /api/*| PROXY
        YTWV -->|video playback| YT[YouTube]
        KTOR -->|JavaScript bridge| YTWV
    end

    subgraph S24["Galaxy S24 — Controller"]
        CTRL[React SPA WebView]
        CTRL -->|HTTP| KTOR
        CTRL -->|mDNS discovery| KTOR
    end

    subgraph iPhone["iPhone — Mixer"]
        MIXER[ableton-mixer SPA]
        MIXER -->|HTTP| KAPI
    end

    PROXY --> KAPI
```

## Component Responsibilities

### karol-api-server.js (Mac, port 3131)
- **Authority** for all Karol API routes: YouTube DJ, VLC, Ableton
- VLC HTTP API bridge (`/api/vlc-dj/*`)
- AbletonOSC UDP bridge (`/api/ableton/*`)
- Serves DJ controller SPA (`/dj-controller/`)
- Serves Ableton mixer SPA (`/ableton-mixer/`)
- Managed by LaunchAgent: `~/Library/LaunchAgents/com.karol-api.plist`

### Deskreen CE Electron (Mac, auto-selects port)
- Legacy screen sharing and Socket.IO signaling
- `discover.json` / `health.json` for device discovery
- **Delegates** Ableton/VLC to karol-api-server.js

### Ktor HTTP Server (Tab S8, port 3131)
- Serves DJ controller SPA
- Proxies `/api/*` to Mac backend
- Manages YouTube WebView lifecycle
- Injects `youtubeWatchLayout.js` for playback control

### DJ Controller SPA (React + Vite)
- 5 tabs: Player, Queue, Add, Playlists, VLC
- YouTube queue/playlist management
- VLC library browser and queue
- Drag-and-drop reordering (`@dnd-kit`)
- Client-side playback clock for low-latency seek display

### Ableton Mixer SPA (vanilla JS)
- iPhone landscape-optimized mixer
- Track volume, pan, mute, solo, sends, meters
- Master fader, tempo (tap tempo)
- 500ms polling with 80ms input debounce

## Data Flow

### YouTube DJ Flow
```
S24 POST /api/youtube-dj/queue → S8 proxy → Mac JS server → YouTube playlist sync
S8 WebView: youtubeWatchLayout.js monitors <video> events → JSON state → S8/Ktor → S24 polls
```

### VLC Flow
```
S24 POST /api/vlc-dj/queue → S8 proxy → Mac JS server → osascript VLC
Mac: osascript queries VLC state → JSON → S24 polls /api/vlc-dj/status
Cover art: /api/vlc-dj/cover?path=FILE → serves embedded album art from audio files
```

### Ableton Flow
```
S24 POST /api/ableton/track/0/volume → S8 proxy → Mac JS server → UDP OSC → AbletonOSC
Mac JS server polls Ableton state via OSC queries → cachedAbletonState → /api/ableton/mixer-state
iPhone mixer SPA: 500ms poll /api/ableton/mixer-state → render track strips
```

## Session Persistence

```
Tab S8:
  YouTube cookies → Android EncryptedSharedPreferences
  Backup: /sdcard/Downloads/Deskreen/deskreen-youtube-session.json

Mac:
  YouTube session: .deskreen/youtube-session.json (gitignored)
  Scripts: player:save-youtube-session / player:restore-youtube-session
```
