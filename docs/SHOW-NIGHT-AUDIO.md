# Show-night audio

Karol supports two audio setups. Pick one before the show — they use different sample rates and hardware.

## Mode A — Mirror + Live → TV + Shure mic (tonight’s path)

**Chain:** Karol → BlackHole → Aggregate (ch 1-2) + Shure (ch 3) → Ableton Live → Living room TV

**One command:**

```bash
/Users/macdonk/Documents/GitHub/Karol/scripts/karol-show-audio-live-tv-with-mic.sh
```

This aligns BlackHole to **44100 Hz**, sets macOS output to BlackHole, and verifies the Aggregate Device.

**Verify before singing:**

```bash
/Users/macdonk/Documents/GitHub/Karol/scripts/karol-audio-verify.sh
```

**Ableton Live (verify every show):** see [LIVE-TRACK-SETUP.md](LIVE-TRACK-SETUP.md) for exact track wiring.

| Setting | Value |
|---------|--------|
| Sample rate | **44100 Hz** |
| Input | **Aggregate Device** — ch 1-2 Karol, ch 3 Shure mic |
| Output | **Living room TV** |
| Avoid | Shure MVX2U or BlackHole **alone** as Live input; UMC404HD (48 kHz) |

Shure is 48 kHz native but works at 44100 through the aggregate with drift correction enabled.

**macOS:** Screen mirroring to Living room TV for video (already working). Audio does **not** go direct to TV in this mode — Live must output to the TV.

**Karol auto-align:** On startup, Karol aligns BlackHole to 44100 when Living room TV is the default output, or when `KAROL_AUDIO_MODE=live-tv` is set. Quit Ableton first if align fails (CoreAudio locks the rate).

```bash
export KAROL_AUDIO_MODE=live-tv   # optional — force Live→TV path
```

---

## Mode B — Full DJ (Shure + UMC, no AirPlay TV)

**Chain:** Karol → Karol aggregate (BlackHole + UMC404HD) → Ableton → UMC analog outs → PA

**Sample rate:** **48000 Hz** everywhere (UMC and Shure require 48 kHz).

**One command (when UMC is plugged in):**

```bash
/Users/macdonk/Documents/GitHub/Karol/scripts/set-default-karol.sh
```

Do **not** run `karol-show-audio-live-tv.sh` in this mode. Karol skips BlackHole 44100 alignment when UMC is detected and you are not in `live-tv` mode.

**Ableton:** 48000 Hz, Karol aggregate or BlackHole + UMC paths, Shure mic on UMC inputs as usual. No Living room TV on the master output.

---

## Mode C — Direct Karol → TV (no Live)

**Chain:** Karol player → Living room TV (same as before Live routing)

```bash
/Users/macdonk/Documents/GitHub/Karol/scripts/karol-show-audio-direct-tv.sh
```

Use when you want karaoke on the TV without Ableton in the chain.

---

## Scripts reference

| Script | Purpose |
|--------|---------|
| `scripts/blackhole-44100` | Set BlackHole 2ch to 44100 Hz |
| `scripts/set-default-blackhole.sh` | macOS output → BlackHole |
| `scripts/set-default-tv.sh` | macOS output → Living room TV |
| `scripts/set-default-karol.sh` | macOS output → Karol aggregate (48 kHz DJ) |
| `scripts/karol-show-audio-live-tv.sh` | Mode A setup (Karol only, no mic) |
| `scripts/karol-show-audio-live-tv-with-mic.sh` | Mode A + Shure mic (tonight) |
| `scripts/karol-audio-verify.sh` | Green/red status check |
| `scripts/karol-fix-aggregate-mic.sh` | Mic silent in Live but OS ch3 OK — step-by-step fix |
| `scripts/karol-show-audio-direct-tv.sh` | Mode C setup |

Requires [SwitchAudioSource](https://github.com/deweller/switchaudio-osx): `brew install switchaudio-osx`

**Rebuild blackhole binary after Swift changes:**

```bash
swiftc -O -o scripts/blackhole-44100 scripts/blackhole-44100.swift
```
