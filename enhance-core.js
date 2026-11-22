import { DeepFilter } from "./vendor/deepfilter.mjs";
import { voiceChain, lufs, filt, resample } from "./dsp.js?v=131";
import { smoothMask } from "./denoise.js?v=130";

export const DF_DELAY = 1440;
export const ST = 3.01;
export const CEIL = -2;

export const PRESETS = {
  light: { floorDb: -26, relDb: 0.8, ratio: 1.8, deessDb: 3, eqAmt: 0.6, nrDb: 18, gateDb: 12, dereverb: 0.35 },
  medium: { floorDb: -48, relDb: 1.1, ratio: 2.1, deessDb: 5, eqAmt: 0.9, nrDb: 28, gateDb: 22, dereverb: 0.60 },
  strong: { floorDb: -72, relDb: 1.6, ratio: 2.3, deessDb: 6, eqAmt: 1.0, nrDb: 38, gateDb: 30, dereverb: 0.82 },
};

export const presetFor = (preset, strength) =>
  PRESETS[preset]
    ? preset
    : typeof strength === "number"
      ? (strength < 0.5 ? "light" : strength < 0.9 ? "medium" : "strong")
      : "medium";

export function floorDb(samples, sr = 48000) {
  const win = Math.round(0.05 * sr);
  const count = Math.floor(samples.length / win);
  if (!count) return -120;
  const vals = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let j = i * win; j < (i + 1) * win; j++) sum += samples[j] * samples[j];
    vals[i] = 10 * Math.log10(sum / win + 1e-12);
  }
  vals.sort();
  return Math.max(-90, vals[Math.floor(0.1 * count)]);
}

// Built-in spectral noise gate fallback when WASM voice AI cannot be loaded
function spectralClean(input, nrDb = 20, onProgress = () => {}) {
  const N = 1024;
  const HOP = 256;
  const len = input.length;
  if (len < 2 * N) return Float32Array.from(input);

  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));

  const frames = Math.floor((len - N) / HOP) + 1;
  const bins = N / 2 + 1;
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const mags = new Array(frames);
  const specs = new Array(frames);
  const frameEnergy = new Float32Array(frames);

  const fft = (ar, ai, inv) => {
    const n = ar.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let tmp = ar[i]; ar[i] = ar[j]; ar[j] = tmp;
        tmp = ai[i]; ai[i] = ai[j]; ai[j] = tmp;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const ang = ((inv ? 2 : -2) * Math.PI) / size;
      const wRe = Math.cos(ang);
      const wIm = Math.sin(ang);
      for (let i = 0; i < n; i += size) {
        let curRe = 1;
        let curIm = 0;
        for (let k = 0; k < size / 2; k++) {
          const uRe = ar[i + k];
          const uIm = ai[i + k];
          const vRe = ar[i + k + size / 2] * curRe - ai[i + k + size / 2] * curIm;
          const vIm = ar[i + k + size / 2] * curIm + ai[i + k + size / 2] * curRe;
          ar[i + k] = uRe + vRe;
          ai[i + k] = uIm + vIm;
          ar[i + k + size / 2] = uRe - vRe;
          ai[i + k + size / 2] = uIm - vIm;
          const nextRe = curRe * wRe - curIm * wIm;
          curIm = curRe * wIm + curIm * wRe;
          curRe = nextRe;
        }
      }
    }
  };

  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) {
      re[i] = input[f * HOP + i] * win[i];
      im[i] = 0;
    }
    fft(re, im, false);
    const mag = new Float32Array(bins);
    let sum = 0;
    for (let b = 0; b < bins; b++) {
      const m = Math.hypot(re[b], im[b]);
      mag[b] = m;
      sum += m;
    }
    mags[f] = mag;
    specs[f] = [re.slice(0, bins), im.slice(0, bins)];
    frameEnergy[f] = sum;
  }

  const quietIdx = [...frameEnergy.keys()]
    .sort((a, b) => frameEnergy[a] - frameEnergy[b])
    .slice(0, Math.max(3, Math.floor(0.1 * frames)));

  const noise = new Float32Array(bins);
  for (const idx of quietIdx) {
    for (let b = 0; b < bins; b++) noise[b] += mags[idx][b] / quietIdx.length;
  }

  const floorGain = Math.pow(10, -nrDb / 20);
  const out = new Float32Array(len + N);
  const norm = new Float32Array(len + N);
  const prevGain = new Float32Array(bins).fill(1);

  for (let f = 0; f < frames; f++) {
    const [sr, si] = specs[f];
    const mag = mags[f];
    for (let b = 0; b < bins; b++) {
      let g = 1 - (1.6 * noise[b]) / Math.max(1e-9, mag[b]);
      g = Math.max(floorGain, Math.min(1, g));
      g = 0.65 * prevGain[b] + 0.35 * g;
      prevGain[b] = g;
      re[b] = sr[b] * g;
      im[b] = si[b] * g;
      if (b > 0 && b < N / 2) {
        re[N - b] = re[b];
        im[N - b] = -im[b];
      }
    }
    fft(re, im, true);
    for (let i = 0; i < N; i++) {
      out[f * HOP + i] += (re[i] / N) * win[i];
      norm[f * HOP + i] += win[i] * win[i];
    }
    if (f % 400 === 0) onProgress(0.8 * (f / frames));
  }

  const clean = new Float32Array(len);
  for (let i = 0; i < len; i++) clean[i] = norm[i] > 0.001 ? out[i] / norm[i] : input[i];
  return clean;
}

