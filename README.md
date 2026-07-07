# Deskreen CE (Community Edition)

![platform](https://img.shields.io/badge/platform-Windows%20%7C%20MacOS%20%7C%20Linux-lightgrey)
(Over 2M downloads during 5 years since launch)

![Deskreen Logo](https://raw.githubusercontent.com/pavlobu/deskreen/master/resources/icon.png)

## Deskreen turns any device with a web browser into a secondary screen for your computer

## To learn more visit our website: [deskreen.com](https://deskreen.com)

## [Donate to support Deskreen Open-Source](https://deskreen.com/#contribute)

Deskreen is an `electron.js` based application that uses `WebRTC` to make a live stream of your computer screen to a web browser on any device. It is available for MacOS, Windows and Linux operating systems.
The current open-source Community Edition version has limited features. If you need more features please consider upgrading to [Pro](https://deskreen.com/download) version for more features when it is released.

---

### ▶️ [See how people use Deskreen on Youtube](https://www.youtube.com/results?search_query=deskreen) (video tutorials, demos, use cases for Deskreen day to day usage)

---

## [Deskreen Frequently Asked Questions](https://deskreen.com/faq)

---

### Prerequisites

You will need to have `node>=v23` `npm>=10` installed.


1. git clone this repo
2. `npm i`
3. `cd ./src/client-viewer && npm i && cd ../..`
4. `npm run clean && npm run build && npm run start` -- run in prod like mode

#### for more npm scripts look at `package.json`

## Starting with Custom Local IP

You can start Deskreen CE with a custom local IP address using the `--local-ip` or `--ip` CLI flag. This is useful when you want to specify a particular network interface IP address.

### macOS

```bash
# Using open command (recommended)
open -a "Deskreen CE" --args --ip 192.168.1.100

# Or using the executable directly
/Applications/Deskreen\ CE.app/Contents/MacOS/Deskreen\ CE --ip 192.168.1.100

# Get your IP automatically and launch
open -a "Deskreen CE" --args --ip "192.168.1.100"
```

### Windows

```powershell
# Using Start-Process (PowerShell)
Start-Process "Deskreen CE" -ArgumentList "--ip", "192.168.1.100"

# Or using the executable directly
"C:\Program Files\Deskreen CE\Deskreen CE.exe" --ip 192.168.1.100

# Or from Command Prompt
start "" "C:\Program Files\Deskreen CE\Deskreen CE.exe" --ip 192.168.1.100
```

### Linux

```bash
# If installed via AppImage
./Deskreen\ CE-*.AppImage --ip 192.168.1.100

# If installed via .deb/.rpm package (usually in /usr/bin or /opt)
deskreen-ce --ip 192.168.1.100

# Or using full path
/opt/Deskreen\ CE/deskreen-ce --ip 192.168.1.100
```

**Note:** Replace `192.168.1.100` with your actual local IP address. You can find your IP using:
- **macOS/Linux:** `ipconfig getifaddr en0` or `ifconfig | grep "inet "`
- **Windows:** `ipconfig` (look for IPv4 Address)

When using the `--ip` or `--local-ip` flag, the app will use the specified IP for QR codes and connection URLs, while still monitoring the actual network interface status for WiFi connection detection.

## YouTube DJ: Cast vs Direct mode

| Mode | Host | Tablet app | Remote |
|------|------|------------|--------|
| **Cast** | Mac (Deskreen CE) | `android-receiver` — WebRTC mirror | `android-controller` or `/dj-controller/` |
| **Direct** | Tablet (`android-player`) | Fullscreen `watch?v=` YouTube kiosk | Same controller UI — point at tablet IP |

### Build and install Direct Player (tablet host)

```bash
npm run sync:dj-controller-player   # build dj-controller + copy kiosk JS into APK assets
cd android-player && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### Build and install Controller (phone)

```bash
cd android-controller && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

**Deploy order:** run `sync:dj-controller-player` first whenever the web UI or YouTube kiosk JS changes, then rebuild the player APK. The controller APK bundles only the native shell (WebView loads the tablet-hosted SPA in Direct mode).

Run unit tests:

```bash
cd android-player && ./gradlew testDebugUnitTest
cd android-controller && ./gradlew testDebugUnitTest
```

On the tablet: open **Deskreen Player** → tap **Start show**. Controller URL is shown on screen (`http://<tablet-ip>:3131/dj-controller/`).

**Navigation:** System back exits HTML5 fullscreen first, then returns to the start screen (playback paused). The DJ API on `:3131` stays up so the phone can keep queuing; tap **Start show** again to resume.

**Audio:** The tablet player downmixes YouTube stereo to mono `(L+R)/2` and sends it to both speakers (ideal for single-speaker karaoke setups).

Phone (S24): open **Deskreen Controller** — LAN discovery prefers `dj-player` hosts.

Verify API (tablet on WiFi):

```bash
DESKREEN_HOST=<tablet-ip> npm run verify:player-direct
```

Shared YouTube kiosk layout JS lives in [`src/youtube-kiosk/youtubeWatchLayout.js`](src/youtube-kiosk/youtubeWatchLayout.js) (no `/embed/` URLs).

## Maintainer

- [Pavlo (Paul) Buidenkov](https://www.linkedin.com/in/pavlobu)

## License

AGPL-3.0 License © [Pavlo (Paul) Buidenkov](https://github.com/pavlobu/deskreen)

## Copyright

Electron-Vite MIT License © [electron-vite](https://github.com/alex8088/electron-vite)

React MIT License © [Facebook, Inc. and its affiliates](https://github.com/facebook/react)

Vite MIT License © [Vite.js](https://github.com/vitejs/vite)

Electron Builder MIT License © [electron-builder contributors](https://github.com/electron-userland/electron-builder)

Apache 2.0 © [blueprintjs](https://github.com/palantir/blueprint)

simple-peer MIT. Copyright © [Feross Aboukhadijeh](http://feross.org/)

tweetnacl ISC License © Dmitry Chestnykh, Devi Mandiri, and contributors (https://github.com/dchest/tweetnacl-js)

darkwire.io MIT License © [darkwire/darkwire.io](https://github.com/darkwire/darkwire.io)

And many many others...

## Thanks

🙏 Many thanks to all 🌍 open source community members and maintainers of libraries used in this project.
