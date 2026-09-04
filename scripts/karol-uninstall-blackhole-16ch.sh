#!/usr/bin/env bash
# Deprecated wrapper — use karol-prune-audio-drivers.sh (also removes Iriun).
exec "$(cd "$(dirname "$0")" && pwd)/karol-prune-audio-drivers.sh" "$@"
