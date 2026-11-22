"""
RED EYE — Lightweight Local/Server Python GPU Backend
Tuned for 8-16 GB System RAM and 4 GB VRAM GPUs (RTX 3050, GTX 1650/1660, RTX 2060/3060, etc.)
with automatic CPU fallback.

Endpoints:
  GET  /api/health      -> GPU/VRAM status & available engines
  POST /api/transcribe  -> WhisperX (int8_float16 + word-level alignment) -> RED EYE {t, s, e} words
  POST /api/enhance     -> Resemble Enhance (chunked for 4 GB VRAM) -> 48 kHz mono WAV + X-RedEye-Stats header
"""

import asyncio
import gc
import io
import json
import math
import os
import tempfile
from typing import Optional

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

# ---------------------------------------------------------------------------
# Hardware & Low-VRAM Auto-Detection
# ---------------------------------------------------------------------------
HAS_CUDA = torch.cuda.is_available()
DEVICE = "cuda" if HAS_CUDA else "cpu"
GPU_NAME = torch.cuda.get_device_name(0) if HAS_CUDA else "CPU"
VRAM_GB = round(torch.cuda.get_device_properties(0).total_memory / (1024 ** 3), 2) if HAS_CUDA else 0.0

# Enable strict single-model / low-VRAM mode automatically on <= 6.5 GB GPUs (e.g. 4 GB RTX 3050)
LOW_VRAM = os.environ.get("REDEYE_LOW_VRAM", "auto").lower()
if LOW_VRAM == "auto":
    LOW_VRAM_MODE = (not HAS_CUDA) or (VRAM_GB <= 6.5)
else:
    LOW_VRAM_MODE = LOW_VRAM in ("1", "true", "yes")

API_KEY = os.environ.get("REDEYE_API_KEY", "").strip()
ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get("REDEYE_CORS_ORIGINS", "*").split(",") if o.strip()
]

# Check optional packages
try:
    import whisperx  # type: ignore
    HAS_WHISPERX = True
except Exception:
    whisperx = None
    HAS_WHISPERX = False

try:
    import torchaudio  # type: ignore
    from resemble_enhance.enhancer.inference import denoise as re_denoise, enhance as re_enhance  # type: ignore
    HAS_RESEMBLE = True
except Exception:
    torchaudio = None
    re_denoise = None
    re_enhance = None
    HAS_RESEMBLE = False

app = FastAPI(title="RED EYE GPU Backend", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["X-RedEye-Stats", "X-RedEye-Engine"],
)

# Serialize GPU jobs so 4 GB VRAM is never shared by two concurrent requests
GPU_LOCK = asyncio.Lock()

# Cache at most ONE model when VRAM > 6.5 GB; on 4 GB GPUs unload after every job
_cached_asr = {"key": None, "model": None}


def _check_auth(x_api_key: Optional[str]):
    if API_KEY and (x_api_key or "").strip() != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key")


def _free_gpu():
    gc.collect()
    if HAS_CUDA:
        torch.cuda.empty_cache()
        try:
            torch.cuda.ipc_collect()
        except Exception:
            pass


def _unload_asr():
    if _cached_asr["model"] is not None:
        _cached_asr["model"] = None
        _cached_asr["key"] = None
    _free_gpu()


def _select_whisper_model(quality: str) -> str:
    q = (quality or "good").lower()
    if q == "fast":
        return "base"
    if q == "good":
        return "small"
    if q == "best":
        # Medium fits in 4 GB with int8_float16; drop to small if < 3.5 GB VRAM
        return "medium" if (not HAS_CUDA or VRAM_GB >= 3.5) else "small"
    if q == "turbo":
        return "large-v3-turbo"
    return "small"


