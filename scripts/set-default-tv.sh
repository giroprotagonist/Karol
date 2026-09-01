#!/bin/bash
# Set macOS default output to Living room TV (direct Karol→AirPlay, no Live).
set -euo pipefail
SAS="${SWITCH_AUDIO_SOURCE:-/opt/homebrew/bin/SwitchAudioSource}"
NAME="${KAROL_TV_NAME:-Living room TV}"
if [[ ! -x "$SAS" ]]; then
  echo "ERROR: SwitchAudioSource not found (brew install switchaudio-osx)" >&2
  exit 1
fi
"$SAS" -s "$NAME" -t output
echo "Default output → $NAME"
