# Show-ready methodology (state of the art)

**Canonical path:** Karol → BlackHole → **Karol Live Mic** (BH ch1–2 + UMC ch3–6) → Ableton Live → **UMC404HD** → PA

**Sample rate:** **48000 Hz** everywhere (UMC + BlackHole + Live + MacBook native)

---

## Before every show (one command)

```bash
/Users/macdonk/Documents/GitHub/Karol/scripts/karol-show-ready.sh
```

This runs audio setup, USB/drive health, verification, and prints the Live checklist.

**Prerequisites:** Quit Ableton Live (Cmd+Q) first. Plug in UMC404HD + `maxone` drive.

---

## After code changes (rebuild Karol.app)

```bash
/Users/macdonk/Documents/GitHub/Karol/scripts/karol-install-app.sh
```

Then reopen Karol from Applications. The show-ready script can do this with `--build`.

---

## Ableton Live (save as default template)

| Preference | Value |
|------------|--------|
| Sample Rate | **48000 Hz** |
| Audio Input | **Karol Live Mic** |
| Audio Output | **UMC404HD 192k** |
| Buffer Size | **512** (256 if stable; never 64) |
| Input Config | Enable channels **1–6** |
| Output Config | Enable **1–2** |

| Track | Audio From | Monitor | Arm |
|-------|------------|---------|-----|
| **1 — Mic** | Karol Live Mic / **3–4** | **In** | ON |
| **2 — Karol** | Karol Live Mic / **1–2** | **In** | OFF |
| **Master** | UMC404HD / **1–2** | | |

**Track 1:** Autotuna (von dutch / Charli preset). Apply via:

```bash
python3 scripts/karol-charli-autotuna.py
```

Save the Live set as your show template so device routing persists.

---

## Karol DJ controller (Show tab)

| Control | Show value |
|---------|------------|
| **Out** | **55–70%** (not 100% — avoids Live redline) |
| **Vocals** | **0%** (instrumental only; guide vocals only for rehearsal) |
| **Gap** | 15s, MVs mode |
| macOS output | **BlackHole 2ch** (set by show-ready script) |

---

## Audio chain (no duplication)

```
Karol Player
  video  → instrumental (-karaoke.mp4)
  + optional vocal stem WAV (Vocals fader only)
       ↓
  BlackHole 2ch  ← macOS default output
       ↓
  Karol Live Mic aggregate
    ch 1–2: BlackHole (Karol)
    ch 3–6: UMC404HD (mic)
       ↓
  Ableton Live
    Track 1: mic + Autotuna
    Track 2: Karol backing
       ↓
  UMC404HD → PA
```

UMC appears in the **input aggregate** (mic only) and as **Live's output device** — that is correct. Plist fix keeps UMC **outputs unmapped** inside the aggregate to avoid a feedback loop.

---

## Aggregate plist rule (critical)

**Order matters:**

1. `karol-create-live-umc-aggregate` (creates device)
2. `sudo python3 karol-fix-plist-aggregate.py` (UMC outs OFF, drift ON)

**Never run create after plist fix** — it resets UMC outputs.

If glitchy audio returns: plist fix only (no recreate):

```bash
sudo python3 scripts/karol-fix-plist-aggregate.py
```

---

## Verify

```bash
KAROL_AUDIO_MODE=umc-pa scripts/karol-audio-verify.sh
scripts/karol-usb-health.sh
```

Green = ready. Sing into mic + play a Karol song + press Space in Live.

---

## Other modes (not tonight's path)

| Mode | Script | Sample rate |
|------|--------|-------------|
| TV + Shure mic | `karol-show-audio-live-tv-with-mic.sh` | 44100 |
| Direct TV (no Live) | `karol-show-audio-direct-tv.sh` | 44100 |
| DJ aggregate (48k) | `set-default-karol.sh` | 48000 |

Set `KAROL_AUDIO_MODE=live-tv` for TV paths only.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Glitchy / dropouts | Buffer 512+, quit Live before audio scripts |
| No mic in Live | Input Config enable ch 3–6; Monitor **In** |
| No Karol in Live | macOS output must be BlackHole; Track 2 on ch 1–2 |
| Double vocals | Vocals fader 0%; rebuild stems on custom tracks |
| Drive not in library | System Settings → Removable Volumes → enable Karol → Rescan |
| Aggregate 6 outputs | `sudo python3 karol-fix-plist-aggregate.py` (do not recreate after) |
