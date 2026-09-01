# Ableton Live track setup — Karol + Shure → TV

**Chain:** Karol player → BlackHole → **Karol Live Mic** (Shure ch1 + Karol ch2-3) → Ableton Live → Living room TV

**Sample rate:** 44100 Hz everywhere (TV requirement). Shure is 48 kHz native; the aggregate with drift correction handles the conversion.

---

## Before the show — ONE COMMAND

```bash
/Users/macdonk/Documents/GitHub/Karol/scripts/karol-show-night.sh
```

This script:
- Sets BlackHole to 44100 Hz
- Routes macOS output to BlackHole (Karol audio → Live)
- Creates/repairs **Karol Live Mic** aggregate (Shure ch1 + BH ch2-3)
- Fixes Shure drift correction + removes Shure outputs (admin password if prompted)
- Captures 3 sec from ch1 to prove mic signal
- Runs full `karol-audio-verify.sh`

Then in Live: **Preferences → Audio → Input Config → enable 1, 2, 3**

Full Live steps: `scripts/karol-live-input-config-instructions.txt`

---

## Karol Live Mic aggregate (Plan B layout)

| Setting | Value |
|---------|--------|
| **Name** | Karol Live Mic |
| **Clock Source** | BlackHole 2ch |
| **Sample rate** | 44100 Hz |
| **Inputs** | 3 (Shure ch1 + BH ch2-3) |
| **Outputs** | 2 (BlackHole only) |

| Sub-device | Aggregate channels | Drift Correction |
|------------|-------------------|------------------|
| Shure MVX2U | **in 1** only, no outputs | **ON** |
| BlackHole 2ch | in 2-3, out 1-2 | OFF (clock master) |

Recreated automatically by `karol-show-night.sh`. Manual repair:

```bash
scripts/karol-create-live-mic-aggregate    # CoreAudio API
sudo python3 scripts/karol-fix-plist-aggregate.py   # drift + outs (if API ignores them)
```

---

## Ableton Live — Preferences → Audio

| Setting | Value |
|---------|--------|
| Driver Type | CoreAudio |
| Audio Input Device | **Karol Live Mic** |
| Audio Output Device | **Living room TV** |
| Sample Rate | **44100 Hz** |

**Input Config** → enable **1, 2, 3** (ch1 = Shure mono, ch2-3 = Karol stereo).

**Output Config** → enable **1, 2** for TV.

> **Quit Live (Cmd+Q) before running show-night.sh.** Live caches channel counts.

---

## Track wiring

### Track 1 — Shure mic

| Setting | Value |
|---------|--------|
| Audio From | Ext. In → **Karol Live Mic** / **1** |
| Monitor | **In** (NOT Off) |
| Arm | **ON** |

### Track 2 — Karol backing

| Setting | Value |
|---------|--------|
| Audio From | Ext. In → **Karol Live Mic** / **2-3** (stereo pair — both ch2 and ch3) |
| Monitor | **In** (NOT Off) |
| Arm | OFF |

> In Ableton's picker this may appear as **2/3** or **2-3** — same thing. Input Config must have **channels 2 and 3 enabled** (enable all 1, 2, 3).

### Master

| Setting | Value |
|---------|--------|
| Output | **Living room TV** / **1/2** |

---

## Troubleshooting

```bash
scripts/karol-audio-verify.sh          # green/red status
scripts/karol-fix-aggregate-mic.sh   # diagnose + --create / --nuclear
```

| Symptom | Fix |
|---------|-----|
| No meters on any track | **Monitor must be In**, not Off. Arm mic track. |
| Karol in Live, no mic | Track 1 → Karol Live Mic **/ 1**, Monitor **In**, Arm ON |
| Mic in Live, no Karol | macOS output → BlackHole. Track 2 → Karol Live Mic **/ 2-3** |
| OS ch1 works, Live silent | Live log `Input Channels: 2` → enable all 3 in Input Config |
| Pitchy mic | Live must be 44100. Do not use Shure as input device. |

### Verify OS vs Live

| Check | Command |
|-------|---------|
| OS ch1 alive | `karol-audio-verify.sh` (ch1 mic line green) |
| Live enabled inputs | `grep "Input Channels" ~/Library/Preferences/Ableton/Live*/Log.txt \| tail -1` → must be **3** |
| Shure hardware | ffmpeg direct capture shows ~-55 to -70 dB room noise |

---

## What NOT to do tonight

- Do **not** set **Monitor to Off** on input tracks.
- Do **not** select **Shure MVX2U** as Live input (48 kHz).
- Do **not** select **BlackHole 2ch** alone as input (no mic).
- Do **not** set Live to 48000 Hz.
- Do **not** use ch3 for mic — mic is **ch1** now.
