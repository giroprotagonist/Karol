#!/usr/bin/env bash
# Remove BlackHole 16ch — Karol uses BlackHole 2ch only (UMC PA path).
set -euo pipefail

HAL="/Library/Audio/Plug-Ins/HAL"
DRIVER="$HAL/BlackHole16ch.driver"

echo "═══ Remove BlackHole 16ch ═══"

if [[ -d "$DRIVER" ]]; then
  echo "→ Removing $DRIVER (sudo)…"
  sudo rm -rf "$DRIVER"
  echo "✓ Driver removed"
else
  echo "✓ BlackHole16ch.driver not present"
fi

if brew list --cask blackhole-16ch &>/dev/null; then
  echo "→ Uninstalling Homebrew cask blackhole-16ch…"
  brew uninstall --cask blackhole-16ch || true
  echo "✓ Cask removed"
else
  echo "✓ blackhole-16ch cask not installed"
fi

echo "→ Restarting CoreAudio…"
sudo killall coreaudiod 2>/dev/null || true
sleep 2

if system_profiler SPAudioDataType 2>/dev/null | grep -q 'BlackHole 16ch'; then
  echo "⚠ BlackHole 16ch still listed — reboot may be required"
  exit 1
fi

echo "✓ BlackHole 16ch removed. Use BlackHole 2ch for Karol → Live."
echo "  Default output: bash $(dirname "$0")/set-default-blackhole.sh"
