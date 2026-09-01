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

## Show night flow

**DJ is the default; KJ is an interrupt.** Gap interstitial and Music Jukebox are one DJ layer.

1. **Arm DJ once** — Music Videos tab → **Start Music Jukebox**. Full MVs play when no singers are pending; the same Music Videos pool also feeds Gap B-roll.
2. **Singers join at next Gap** — Add karaoke to the **Singer queue** (or let QR requests land there). The current MV finishes, Gap shows up-next, then karaoke plays. Prefer Karaoke / Custom tabs for singables.
3. **Empty singer list → DJ resumes** — Finished karaoke drops off the queue; if the DJ deck is still armed, the next MV starts after Gap without pressing Start again.
4. **Gap / HOLD** — **HOLD** freezes the between-songs screen (B-roll keeps playing); **RESUME** continues. **Pause** only pauses the current song.
5. **Live FX** — Laptop FX bar (phone is transport/queue only). Gap & HOLD stay on the laptop.

Phone remote is an emergency subset: queue and transport work; Gap/HOLD and full library tools stay on the laptop.

## Show ready (UMC PA + Live)

**State-of-the-art path:** Karol → BlackHole → Karol Live Mic → Ableton Live → UMC404HD → PA @ **48 kHz**.

```bash
# Before every show (quit Live first)
scripts/karol-show-ready.sh

# After code changes
scripts/karol-install-app.sh
# or: scripts/karol-show-ready.sh --build
```

Full methodology: [docs/SHOW-READY.md](docs/SHOW-READY.md)


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