def _compute_audio_stats(x: np.ndarray, sr: int) -> tuple[float, float, float]:
    """Compute approximate noise floor (dB), integrated loudness (LUFS approx), and peak (dBTP)."""
    if x.size == 0:
        return -60.0, -24.0, -60.0
    x = x.astype(np.float32, copy=False)
    peak = float(np.max(np.abs(x))) + 1e-9
    true_peak = 20.0 * math.log10(peak)
    rms = float(np.sqrt(np.mean(x * x))) + 1e-9
    lufs = 20.0 * math.log10(rms) - 0.691
    # Frame-based 10th-percentile energy for noise floor estimate
    hop = max(1, int(sr * 0.05))
    n_frames = x.size // hop
    if n_frames >= 4:
        frames = x[: n_frames * hop].reshape(n_frames, hop)
        frame_rms = np.sqrt(np.mean(frames * frames, axis=1)) + 1e-9
        floor_db = float(20.0 * math.log10(np.percentile(frame_rms, 10)))
    else:
        floor_db = max(-70.0, lufs - 20.0)
    return round(floor_db, 1), round(lufs, 1), round(true_peak, 1)


def _resample_np(x: np.ndarray, orig_sr: int, target_sr: int) -> np.ndarray:
    if orig_sr == target_sr or x.size == 0:
        return x.astype(np.float32, copy=False)
    if torchaudio is not None:
        t = torch.from_numpy(x.astype(np.float32, copy=False)).unsqueeze(0)
        y = torchaudio.functional.resample(t, orig_sr, target_sr).squeeze(0).numpy()
        return y.astype(np.float32, copy=False)
    # Linear fallback if torchaudio is unavailable
    new_len = max(1, int(round(x.size * target_sr / orig_sr)))
    xp = np.linspace(0.0, 1.0, x.size, dtype=np.float64)
    xq = np.linspace(0.0, 1.0, new_len, dtype=np.float64)
    return np.interp(xq, xp, x).astype(np.float32)


def _segments_to_words(segments: list) -> list:
    """Convert WhisperX segments/words into RED EYE's exact [{t, s, e}] format."""
    words = []
    for seg in segments or []:
        seg_words = seg.get("words") or []
        if seg_words:
            for w in seg_words:
                txt = (w.get("word") or w.get("text") or "").strip()
                if not txt:
                    continue
                s = w.get("start")
                e = w.get("end")
                if s is None or e is None:
                    continue
                s_f = max(0.0, float(s))
                e_f = max(s_f + 0.05, float(e))
                words.append({"t": txt, "s": round(s_f, 3), "e": round(e_f, 3)})
        else:
            # Fallback if alignment wasn't available for this language
            text = (seg.get("text") or "").strip()
            toks = [tok for tok in text.split() if tok]
            if not toks:
                continue
            s0 = max(0.0, float(seg.get("start", 0.0)))
            e0 = max(s0 + 0.1 * len(toks), float(seg.get("end", s0 + 0.2 * len(toks))))
            dur = (e0 - s0) / len(toks)
            for idx, tok in enumerate(toks):
                ws = s0 + idx * dur
                we = max(ws + 0.05, ws + dur)
                words.append({"t": tok, "s": round(ws, 3), "e": round(we, 3)})
    return words


@app.get("/api/health")
async def health():
    return {
        "ok": True,
        "device": DEVICE,
        "gpu_name": GPU_NAME,
        "vram_gb": VRAM_GB,
        "low_vram": LOW_VRAM_MODE,
        "whisperx": HAS_WHISPERX,
        "resemble_enhance": HAS_RESEMBLE,
    }