let hfModPromise = null;
async function createHfDeepFilter(jsText, wasmBytes, modelBytes) {
  if (!hfModPromise) {
    hfModPromise = (async () => {
      const blobUrl = URL.createObjectURL(new Blob([jsText], { type: "text/javascript" }));
      try {
        const mod = await import(blobUrl);
        const initFn = mod.default || mod.__wbg_init;
        if (typeof initFn === "function") {
          try {
            await initFn({ module_or_path: wasmBytes });
          } catch {
            await initFn(wasmBytes);
          }
        }
        return mod;
      } finally {
        setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
      }
    })();
  }
  const mod = await hfModPromise;
  const modelArr = modelBytes instanceof Uint8Array ? modelBytes : new Uint8Array(modelBytes);
  const handle = mod.df_create(modelArr, 100);
  const frameLength = mod.df_get_frame_length(handle);
  return {
    frameLength,
    process: (frame) => mod.df_process_frame(handle, frame),
    destroy: () => mod.df_free(handle),
  };
}



// STFT late-reverberation suppressor: strips showroom/room echo tails during speech

function _radix2Fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cRe = 1, cIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j], uIm = im[i + j];
        const vRe = re[i + j + len / 2] * cRe - im[i + j + len / 2] * cIm;
        const vIm = re[i + j + len / 2] * cIm + im[i + j + len / 2] * cRe;
        re[i + j] = uRe + vRe; im[i + j] = uIm + vIm;
        re[i + j + len / 2] = uRe - vRe; im[i + j + len / 2] = uIm - vIm;
        const nRe = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe;
        cRe = nRe;
      }
    }
  }
}

