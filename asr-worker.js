import { pipeline as createPipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js";

env.allowLocalModels = false;
env.useBrowserCache = true;

let cachedPipe = null;
let cachedKey = "";
const KN_MODEL = "kn-model";
const KN_FALLBACK_MODEL = "onnx-community/whisper-small_timestamped";
const PIECE_EXT = ".piece";

// Fix: env.fetch defaults to undefined in Transformers.js v4; always fall back to globalThis.fetch
const baseFetch = typeof env.fetch === "function"
  ? env.fetch.bind(env)
  : globalThis.fetch.bind(globalThis);

async function disposeCachedPipe() {
  if (cachedPipe) {
    try {
      if (typeof cachedPipe.dispose === "function") await cachedPipe.dispose();
    } catch {}
    cachedPipe = null;
    cachedKey = "";
  }
}

function isOomError(err) {
  const msg = String((err && err.message) || err || "");
  return /bad_alloc|out of memory|oom|memory access out of bounds|cannot allocate|allocation failed|OrtRun/i.test(msg);
}

function smallerFallbackModel(modelId) {
  if (/large/i.test(modelId) || modelId === KN_MODEL) {
    return "onnx-community/whisper-small_timestamped";
  }
  if (/small/i.test(modelId)) {
    return modelId.includes(".en")
      ? "onnx-community/whisper-base.en_timestamped"
      : "onnx-community/whisper-base_timestamped";
  }
  if (/base/i.test(modelId)) {
    return modelId.includes(".en")
      ? "onnx-community/whisper-tiny.en_timestamped"
      : "onnx-community/whisper-tiny_timestamped";
  }
  return null;
}

async function fetchKnPieceFile(url, init) {
  const range = init && init.headers ? new Headers(init.headers).get("Range") : null;
  const pad = (idx) => String(idx).padStart(3, "0");
  const head0 = await fetch(url + PIECE_EXT + "000", { method: "HEAD" });
  if (!head0.ok) return baseFetch(url, init);

  const sizes = [];
  for (let start = 0; ; start += 16) {
    const batch = await Promise.all(
      Array.from({ length: 16 }, (_, j) =>
        fetch(url + PIECE_EXT + pad(start + j), { method: "HEAD" }).then(
          (res) => (res.ok ? parseInt(res.headers.get("content-length") || "0", 10) : -1),
          () => -1
        )
      )
    );
    const stopIdx = batch.indexOf(-1);
    sizes.push(...(stopIdx < 0 ? batch : batch.slice(0, stopIdx)));
    if (stopIdx >= 0) break;
  }

  const totalSize = sizes.reduce((sum, v) => sum + v, 0);
  if (range && range.startsWith("bytes=0-0")) {
    return new Response(new Uint8Array(1), {
      status: 206,
      headers: {
        "Content-Range": "bytes 0-0/" + totalSize,
        "Content-Type": "application/octet-stream",
      },
    });
  }

  const blobs = new Array(sizes.length);
  for (let start = 0; start < sizes.length; start += 8) {
    const chunk = await Promise.all(
      Array.from({ length: Math.min(8, sizes.length - start) }, (_, j) =>
        fetch(url + PIECE_EXT + pad(start + j)).then((res) => {
          if (!res.ok) {
            throw new Error("Kannada speech model piece " + (start + j) + " did not load (" + res.status + ")");
          }
          return res.blob();
        })
      )
    );
    chunk.forEach((b, j) => {
      blobs[start + j] = b;
    });
  }

  return new Response(new Blob(blobs), {
    status: 200,
    headers: {
      "Content-Length": String(totalSize),
      "Content-Type": "application/octet-stream",
    },
  });
}

env.fetch = (input, init) => {
  const url = typeof input === "string" ? input : (input && input.url) || String(input);
  if (url.includes("/" + KN_MODEL + "/")) {
    return fetchKnPieceFile(url, init);
  }
  return baseFetch(input, init);
};

async function loadModel(modelId, device, lowMem = false) {
  const key = modelId + "|" + device + "|" + (lowMem ? "1" : "0");
  if (cachedPipe && cachedKey === key) return cachedPipe;

  // Always release previous model weights before loading another to prevent std::bad_alloc OOM
  await disposeCachedPipe();

  env.remoteHost = modelId === KN_MODEL
    ? "https://redeye-download.sites.tab.bot/"
    : "https://huggingface.co/";

  const isLarge = /large/i.test(modelId);

  // Limit WASM threads on large models or low-memory mode to avoid 32-bit WASM heap exhaustion
  try {
    if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
      env.backends.onnx.wasm.numThreads = (isLarge || lowMem) ? 1 : Math.min(4, navigator.hardwareConcurrency || 2);
    }
  } catch {}

  let dtype;
  if (device === "webgpu") {
    if (isLarge) {
      // Never load 2.55 GB fp32 encoder for large-v3-turbo in browser; use q4/fp16
      let hasF16 = false;
      try {
        const adapter = await navigator.gpu.requestAdapter();
        hasF16 = !!adapter && adapter.features.has("shader-f16");
      } catch {}
      dtype = { encoder_model: hasF16 ? "fp16" : "q8", decoder_model_merged: "q4" };
    } else {
      // For tiny/base/small, fp32 encoder fits comfortably in VRAM and avoids v4 fp16 precision bugs
      dtype = { encoder_model: "fp32", decoder_model_merged: "q4" };
    }
  } else {
    dtype = isLarge
      ? { encoder_model: "q8", decoder_model_merged: "q4" }
      : { encoder_model: "q8", decoder_model_merged: "q8" };
  }

  const progressByFile = {};
  cachedPipe = await createPipeline("automatic-speech-recognition", modelId, {
    device,
    dtype,
    progress_callback: (ev) => {
      if (ev.status === "progress" && ev.file) {
        progressByFile[ev.file] = [ev.loaded || 0, ev.total || 0];
        let loaded = 0;
        let total = 0;
        for (const f in progressByFile) {
          loaded += progressByFile[f][0];
          total += progressByFile[f][1];
        }
        postMessage({ type: "load", loaded, total });
      }
    },
  });
  cachedKey = key;
  return cachedPipe;
}