@app.post("/api/transcribe")
async def api_transcribe(
    audio: UploadFile = File(...),
    language: str = Form("auto"),
    quality: str = Form("good"),
    translate: bool = Form(False),
    x_api_key: Optional[str] = Header(default=None),
):
    _check_auth(x_api_key)
    if not HAS_WHISPERX:
        raise HTTPException(status_code=503, detail="WhisperX is not installed on this server.")

    raw = await audio.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty audio upload.")

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(raw)
        tmp_path = tmp.name

    try:
        async with GPU_LOCK:
            model_name = _select_whisper_model(quality)
            compute_type = "int8_float16" if (HAS_CUDA and LOW_VRAM_MODE) else ("float16" if HAS_CUDA else "int8")
            batch_size = 4 if LOW_VRAM_MODE else 12
            lang = None if (not language or language in ("auto", "hinglish", "kanglish")) else language
            task = "translate" if translate else "transcribe"

            def _run_asr():
                audio_arr = whisperx.load_audio(tmp_path)
                cache_key = (model_name, DEVICE, compute_type)
                model = _cached_asr["model"] if _cached_asr["key"] == cache_key else None
                if model is None:
                    _unload_asr()
                    try:
                        model = whisperx.load_model(model_name, DEVICE, compute_type=compute_type)
                    except RuntimeError as err:
                        if "out of memory" in str(err).lower() and model_name != "small":
                            _free_gpu()
                            model = whisperx.load_model("small", DEVICE, compute_type="int8_float16" if HAS_CUDA else "int8")
                        else:
                            raise
                    if not LOW_VRAM_MODE:
                        _cached_asr["key"] = cache_key
                        _cached_asr["model"] = model

                result = model.transcribe(audio_arr, batch_size=batch_size, language=lang, task=task)
                detected_lang = result.get("language") or lang or "en"

                # On 4 GB GPUs, free ASR model before loading alignment model to avoid VRAM spike
                if LOW_VRAM_MODE:
                    del model
                    _free_gpu()

                segments = result.get("segments") or []
                try:
                    align_device = DEVICE
                    align_model, metadata = whisperx.load_align_model(language_code=detected_lang, device=align_device)
                    aligned = whisperx.align(segments, align_model, metadata, audio_arr, align_device, return_char_alignments=False)
                    segments = aligned.get("segments") or segments
                    del align_model
                    _free_gpu()
                except Exception:
                    # Some languages (e.g. mixed scripts) may not have a wav2vec2 aligner; use Whisper segments
                    _free_gpu()

                return detected_lang, _segments_to_words(segments), model_name

            detected_lang, words, used_model = await asyncio.to_thread(_run_asr)
            return {
                "language": detected_lang,
                "model": used_model,
                "device": DEVICE,
                "low_vram": LOW_VRAM_MODE,
                "words": words,
            }
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


