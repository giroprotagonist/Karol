# Karol — Karaoke DJ

Karol is a karaoke DJ system built for house parties and small venues.

**Core stack:**
- **Player** — Samsung Tab S8 tablet running a native Android app (ExoPlayer) for video playback
- **Controller** — Samsung S24 phone running a native Android controller app for queue management and transport controls
- **API Server** — Node.js (Koa) running on a Mac, serving the local video library, proxying YouTube DJ requests to the tablet, and handling song requests
- **DJ Controller** — React + TypeScript web UI for browsing the library, managing the queue, and controlling playback
- **Library Dashboard** — Public-facing HTML page for browsing the karaoke library and submitting song requests with Venmo/CashApp tips

**Features:**
- 4,600+ karaoke videos in local library
- Real-time lyric overlay on the tablet using LRC files
- YouTube playlist import and auto-advance
- Song request system with payment integration
- MySQL-backed persistence for requests and tags
- Cloudflare Tunnel for remote access to the library

## Quick Start

```bash
# Install all workspace dependencies
npm install

# Start the API server
cd api-server && node index.js

# Start the DJ controller dev server
cd dj-controller && npm run dev

# Build and install Android player
npm run build:android-player
```

## Directory Structure

```
karol/
├── api-server/         # Koa API server (Node.js)
├── dj-controller/      # React + TypeScript DJ web UI
├── electron/           # Minimal Electron wrapper (macOS app)
├── android-player/     # S8 tablet Android app (Kotlin)
├── android-controller/ # S24 phone Android app (Kotlin)
├── library-dashboard/  # Public library request page
├── tools/              # Karaoke video creation scripts (Python)
├── scripts/            # Deploy, test, and infra scripts
├── server/             # Bluehost PHP proxy and MySQL schema
├── ableton-mixer/      # Ableton Link mixer web UI
├── youtube-kiosk/      # YouTube watch page injection
├── transverb-juce/     # JUCE audio plugin
└── shared/             # Shared TypeScript types
```