function spectralDereverb(input, amount = 0.75) {
  const N = 1024;
  const HOP = 256;
  const len = input.length;
  if (amount <= 0.01 || len < 4 * N) return input;

  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));

  const frames = Math.floor((len - N) / HOP) + 1;
  const bins = N / 2 + 1;
  // Delay ~42ms (8 frames @ 5.33ms/frame) separates direct voice from early/late room reflections
  const DELAY = 8;
  const ring = new Array(DELAY);
  for (let d = 0; d < DELAY; d++) ring[d] = new Float32Array(bins);
  const revEst = new Float32Array(bins);
  const prevG = new Float32Array(bins).fill(1);

  const out = new Float32Array(len);
  const norm = new Float32Array(len);
  const re = new Float32Array(N);
  const im = new Float32Array(N);

  const decay = 0.86; // ~35ms-220ms room decay tracking
  const alpha = 0.95 * amount;
  const minGain = Math.max(0.08, 1 - 0.90 * amount);

  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < N; i++) {
      re[i] = input[off + i] * win[i];
      im[i] = 0;
    }
    _radix2Fft(re, im, false);

    const delayed = ring[f % DELAY];
    for (let b = 0; b < bins; b++) {
      const mag = Math.hypot(re[b], im[b]) + 1e-9;
      // Update late-reverb envelope from delayed speech energy (room reflections arrive 40-250ms late)
      revEst[b] = decay * revEst[b] + (1 - decay) * delayed[b];
      delayed[b] = mag;

      // Emphasize echo suppression in the 250 Hz - 4.5 kHz room-reverb band
      const freq = (b * 48000) / N;
      const bandWeight = (freq >= 200 && freq <= 5000) ? 1.0 : 0.65;
      const rawG = Math.max(minGain, 1 - (alpha * bandWeight * revEst[b]) / (mag + 1e-9));
      // Fast attack on direct speech transients, smooth release on tails
      const g = rawG > prevG[b] ? 0.35 * prevG[b] + 0.65 * rawG : 0.72 * prevG[b] + 0.28 * rawG;
      prevG[b] = g;

      re[b] *= g;
      im[b] *= g;
      if (b > 0 && b < N / 2) {
        re[N - b] = re[b];
        im[N - b] = -im[b];
      }
    }

    _radix2Fft(re, im, true);
    for (let i = 0; i < N; i++) {
      out[off + i] += (re[i] / N) * win[i];
      norm[off + i] += win[i] * win[i];
    }
  }

  const clean = new Float32Array(len);
  for (let i = 0; i < len; i++) clean[i] = norm[i] > 0.001 ? out[i] / norm[i] : input[i];
  return clean;
}

// Smooth adaptive noise gate to silence residual room/fan hiss during speech pauses
function applyNoiseGate(samples, sr = 48000, maxAttenDb = 24) {
  const n = samples.length;
  if (n < 2048 || maxAttenDb <= 0) return samples;
  const win = Math.max(1, Math.floor(sr * 0.02));
  const frames = Math.floor(n / win);
  if (frames < 5) return samples;
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    const off = f * win;
    for (let i = 0; i < win; i++) s += samples[off + i] * samples[off + i];
    rms[f] = Math.sqrt(s / win) + 1e-9;
  }
  const sorted = Float32Array.from(rms).sort();
  const noiseFloor = sorted[Math.floor(frames * 0.15)];
  const speechRef = sorted[Math.floor(frames * 0.85)];
  if (speechRef <= noiseFloor * 1.6) return samples;
  const openThresh = Math.min(speechRef * 0.22, noiseFloor * 2.6);
  const closeThresh = noiseFloor * 1.45;
  const minGain = Math.pow(10, -maxAttenDb / 20);
  const out = new Float32Array(n);
  const atk = Math.exp(-1 / (sr * 0.008));
  const rel = Math.exp(-1 / (sr * 0.11));
  let env = 0;
  let g = 1;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(samples[i]);
    env = a > env ? atk * env + (1 - atk) * a : rel * env + (1 - rel) * a;
    let target;
    if (env >= openThresh) target = 1;
    else if (env <= closeThresh) target = minGain;
    else target = minGain + (1 - minGain) * ((env - closeThresh) / Math.max(1e-9, openThresh - closeThresh));
    g = target > g ? 0.92 * g + 0.08 * target : 0.996 * g + 0.004 * target;
    out[i] = samples[i] * g;
  }
  return out;
}

