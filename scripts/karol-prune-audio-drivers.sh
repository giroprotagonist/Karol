#!/usr/bin/env bash
# Prune heavy/unused Core Audio devices for low-latency Karol shows.
# KEEP: UMC404HD, BlackHole 2ch, Karol Live Mic (aggregate)
# REMOVE: BlackHole 16ch, Iriun Webcam Audio (+ app / HAL driver)
set -euo pipefail

HAL="/Library/Audio/Plug-Ins/HAL"
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"

run_as_admin() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
    return
  fi
  local cmd
  cmd=$(printf '%q ' "$@")
  osascript -e "do shell script \"$cmd\" with administrator privileges"
}

echo "═══ Karol audio prune (speed / latency) ═══"
echo "  Keep: UMC404HD · BlackHole 2ch · Karol Live Mic"
echo "  Drop: BlackHole 16ch · Iriun Webcam Audio"
echo ""

/Applications/IriunWebcam.app/Contents/MacOS/IriunWebcam --quit 2>/dev/null || true
osascript -e 'quit app "Iriun Webcam"' 2>/dev/null || true
pkill -if 'IriunWebcam' 2>/dev/null || true
sleep 1

run_as_admin /bin/bash -c "
set -e
HAL='$HAL'
if [[ -d \"\$HAL/BlackHole16ch.driver\" ]]; then rm -rf \"\$HAL/BlackHole16ch.driver\"; echo REMOVED_BH16_DRIVER; else echo NO_BH16_DRIVER; fi
pkgutil --forget audio.existential.BlackHole16ch 2>/dev/null || true
if [[ -d \"\$HAL/IriunMic.driver\" ]]; then rm -rf \"\$HAL/IriunMic.driver\"; echo REMOVED_IRIUN_DRIVER; else echo NO_IRIUN_DRIVER; fi
rm -f /Library/Preferences/com.iriun.webcam.multicam
if [[ -d /Applications/IriunWebcam.app ]]; then rm -rf /Applications/IriunWebcam.app; echo REMOVED_IRIUN_APP; else echo NO_IRIUN_APP; fi
pkgutil --forget com.iriun.pkg.webcam.tmp 2>/dev/null || true
killall coreaudiod 2>/dev/null || true
sleep 2
ls \"\$HAL\"
"

if command -v brew >/dev/null 2>&1 && brew list --cask blackhole-16ch &>/dev/null; then
  echo "→ brew uninstall --cask blackhole-16ch…"
  brew uninstall --cask blackhole-16ch || true
fi

echo ""
echo "═══ Verify ═══"
KEEP_OK=1
DROP_GONE=1

if system_profiler SPAudioDataType 2>/dev/null | grep -q 'BlackHole 2ch'; then
  echo "✓ BlackHole 2ch present"
else
  echo "✗ BlackHole 2ch MISSING — reinstall: brew install --cask blackhole-2ch"
  KEEP_OK=0
fi

if system_profiler SPAudioDataType 2>/dev/null | grep -q 'Karol Live Mic'; then
  echo "✓ Karol Live Mic present"
else
  echo "⚠ Karol Live Mic missing — recreate via karol-create-live-umc-aggregate / mic aggregate"
fi

if system_profiler SPAudioDataType 2>/dev/null | grep -q 'BlackHole 16ch'; then
  echo "✗ BlackHole 16ch still listed — reboot required"
  DROP_GONE=0
else
  echo "✓ BlackHole 16ch gone"
fi

if system_profiler SPAudioDataType 2>/dev/null | grep -qi 'Iriun'; then
  echo "✗ Iriun audio still listed — reboot"
  DROP_GONE=0
else
  echo "✓ Iriun Webcam Audio gone"
fi

if systemextensionsctl list 2>/dev/null | grep -i iriun | grep -qi activated; then
  echo "⚠ Iriun *camera* system extension still activated — disable in:"
  echo "    System Settings → General → Login Items & Extensions → Camera Extensions"
fi

if command -v SwitchAudioSource >/dev/null 2>&1; then
  echo ""
  echo "Defaults: out=$(SwitchAudioSource -c 2>/dev/null)  in=$(SwitchAudioSource -t input -c 2>/dev/null)"
fi

if [[ "$DROP_GONE" -eq 1 && "$KEEP_OK" -eq 1 ]]; then
  echo ""
  echo "✓ Prune complete."
  exit 0
fi
exit 1
