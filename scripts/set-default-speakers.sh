#!/bin/bash
# Set macOS default output to MacBook Pro Speakers (direct playback, no TV/AirPlay).
set -euo pipefail
SAS="${SWITCH_AUDIO_SOURCE:-/opt/homebrew/bin/SwitchAudioSource}"
NAME="${KAROL_SPEAKERS_NAME:-MacBook Pro Speakers}"
if [[ ! -x "$SAS" ]]; then
  echo "ERROR: SwitchAudioSource not found (brew install switchaudio-osx)" >&2
  exit 1
fi
"$SAS" -s "$NAME" -t output
echo "Default output → $NAME"
