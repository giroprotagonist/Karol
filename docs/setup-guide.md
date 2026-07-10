# Karol Setup Guide

## Prerequisites

- macOS with Node.js 23+, Python 3, Android SDK
- Samsung Tab S8 (android-player) and Galaxy S24 (android-controller)
- VLC media player, Ableton Live (optional)
- BlackHole 16ch virtual audio driver (`brew install blackhole-16ch`)

## 1. Mac Backend

### Install dependencies
```bash
npm ci
cd src/dj-controller && npm ci && cd ../..
```

### Build the DJ controller SPA
```bash
npm run buildDjController
```

### Start the API server (LaunchAgent — auto-starts at login)
```bash
# One-time setup
node scripts/karol-api-server.js &  # verify it starts
kill %1

# Install LaunchAgent
cp scripts/com.karol-api.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.karol-api.plist
```

### Verify
```bash
curl http://127.0.0.1:3131/api/ableton/health
# → {"ok":true,"connected":false}  (true when Ableton is open)
```

## 2. Tab S8 Player

### Install
```bash
npm run install:android
# Installs android-player RELEASE APK on Tab S8
```

### Restore YouTube session (if needed)
```bash
npm run player:restore-youtube-session
```

### Verify YouTube sign-in
```bash
curl http://192.168.68.57:3131/api/youtube-dj/health
# → {"youtubeSignedIn":true,...}
```

### Troubleshooting
- **Black screen with audio**: The `youtubeWatchLayout.js` quality guard caps at hd1080. Check WebView layer type in MainActivity.kt.
- **Muted audio randomly**: Auto-recovery poll runs every 2s. If persistent, restart the app.
- **Video freezes**: Quality drops to hd720 after 5s buffering. Freeze recovery seeks +0.1s after 6s stall.

## 3. Galaxy S24 Controller

### Install
```bash
# Build and install
cd android-controller && ./gradlew assembleRelease && cd ..
adb -s <S24_SERIAL> install -r android-controller/app/build/outputs/apk/release/app-release.apk
```

### Connection
The controller auto-discovers via mDNS + subnet scan. If stuck on "Connecting to Karol...":
1. Ensure Mac backend is running (step 1)
2. Retry button triggers full auto-discovery
3. Check WiFi — both devices must be on same network

## 4. VLC Integration

### Configure VLC
1. VLC → Preferences → Show All → Interface → Main Interfaces
2. Check "Web" interface
3. Under "Lua" → set password: `karol`

### Default library path
```bash
~/.deskreen/tidal-exports/audio
```
Place your music files here. Supported formats: MP3, M4A, FLAC, WAV, OGG, AIFF.

### Verify
```bash
curl http://127.0.0.1:3131/api/vlc-dj/health
# → {"ok":true,"vlcAvailable":true,"hardwareAvailable":true}
```

## 5. Ableton Live (Optional)

### Install AbletonOSC
1. Download [AbletonOSC](https://github.com/ideoforms/AbletonOSC)
2. Copy to Ableton's Remote Scripts folder:
   ```bash
   cp -r AbletonOSC "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/MIDI Remote Scripts/"
   ```
3. In Ableton → Preferences → Link/Tempo/MIDI → Control Surface: select "AbletonOSC"

### Audio Routing (Karaoke DJ + VLC → Ableton)
```bash
# One-command setup (handles Multi-Output Device, VLC config, default output):
bash scripts/setup-uphoria-audio.sh

# Then verify:
bash scripts/verify-audio-routing.sh
```

The setup script creates a Multi-Output Device called "Karol" containing:
- UMC404HD 192k (master clock — goes to PA)
- BlackHole 16ch (drift-corrected — feeds VLC audio into Ableton)

After setup, configure Ableton:
1. Preferences → Audio → Output Device: "Karol"
2. Preferences → Audio → Input Device: "UMC404HD 192k"
3. Track 0 (Karol DJ): Audio From → "BlackHole 16ch" channels 1/2
4. Track 1 (VLC Playlist): Audio From → "BlackHole 16ch" channels 3/4

VLC is automatically configured to output to BlackHole 16ch.

### Verify
```bash
lsof -i :11000 2>/dev/null
# Should show 'Live' process listening on UDP port 11000
```

## 6. iPhone Mixer (Optional)

Open Safari on iPhone, navigate to:
```
http://192.168.68.51:3131/ableton-mixer/
```
Add to Home Screen for PWA experience (landscape, full-screen).

## 7. U-Phoria UMC404HD Audio Interface

### Verify Detection
```bash
system_profiler SPAudioDataType | grep UMC404HD
# → UMC404HD 192k
```

### Check Status from S24
```bash
curl http://127.0.0.1:3131/api/audio/devices
# → {"ok":true,"devices":{"umc404hd":{"present":true,...},"blackhole16ch":{"present":true},"karolAggregate":{"present":true}},...}
```

### Get Recommended Track Layout
```bash
curl http://127.0.0.1:3131/api/ableton/template | python3 -m json.tool
# Returns the full track layout with inputs, plugins, and routing
```

### Signal Flow
```
Mic (UMC Input 1) ──→ Ableton Track 0 "Karol DJ" ──→ UMC Outputs 1-2 ──→ PA
VLC audio ──→ BlackHole ch 3-4 ──→ Ableton Track 1 "VLC Playlist" ──→ UMC Outputs 1-2 ──→ PA
```

### Troubleshooting
- **No audio from VLC in Ableton**: Check VLC output device → BlackHole 16ch. Verify Ableton track input monitoring is set to "In".
- **Mic not audible**: Check UMC input gain knob. Verify Ableton track 0 input is "UMC404HD 192k" channels 1/2.
- **Aggregate device missing**: Run `bash scripts/setup-uphoria-audio.sh` again.

## 8. Environment Variables

Copy `.env.example` to `.env` and customize:
```bash
cp .env.example .env
# Edit .env with your values
```

| Variable | Default | Purpose |
|---|---|---|
| `ANDROID_KEYSTORE_PASSWORD` | `karol123` | Android signing keystore |
| `ANDROID_KEY_ALIAS` | `karol` | Android key alias |
| `ANDROID_KEY_PASSWORD` | `karol123` | Android key password |
| `VLC_PASSWORD` | `karol` | VLC HTTP interface password |
| `KAROL_API_PORT` | `3131` | API server port |

## 9. Common Commands

```bash
# Audio setup (one-time)
bash scripts/setup-uphoria-audio.sh
bash scripts/verify-audio-routing.sh

# Save YouTube session from tablet
npm run player:save-youtube-session

# Push YouTube session to tablet
npm run player:restore-youtube-session

# Sync DJ controller build to player assets
bash scripts/sync-dj-controller-to-player.sh

# Build both Android APKs
cd android-player && ./gradlew assembleRelease && cd ..
cd android-controller && ./gradlew assembleRelease && cd ..

# Restart API server
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.karol-api.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.karol-api.plist

# Run tests
npm test                          # DJ controller vitest
cd android-player && ./gradlew test  # Android player tests
cd android-controller && ./gradlew test  # Android controller tests
```
