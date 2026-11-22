import { enhance } from "./enhance-core.js?v=132";

let cachedEngine = null;

async function readWithProgress(res, expectedTotal, baseLoaded, grandTotal) {
  if (!res.body || !res.body.getReader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    postMessage({
      type: "load",
      p: Math.min(1, (baseLoaded + buf.length) / grandTotal),
      loaded: baseLoaded + buf.length,
      total: grandTotal,
    });
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    postMessage({
      type: "load",
      p: Math.min(1, (baseLoaded + loaded) / grandTotal),
      loaded: baseLoaded + loaded,
      total: grandTotal,
    });
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function maybeGunzip(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    postMessage({ type: "stage", msg: "Preparing voice AI…" });
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return bytes;
}

async function loadVoiceEngine() {
  if (cachedEngine) return cachedEngine;

  // Tier 1: Local self-hosted WASM or original npm CDN bundle (matches vendor/deepfilter.mjs)
  const bundleUrls = [
    "./vendor/df_bg.wasm",
    "https://cdn.jsdelivr.net/npm/@lofcz/deepfilternet-web@0.1.0/dist/df_bg.wasm",
    "https://unpkg.com/@lofcz/deepfilternet-web@0.1.0/dist/df_bg.wasm",
  ];
  for (const url of bundleUrls) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const ct = (res.headers.get("content-type") || "").toLowerCase();
        if (ct.includes("text/html")) continue;
        const expected = parseInt(res.headers.get("content-length") || "34135648", 10) || 34135648;
        let bytes = await readWithProgress(res, expected, 0, expected);
        bytes = await maybeGunzip(bytes);
        // Verify WASM magic header (\0asm)
        if (bytes.length > 4 && bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d) {
          cachedEngine = { mode: "bundle", wasmBytes: bytes.buffer };
          return cachedEngine;
        }
      }
    } catch {}
  }

  // Tier 2: Verified CORS-enabled DeepFilterNet3 WASM + model bundle on Hugging Face
  const HF_BASE = "https://huggingface.co/Faridzar/dfn3-wasm-mirror/resolve/main/";
  try {
    const jsRes = await fetch(HF_BASE + "df.js");
    if (jsRes.ok) {
      const jsText = await jsRes.text();
      const wasmRes = await fetch(HF_BASE + "df_bg.wasm");
      const modelRes = await fetch(HF_BASE + "deepfilter3_model.tar.gz");
      if (wasmRes.ok && modelRes.ok) {
        const wasmSize = parseInt(wasmRes.headers.get("content-length") || "8966660", 10) || 8966660;
        const modelSize = parseInt(modelRes.headers.get("content-length") || "7983136", 10) || 7983136;
        const grandTotal = wasmSize + modelSize;
        const wasmBytes = await readWithProgress(wasmRes, wasmSize, 0, grandTotal);
        const modelBytes = await readWithProgress(modelRes, modelSize, wasmBytes.length, grandTotal);
        if (wasmBytes.length > 4 && wasmBytes[0] === 0x00 && wasmBytes[1] === 0x61 && wasmBytes[2] === 0x73 && wasmBytes[3] === 0x6d) {
          cachedEngine = { mode: "hf", jsText, wasmBytes: wasmBytes.buffer, modelBytes };
          return cachedEngine;
        }
      }
    }
  } catch {}

  // Tier 3: Built-in local DSP spectral cleaner + voice chain (never fails offline)
  postMessage({ type: "stage", msg: "Voice AI offline — using built-in noise cleaner…" });
  cachedEngine = { mode: "dsp" };
  return cachedEngine;
}

self.onmessage = async (ev) => {
  const { audio, strength, preset, sr } = ev.data;
  try {
    const engine = await loadVoiceEngine();
    postMessage({ type: "stage", msg: engine.mode === "dsp" ? "Cleaning voice (built-in DSP)…" : "Starting voice AI…" });
    const { out, stats } = await enhance(audio, strength, engine, (msg) => postMessage(msg), { preset, sr });
    postMessage({ type: "done", out, stats }, [out.buffer]);
  } catch (err) {
    postMessage({ type: "error", msg: String((err && err.message) || err) });
  }
};
