#!/usr/bin/env python3
"""Apply Cher — Believe Autotuna preset."""

import os
import runpy
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.argv = [sys.argv[0], "believe", *sys.argv[1:]]
runpy.run_path(os.path.join(os.path.dirname(__file__), "karol-autotuna-preset.py"), run_name="__main__")
