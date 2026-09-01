#!/bin/bash
# Set macOS default output to BlackHole 2ch (Karol player → Live input).
set -euo pipefail
SAS="${SWITCH_AUDIO_SOURCE:-/opt/homebrew/bin/SwitchAudioSource}"
NAME="${KAROL_BLACKHOLE_NAME:-BlackHole 2ch}"
if [[ ! -x "$SAS" ]]; then
  echo "ERROR: SwitchAudioSource not found (brew install switchaudio-osx)" >&2
  exit 1
fi
"$SAS" -s "$NAME" -t output
echo "Default output → $NAME"
