#!/bin/bash
# Direct path: Karol player → Living room TV (no Ableton).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTS="$ROOT/scripts"
SAS="/opt/homebrew/bin/SwitchAudioSource"
TV_NAME="${KAROL_TV_NAME:-Living room TV}"

echo "═══ Karol show audio: Direct → TV ═══"
echo ""
"$SCRIPTS/set-default-tv.sh"
echo ""
echo "Karol player audio goes straight to $TV_NAME."
echo "Close Ableton or mute its output if you were using Live→TV mode."
if [[ -x "$SAS" ]]; then
  cur="$("$SAS" -c -t output 2>/dev/null || true)"
  echo "Current macOS output: ${cur:-unknown}"
fi
echo "Done."