const HOP = 160;
const FPS = 100;

const speechRatio = (vad, s, e) => {
  let sum = 0;
  for (let i = Math.max(0, s); i < Math.min(vad.n, e); i++) sum += vad.sp[i];
  return sum / FPS;
};

function findSilence(vad, start, end, minFrames) {
  let run = 0;
  for (let i = Math.max(0, start); i < Math.min(vad.n, end); i++) {
    if (vad.sp[i]) run = 0;
    else if (++run >= minFrames) return i - run + 1;
  }
  return -1;
}

function bestSplit(vad, minF, maxF) {
  let bestPos = -1;
  let bestLen = 0;
  let curLen = 0;
  for (let i = minF; i < Math.min(vad.n, maxF); i++) {
    if (vad.sp[i]) {
      curLen = 0;
    } else {
      curLen++;
      if (curLen >= bestLen) {
        bestLen = curLen;
        bestPos = i - (curLen >> 1);
      }
    }
  }
  return bestPos > 0 && bestLen >= 3 ? bestPos : maxF;
}

function isHallucination(words) {
  let streak = 1;
  for (let i = 1; i < words.length; i++) {
    if (words[i].t.toLowerCase() === words[i - 1].t.toLowerCase()) {
      if (++streak >= 4) return true;
    } else {
      streak = 1;
    }
  }
  return words.length >= 12 && new Set(words.map((w) => w.t.toLowerCase())).size / words.length < 0.3;
}

function dedupeWords(words) {
  const out = [];
  for (const w of words) {
    const prev1 = out[out.length - 1];
    const prev2 = out[out.length - 2];
    if (prev1 && prev2 && prev1.t === w.t && prev2.t === w.t) {
      prev1.e = Math.max(prev1.e, w.e);
    } else {
      out.push(w);
    }
  }
  return out;
}

function computeVad(audio) {
  const n = Math.floor(audio.length / HOP);
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const base = i * HOP;
    for (let j = 0; j < 400 && base + j < audio.length; j++) {
      sum += audio[base + j] * audio[base + j];
    }
    db[i] = 10 * Math.log10(sum / 400 + 1e-12);
  }
  const sorted = Float32Array.from(db).sort();
  const thr = Math.max(sorted[Math.floor(0.97 * n)] - 32, sorted[Math.floor(0.1 * n)] + 4, -62);
  const sp = new Uint8Array(n);
  for (let i = 0; i < n; i++) sp[i] = db[i] > thr ? 1 : 0;
  return { sp, n };
}

