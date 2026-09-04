#!/bin/bash
# Set macOS default output to UMC404HD.
# umc-direct (recommended): Karol + Live both on UMC — near-instant mic, OS mixes.
# umc-pa Live-mix: use set-default-blackhole.sh instead so Karol feeds the aggregate.
set -euo pipefail
SAS="${SWITCH_AUDIO_SOURCE:-/opt/homebrew/bin/SwitchAudioSource}"
NAME="${KAROL_UMC_NAME:-UMC404HD 192k}"
if [[ ! -x "$SAS" ]]; then
  echo "ERROR: SwitchAudioSource not found (brew install switchaudio-osx)" >&2
  exit 1
fi
"$SAS" -s "$NAME" -t output
echo "Default output → $NAME"
