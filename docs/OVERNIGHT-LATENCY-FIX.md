# Overnight latency fix (2026-09-04)

## Verdict

Aggregate (BlackHole + UMC) always felt delayed. **UMC-direct is the fix** —
you confirmed ~6.3 ms overall latency feels near-instant.

## What was done while you slept

1. **Default show path = umc-direct** (near-instant mic)
   - `scripts/karol-low-latency-show.sh` (new)
   - `scripts/karol-show-ready.sh` now defaults to that mode
   - Use `--live-mix` only when you need Karol *inside* Live

2. **macOS output → UMC404HD** so Karol and Live share the interface clock
   (OS mixes both to the PA — no BlackHole in the monitor path)

3. **Ableton** left configured:
   - Input + Output = UMC404HD @ 48 kHz, buffer **64** (~6.3 ms)
   - Options → **Reduced Latency When Monitoring** = ON
   - Set saved: `~/Karol-LowLatency-Show Project/Karol-LowLatency-Show.als`
   - MIC track: Ext.In **1**, Monitor **In**, Arm ON, **Autotuna** + Charli/Von Dutch preset

4. **Aggregate path** still available (`--live-mix`) but needs one admin command
   to strip UMC outs (CoreAudio API cannot do it alone):
   ```bash
   sudo python3 scripts/karol-fix-plist-aggregate.py
   ```
   Plist fix now keeps **UMC as clock** / BlackHole drift ON (better for mic).

## When you wake up

```bash
scripts/karol-low-latency-show.sh
# Open Live → Karol-LowLatency-Show
# Sing — should still feel near-instant
# Play Karol — Out 55–70%, Vocals 0%
```

Autotuna **Latency** is set **off** (faster monitor). Turn it on in the device
if pitch tracking feels worse and you can spare a little delay.

Preset apply: `/opt/homebrew/bin/python3 scripts/karol-charli-autotuna.py`

## Docs

- `docs/SHOW-READY.md` — both modes
- `scripts/karol-live-input-config-umc.txt` — Live checklist