async function runTranscription(audio, activeModel, activeDevice, language, translate, quick, prefetch, lowMem) {
  let pipe;
  const tryLoad = async (m, d) => {
    try {
      return { pipe: await loadModel(m, d, lowMem), device: d };
    } catch (err) {
      if (d === "wasm") throw err;
      postMessage({ type: "info", msg: "GPU not available, using CPU (slower)" });
      return { pipe: await loadModel(m, "wasm", lowMem), device: "wasm" };
    }
  };

  try {
    const res = await tryLoad(activeModel, activeDevice);
    pipe = res.pipe;
    activeDevice = res.device;
  } catch (err) {
    if (activeModel === KN_MODEL) {
      postMessage({ type: "info", msg: "Kannada server unreachable, switching to multilingual Whisper…" });
      activeModel = KN_FALLBACK_MODEL;
      const res = await tryLoad(activeModel, activeDevice);
      pipe = res.pipe;
      activeDevice = res.device;
    } else {
      throw err;
    }
  }

  postMessage({ type: "stage", stage: "transcribe", device: activeDevice });
  if (prefetch) return { type: "done", words: [], passes: 0 };

  if (quick) {
    const opts = {};
    if (!activeModel.includes(".en")) {
      opts.language = language && language !== "auto" ? language : "en";
      opts.task = "transcribe";
    }
    const res = await pipe(audio, opts);
    return { type: "quick", text: String((res && res.text) || "").trim(), device: activeDevice };
  }

  const supportsWordTs = activeModel.includes("_timestamped") || activeModel === KN_MODEL;
  const inferOpts = { return_timestamps: supportsWordTs ? "word" : true };
  if (!activeModel.includes(".en")) {
    if (language && language !== "auto") inferOpts.language = language;
    inferOpts.task = translate ? "translate" : "transcribe";
  }

  const vad = computeVad(audio);
  const totalFrames = vad.n;
  let passes = 0;

  const transcribeSlice = async (startF, endF) => {
    // Pass a copied slice so WASM doesn't hold references across chunks
    const sliceAudio = audio.slice(startF * HOP, endF * HOP);
    const res = await pipe(sliceAudio, inferOpts);
    passes++;
    const offsetSec = startF / FPS;
    const maxSec = endF / FPS;
    const out = [];

    const rawChunks = Array.isArray(res && res.chunks) && res.chunks.length
      ? res.chunks
      : (res && res.text ? [{ text: res.text, timestamp: [0, maxSec - offsetSec] }] : []);

    for (const ch of rawChunks) {
      const cleanText = (ch.text || "").trim().replace(/(\S{1,4}?)\1{3,}/gu, "$1");
      if (!cleanText) continue;
      const ts0 = (ch.timestamp && ch.timestamp[0] != null ? ch.timestamp[0] : 0) + offsetSec;
      const rawEnd = ch.timestamp ? ch.timestamp[1] : null;
      const ts1 = (rawEnd == null ? (ch.timestamp && ch.timestamp[0] != null ? ch.timestamp[0] : 0) + 0.4 : rawEnd) + offsetSec;
      if (ts0 > maxSec + 0.05) continue;

      const tokens = supportsWordTs ? [cleanText] : cleanText.split(/\s+/).filter(Boolean);
      const span = Math.max(0.05 * tokens.length, Math.min(ts1, maxSec) - ts0);
      const step = span / Math.max(1, tokens.length);

      for (let idx = 0; idx < tokens.length; idx++) {
        const wStart = ts0 + idx * step;
        const wEnd = Math.min(Math.max(ts0 + (idx + 1) * step, wStart + 0.05), maxSec);
        if (out.length && wStart < out[out.length - 1].s) continue;
        const item = { t: tokens[idx], s: wStart, e: wEnd };
        const sil = findSilence(vad, Math.round(wStart * FPS) + 8, Math.round(item.e * FPS), 25);
        if (sil >= 0) item.e = Math.max(wStart + 0.08, sil / FPS + 0.05);
        out.push(item);
      }
    }
    return out;
  };

  const findGap = (words, fromF, toF, minSec) => {
    let wi = 0;
    let gapStart = -1;
    let speechFrames = 0;
    let lastSpeech = -1;
    for (let i = fromF; i < toF; i++) {
      while (wi < words.length && Math.round(words[wi].e * FPS) + 25 < i) wi++;
      if (wi < words.length && Math.round(words[wi].s * FPS) - 25 <= i) {
        if (gapStart >= 0) {
          if (speechFrames >= minSec * FPS) return [gapStart, lastSpeech + 1];
          gapStart = -1;
        }
      } else {
        if (gapStart < 0) {
          gapStart = i;
          speechFrames = 0;
        }
        if (vad.sp[i]) {
          speechFrames++;
          lastSpeech = i;
        }
      }
    }
    return gapStart >= 0 && speechFrames >= minSec * FPS ? [gapStart, lastSpeech + 1] : null;
  };

  const allWords = [];
  const appendWords = (ws) => {
    for (const w of ws) {
      const last = allWords[allWords.length - 1];
      if (!last || w.s > last.s + 0.02) allWords.push(w);
    }
  };

  let cur = 0;
  while (cur < totalFrames && !vad.sp[cur]) cur++;
  cur = Math.max(0, cur - 20);

  // Use shorter slices on large models / low-memory mode to reduce peak ONNX activation RAM
  const isLarge = /large/i.test(activeModel);
  const maxWinSec = (activeModel === KN_MODEL || isLarge || lowMem) ? 16 : 26;
  const minWinSec = (activeModel === KN_MODEL || isLarge || lowMem) ? 7 : 13;

  while (cur < totalFrames - 10) {
    const isKn = activeModel === KN_MODEL;
    let end = cur + maxWinSec * FPS >= totalFrames
      ? totalFrames
      : bestSplit(vad, cur + minWinSec * FPS, cur + maxWinSec * FPS);
    if (speechRatio(vad, cur, end) < 0.2) {
      cur = end;
      continue;
    }

    let sliceWords = await transcribeSlice(cur, end);
    if (isHallucination(sliceWords) && end - cur > 800) {
      end = bestSplit(vad, cur + 400, cur + Math.round((end - cur) / 2));
      sliceWords = await transcribeSlice(cur, end);
    }
    if (isHallucination(sliceWords)) sliceWords = dedupeWords(sliceWords);

    if (sliceWords.length) {
      const leadGap = findGap(sliceWords, cur, Math.round(sliceWords[0].s * FPS), isKn ? 0.4 : 0.8);
      if (leadGap) {
        const fill = await transcribeSlice(Math.max(cur, leadGap[0] - 15), Math.min(end, leadGap[1] + 15));
        sliceWords = fill.filter((w) => w.e <= sliceWords[0].s + 0.05).concat(sliceWords);
      }
    }

    let nextCur = end;
    const tailGap = findGap(sliceWords, sliceWords.length ? Math.round(sliceWords[0].s * FPS) : cur, end, isKn ? 0.3 : 0.5);
    if (tailGap) {
      const cut = tailGap[0];
      sliceWords = sliceWords.filter((w) => w.s < cut / FPS);
      nextCur = Math.max(cut, sliceWords.length ? Math.round(sliceWords[sliceWords.length - 1].e * FPS) : cut);
    }

    appendWords(sliceWords);
    if (nextCur <= cur + FPS) nextCur = Math.min(totalFrames, Math.max(end, cur + FPS));
    cur = nextCur;
    postMessage({ type: "progress", p: Math.min(1, cur / totalFrames) });
  }

  const finalWords = dedupeWords(allWords);
  for (let i = 0; i < finalWords.length - 1; i++) {
    if (finalWords[i].e > finalWords[i + 1].s) {
      finalWords[i].e = Math.max(finalWords[i].s + 0.05, finalWords[i + 1].s);
    }
  }

  return { type: "done", words: finalWords, passes };
}

self.onmessage = async (ev) => {
  const { audio, model: requestedModel, device: requestedDevice, language, translate, quick, prefetch } = ev.data;
  let currentModel = requestedModel;
  let currentDevice = requestedDevice;
  let lowMem = false;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await runTranscription(audio, currentModel, currentDevice, language, translate, quick, prefetch, lowMem);
      postMessage(result);
      return;
    } catch (err) {
      if (isOomError(err)) {
        await disposeCachedPipe();
        const nextModel = smallerFallbackModel(currentModel);
        if (nextModel && nextModel !== currentModel) {
          lowMem = true;
          currentModel = nextModel;
          currentDevice = "wasm";
          postMessage({
            type: "info",
            msg: "Selected speech model ran out of browser memory — switching to a lighter model…",
          });
          continue;
        }
      }
      postMessage({ type: "error", msg: String((err && err.message) || err) });
      return;
    }
  }
};
