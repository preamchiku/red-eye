#!/usr/bin/env bash
set -e
if [ -f "venv/bin/activate" ]; then
  source venv/bin/activate
fi
export REDEYE_LOW_VRAM=auto
python3 server.py
