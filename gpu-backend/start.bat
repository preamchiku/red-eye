@echo off
title RED EYE GPU Backend (4 GB VRAM Mode)
if exist venv\Scripts\activate.bat call venv\Scripts\activate.bat
set REDEYE_LOW_VRAM=auto
python server.py
pause
