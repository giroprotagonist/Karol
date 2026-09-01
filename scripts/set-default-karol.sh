#!/bin/bash
# Set macOS default output to Karol aggregate (BlackHole + UMC404HD at 48 kHz DJ path).
set -euo pipefail
SAS="${SWITCH_AUDIO_SOURCE:-/opt/homebrew/bin/SwitchAudioSource}"
NAME="${KAROL_AGGREGATE_NAME:-Karol}"
if [[ ! -x "$SAS" ]]; then
  echo "ERROR: SwitchAudioSource not found (brew install switchaudio-osx)" >&2
  exit 1
fi
"$SAS" -s "$NAME" -t output
echo "Default output → $NAME (48 kHz DJ aggregate)"
