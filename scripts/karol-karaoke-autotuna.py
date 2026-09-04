#!/usr/bin/env python3
"""Apply general Karol Karaoke Autotuna (chromatic, any key) — wrapper."""
import os
import runpy
import sys

sys.argv = [sys.argv[0], "karaoke", *sys.argv[1:]]
runpy.run_path(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "karol-autotuna-preset.py"),
    run_name="__main__",
)
