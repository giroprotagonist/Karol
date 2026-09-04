#!/bin/bash
# Install Autotuna preset scripts into Karol.app bundle.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTS="$ROOT/scripts"
KAROL_BUNDLE="/Applications/Karol.app/Contents/Resources/scripts"

echo "Autotuna presets (apply via OSC when Live is open):"
echo "  python3 $SCRIPTS/karol-karaoke-autotuna.py          # general karaoke (default)"
echo "  python3 $SCRIPTS/karol-karaoke-vocal-load.py        # load Autotuna + FX rack"
echo "  python3 $SCRIPTS/karol-believe-autotuna.py"
echo "  python3 $SCRIPTS/karol-one-more-time-autotuna.py"
echo "  python3 $SCRIPTS/karol-charli-autotuna.py"
echo ""
echo "Save as .adv in Live: Autotuna on track → run script → Save Preset As in device header."
echo "  User Library/Presets/Audio Effects/Max Audio Effect/"
echo ""

if [[ -d "$KAROL_BUNDLE" ]]; then
  for f in karol_autotuna_lib.py karol-autotuna-preset.py \
           karol-karaoke-autotuna.py karol-karaoke-vocal-load.py \
           karol-believe-autotuna.py karol-one-more-time-autotuna.py karol-charli-autotuna.py; do
    cp "$SCRIPTS/$f" "$KAROL_BUNDLE/$f"
    chmod +x "$KAROL_BUNDLE/$f"
  done
  echo "Copied to $KAROL_BUNDLE"
fi

/opt/homebrew/bin/python3 "$SCRIPTS/karol-autotuna-preset.py" --list