export async function enhance(audio, strength, enginePayload, onProgress = () => {}, opts = {}) {
  if (opts.sr && opts.sr !== 48000) {
    onProgress({ type: "stage", msg: "Preparing the sound…" });
    audio = resample(audio, opts.sr, 48000);
  }

  const presetName = presetFor(opts.preset, strength);
  const cfg = { ...PRESETS[presetName], ...opts };
  const len = audio.length;
  const lufsBefore = lufs(audio);
  const floorBefore = floorDb(audio);
  const hp = filt(filt(audio, "hp", 80, 0.707), "hp", 80, 0.707);
  const gain = lufsBefore > -69 ? Math.pow(10, Math.max(-20, Math.min(30, -25 - lufsBefore)) / 20) : 1;

  let denoised;
  let usedAi = false;

  const isLegacyBuffer = enginePayload instanceof ArrayBuffer || ArrayBuffer.isView(enginePayload);
  const mode = isLegacyBuffer ? "bundle" : (enginePayload && enginePayload.mode) || "dsp";

  if (mode === "bundle" || mode === "hf") {
    try {
      const df = mode === "bundle"
        ? await DeepFilter.create({
            wasmBytes: isLegacyBuffer ? enginePayload : enginePayload.wasmBytes,
            attenuationLimit: 100,
          })
        : await createHfDeepFilter(enginePayload.jsText, enginePayload.wasmBytes, enginePayload.modelBytes);

      const frameLen = df.frameLength;
      const padded = new Float32Array(len + DF_DELAY + 2 * frameLen);
      for (let i = 0; i < len; i++) padded[i] = hp[i] * gain;

      const processed = new Float32Array(padded.length);
      const numFrames = Math.floor(padded.length / frameLen);
      for (let i = 0; i < numFrames; i++) {
        processed.set(df.process(padded.subarray(i * frameLen, i * frameLen + frameLen)), i * frameLen);
        if (i % 400 === 0) onProgress({ type: "progress", p: (0.8 * i) / numFrames });
      }
      df.destroy();

      denoised = processed.subarray(DF_DELAY, DF_DELAY + len);
      for (let i = 0; i < len; i++) denoised[i] /= gain;
      usedAi = true;
    } catch (err) {
      console.warn("DeepFilter AI failed, falling back to built-in spectral cleaner:", err);
      onProgress({ type: "stage", msg: "Voice AI unavailable — using built-in noise cleaner…" });
    }
  }

  if (!usedAi) {
    denoised = spectralClean(hp, cfg.nrDb || 20, (p) => onProgress({ type: "progress", p }));
  }

  onProgress({ type: "stage", msg: "Smoothing out the noise…" });
  const smoothed = smoothMask(hp, denoised, cfg, (p) => onProgress({ type: "progress", p: 0.8 + 0.15 * p }));
  onProgress({ type: "stage", msg: "Removing room echo…" });
  const dereverbed = spectralDereverb(smoothed, cfg.dereverb ?? 0.6);

  onProgress({ type: "stage", msg: "Making the voice clear and loud…" });
  const { out, stats } = voiceChain(dereverbed, {
    target: -14 - ST,
    ceil: CEIL,
    hp: false,
    ratio: cfg.ratio,
    deessDb: cfg.deessDb,
    eqAmt: cfg.eqAmt,
  });

  const gatedOut = applyNoiseGate(out, 48000, cfg.gateDb ?? 22);
  const floorAfterAbs = floorDb(gatedOut);
  const floorAfter = floorAfterAbs - (stats.lufs - lufsBefore);

  return {
    out: gatedOut,
    stats: {
      ...stats,
      lufs: stats.lufs + ST,
      lufsBefore: lufsBefore + ST,
      floorBefore,
      floorAfter,
      floorAfterAbs,
      strength,
      preset: presetName,
      floorDb: cfg.floorDb,
      engine: usedAi ? "deepfilter" : "dsp",
    },
  };
}
