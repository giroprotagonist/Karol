# Show-ready methodology (state of the art)

## Recommended: low-latency Autotuna (near-instant mic)

**Canonical path:** Karol → **UMC404HD** · Mic → **UMC404HD** → Ableton (Autotuna) → **UMC404HD** → PA

macOS mixes Karol and Live onto the same interface. No BlackHole / aggregate in the monitor path — this is the setup that felt **near instant** when Input+Output were both UMC at buffer 64.

```bash
/Users/macdonk/Documents/GitHub/Karol/scripts/karol-low-latency-show.sh
```

| Preference | Value |
|------------|--------|
| Sample Rate | **48000 Hz** |
| Audio Input | **UMC404HD 192k** |
| Audio Output | **UMC404HD 192k** |
| Buffer Size | **64 or 128** |
| Reduced Latency When Monitoring | **ON** |
| Input Config | Enable **1–4** |
| Output Config | Enable **1–2** |

| Track | Audio From | Monitor | Arm |
|-------|------------|---------|-----|
| **1 — MIC Karaoke** | UMC / **1** | **In** | ON |
| **Karol** | *(not in Live)* | — | — |
| **Master** | UMC / **1–2** | | |

**MIC chain (general karaoke — not song-specific):**
`Karol Karaoke Autotuna` → `Karol Karaoke Vocal FX`  
(Autotuna chromatic ~78%, latency off · Comp → Sat → Presence EQ → De-ess → Double → Slap → Short Verb)

```bash
/opt/homebrew/bin/python3 /Users/macdonk/Documents/GitHub/Karol/scripts/karol-karaoke-vocal-load.py
# Re-apply Autotuna only:
/opt/homebrew/bin/python3 /Users/macdonk/Documents/GitHub/Karol/scripts/karol-karaoke-autotuna.py
```

**Karol Mixer tab:** Music/Out ~50–70% (square taper + ~−11 dB master trim — 100% is no longer unity into the UMC) · Vocals (ch7) 0% unless guide stem · meters + EQ3 · macOS output = UMC (script sets this).

**Karaoke entrance:** After Gap B-roll, opaque singer intro (~5s) runs with the song parked silent underneath, then fades into audible play. DJ/jukebox skips entrance.  

**Karol mono mixer (umc-direct):** Music bus + vocal-stem bus → EQ3 each → mono sum → soft limiter → **L=R on UMC** (PA on **Out 1** always has full signal). No BlackHole/Live on this path.

**MIDI Mix (factory CCs):**
| Control | CC | Karol |
|---------|-----|--------|
| Ch8 fader | 61 | Music / Out |
| Ch8 knobs top→bottom | 58, 59, 60 | Music EQ High / Mid / Low (±12 dB) |
| Ch7 fader | 57 | Vocal stem gain |
| Ch7 knobs top→bottom | 54, 55, 56 | Vocal EQ High / Mid / Low |

Soft-takeover on both faders (works while Live is open).

---

## Alternate: full Live mix (Karol through Ableton)

Use when you need Live FX / levels on the Karol backing track inside the set. **Adds monitor latency** vs UMC-direct. Needs admin once to strip UMC outs from the aggregate.

```bash
/Users/macdonk/Documents/GitHub/Karol/scripts/karol-show-ready.sh
# If verify warns about 6 aggregate outputs:
sudo python3 /Users/macdonk/Documents/GitHub/Karol/scripts/karol-fix-plist-aggregate.py
```

**Chain:** Karol → BlackHole → **Karol Live Mic** (BH ch1–2 + UMC ch3–6) → Live → **UMC404HD** → PA

| Preference | Value |
|------------|--------|
| Sample Rate | **48000 Hz** |
| Audio Input | **Karol Live Mic** |
| Audio Output | **UMC404HD 192k** |
| Buffer Size | **256–512** (not 64 on aggregate) |
| Input Config | Enable **1–6** |

| Track | Audio From | Monitor | Arm |
|-------|------------|---------|-----|
| **1 — Mic** | Karol Live Mic / **3–4** | **In** | ON |
| **2 — Karol** | Karol Live Mic / **1–2** | **In** | OFF |
| **Master** | UMC / **1–2** | | |

**Quit Live (Cmd+Q) before `karol-show-ready.sh`.** Live caches channel counts.

### Aggregate plist rule (umc-pa only)

1. `karol-create-live-umc-aggregate`
2. `sudo python3 karol-fix-plist-aggregate.py` (UMC outs OFF; keep UMC as clock / BlackHole drift ON for lowest mic latency)

**Never run create after plist fix** — create resets UMC outputs.

---

## Autotuna

**Default (general karaoke):**

```bash
/opt/homebrew/bin/python3 scripts/karol-karaoke-autotuna.py
```

Song-specific presets (optional): `karol-charli-autotuna.py` (Von Dutch), `karol-believe-autotuna.py`, `karol-one-more-time-autotuna.py`.

Save the Live set so routing + Karol Karaoke chain persist.

---

## Verify

```bash
# Low-latency (default)
KAROL_AUDIO_MODE=umc-direct scripts/karol-audio-verify.sh

# Full Live mix
KAROL_AUDIO_MODE=umc-pa scripts/karol-audio-verify.sh
```

---

## Audio device prune (latency)

Keep only what the show needs: **UMC404HD**, **BlackHole 2ch**, **Karol Live Mic**.

```bash
/Users/macdonk/Documents/GitHub/Karol/scripts/karol-prune-audio-drivers.sh
```

Removes **BlackHole 16ch** + **Iriun Webcam Audio** (HAL + app). If an Iriun *camera* extension still shows under Login Items → Extensions, turn it off there.

---

## After code changes (rebuild Karol.app)

```bash
/Users/macdonk/Documents/GitHub/Karol/scripts/karol-install-app.sh
```

---

## Other modes

| Mode | Script | Sample rate |
|------|--------|-------------|
| TV + Shure mic | `karol-show-audio-live-tv-with-mic.sh` | 44100 |
| Direct TV (no Live) | `karol-show-audio-direct-tv.sh` | 44100 |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Mic feels delayed | Use **umc-direct** (low-latency script). Aggregate path will always feel slower. |
| Glitchy / dropouts on aggregate | Buffer 256–512; quit Live before audio scripts; plist-fix UMC outs |
| No Karol in PA (umc-direct) | macOS output must be **UMC404HD** |
| No Karol in Live (umc-pa) | macOS output must be **BlackHole**; Track 2 on ch 1–2 |
| Music only on one PA side | Mono mixer duplicates L=R — check UMC Out 1 cable / amp |
| Double Karol audio | Video must stay muted into Web Audio; rebuild/reinstall if old app |
| Double vocals | Vocals fader 0% |
| Aggregate 6 outputs | `sudo python3 karol-fix-plist-aggregate.py` |
