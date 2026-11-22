# RED EYE — Python GPU Backend (4 GB VRAM / 8–16 GB RAM Ready)

Runs **WhisperX** (word-level subtitles) and **Resemble Enhance** (studio voice cleanup) locally or on a GPU server, tuned for **4 GB VRAM GPUs** (RTX 3050, GTX 1650/1660, RTX 2060/3060, etc.) and **8–16 GB system RAM**.

## Low-VRAM optimizations built in
- **Single-model lock**: Never keeps WhisperX and Resemble Enhance in VRAM at the same time.
- **`int8_float16` + `batch_size=4`** on <= 6.5 GB GPUs (~1–2.2 GB peak VRAM).
- **Unloads Whisper before alignment**, then clears CUDA cache after every job.
- **20-second chunked enhancement** with smooth crossfade + `nfe=32` on 4 GB GPUs, with automatic `denoise`-only fallback if VRAM spikes.

## Quick setup (Windows / Linux)
1. Install Python 3.10 or 3.11 and FFmpeg.
2. Create and activate a virtual environment:
   ```bash
   python -m venv venv
   # Windows:
   venv\Scripts\activate
   # Linux/Mac:
   source venv/bin/activate
   ```
3. Install CUDA PyTorch (for RTX 30-series / CUDA 12.1):
   ```bash
   pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
   ```
4. Install backend dependencies:
   ```bash
   pip install -r requirements.txt
   ```
5. Start the server:
   ```bash
   python server.py
   ```
6. Open RED EYE -> **Subtitles** -> **GPU Server (Optional)**, enter `http://127.0.0.1:8000`, click **Test**, and tick **Use Python GPU backend**.

> **HTTPS note:** If your RED EYE site is hosted on `https://`, browsers allow `http://127.0.0.1:8000` on your own PC, or put `server.py` behind HTTPS (Caddy/Nginx/Cloudflare Tunnel) for remote users.