def _enhance_chunked_sync(wav_np: np.ndarray, sr: int, preset: str, mode: str) -> tuple[np.ndarray, str]:
    """Run Resemble Enhance in 20s crossfaded chunks so 4 GB VRAM & 8 GB RAM stay safe."""
    _unload_asr()

    p = (preset or "strong").lower()
    m = (mode or "auto").lower()
    if m == "auto":
        use_enhancer = p in ("medium", "strong")
    elif m == "denoise":
        use_enhancer = False
    else:
        use_enhancer = True

    nfe = 32 if LOW_VRAM_MODE else 64
    lambd = 0.6 if p == "medium" else 0.9
    tau = 0.5
    chunk_sec = 20.0 if LOW_VRAM_MODE else 35.0
    overlap_sec = 0.5

    chunk_samples = int(chunk_sec * sr)
    overlap_samples = int(overlap_sec * sr)
    total = wav_np.size

    def _proc_segment(seg_np: np.ndarray, run_enhancer: bool, dev: str) -> tuple[np.ndarray, int]:
        tensor = torch.from_numpy(seg_np.astype(np.float32, copy=False))
        with torch.inference_mode():
            dwav, new_sr = re_denoise(tensor, sr, dev)
            if run_enhancer:
                dwav, new_sr = re_enhance(
                    dwav, new_sr, dev, nfe=nfe, solver="midpoint", lambd=lambd, tau=tau
                )
        out_np = dwav.detach().cpu().numpy().astype(np.float32, copy=False)
        del tensor, dwav
        _free_gpu()
        return out_np, int(new_sr)

    def _run_all(run_enhancer: bool, dev: str) -> tuple[np.ndarray, int]:
        if total <= chunk_samples:
            return _proc_segment(wav_np, run_enhancer, dev)

        out_parts = []
        out_sr = 44100
        step = max(1, chunk_samples - overlap_samples)
        pos = 0
        while pos < total:
            end = min(total, pos + chunk_samples)
            seg = wav_np[pos:end]
            proc, out_sr = _proc_segment(seg, run_enhancer, dev)
            if not out_parts:
                out_parts.append(proc)
            else:
                ov = min(int(overlap_sec * out_sr), proc.size, out_parts[-1].size)
                if ov > 0:
                    fade_out = np.linspace(1.0, 0.0, ov, dtype=np.float32)
                    fade_in = 1.0 - fade_out
                    out_parts[-1][-ov:] = out_parts[-1][-ov:] * fade_out + proc[:ov] * fade_in
                    out_parts.append(proc[ov:])
                else:
                    out_parts.append(proc)
            if end >= total:
                break
            pos += step
        return np.concatenate(out_parts), out_sr

    engine_label = f"resemble-{'enhance' if use_enhancer else 'denoise'}-{DEVICE}"
    try:
        out_wav, out_sr = _run_all(use_enhancer, DEVICE)
    except RuntimeError as err:
        if "out of memory" in str(err).lower():
            _free_gpu()
            if use_enhancer:
                # Retry denoise-only on GPU (uses < 1 GB VRAM)
                out_wav, out_sr = _run_all(False, DEVICE)
                engine_label = f"resemble-denoise-oom-fallback-{DEVICE}"
            else:
                out_wav, out_sr = _run_all(False, "cpu")
                engine_label = "resemble-denoise-cpu-fallback"
        else:
            raise

    out_48k = _resample_np(out_wav, out_sr, 48000)
    # Soft peak safety under -1 dBTP (0.891)
    peak = float(np.max(np.abs(out_48k))) if out_48k.size else 0.0
    if peak > 0.891:
        out_48k = out_48k * (0.891 / peak)
    return out_48k, engine_label


@app.post("/api/enhance")
async def api_enhance(
    audio: UploadFile = File(...),
    preset: str = Form("strong"),
    mode: str = Form("auto"),
    x_api_key: Optional[str] = Header(default=None),
):
    _check_auth(x_api_key)
    if not HAS_RESEMBLE:
        raise HTTPException(status_code=503, detail="resemble-enhance is not installed on this server.")

    raw = await audio.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty audio upload.")

    wav_np, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=False)
    if wav_np.ndim > 1:
        wav_np = wav_np.mean(axis=1)

    floor_before, lufs_before, _ = _compute_audio_stats(wav_np, sr)

    async with GPU_LOCK:
        out_48k, engine_label = await asyncio.to_thread(_enhance_chunked_sync, wav_np, sr, preset, mode)

    floor_after, lufs_after, true_peak = _compute_audio_stats(out_48k, 48000)
    stats = {
        "floorBefore": floor_before,
        "floorAfter": floor_after,
        "lufsBefore": lufs_before,
        "lufs": lufs_after,
        "truePeak": true_peak,
        "preset": preset,
        "engine": engine_label,
    }

    buf = io.BytesIO()
    sf.write(buf, out_48k, 48000, format="WAV", subtype="PCM_16")
    return Response(
        content=buf.getvalue(),
        media_type="audio/wav",
        headers={
            "X-RedEye-Stats": json.dumps(stats),
            "X-RedEye-Engine": engine_label,
        },
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    print(f"[RED EYE GPU Backend] Device={DEVICE} ({GPU_NAME}, {VRAM_GB} GB VRAM) | Low-VRAM={LOW_VRAM_MODE}")
    print(f"[RED EYE GPU Backend] WhisperX={HAS_WHISPERX} | ResembleEnhance={HAS_RESEMBLE}")
    uvicorn.run(app, host="0.0.0.0", port=port)
