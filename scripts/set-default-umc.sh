#!/bin/bash
# Set macOS default output to UMC404HD (DJ/PA path — Karol still uses BlackHole via Live).
# Note: for Karol→Live chain, macOS output should stay BlackHole; this is for direct monitoring only.
set -euo pipefail
SAS="${SWITCH_AUDIO_SOURCE:-/opt/homebrew/bin/SwitchAudioSource}"
NAME="${KAROL_UMC_NAME:-UMC404HD 192k}"
if [[ ! -x "$SAS" ]]; then
  echo "ERROR: SwitchAudioSource not found (brew install switchaudio-osx)" >&2
  exit 1
fi
"$SAS" -s "$NAME" -t output
echo "Default output → $NAME"
