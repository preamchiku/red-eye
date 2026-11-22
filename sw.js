const CACHE_NAME = "re-v87-20261121r150-read-aloud";
const CORE_ASSETS = [
  "./", "index.html", "editor.html",
  "landing.css", "landing.js", "landing-styles.js", "media/style-bg.jpg",
  "style.css", "resolve.css", "app.js", "render.js", "presets.js", "langs.js",
  "translit.js", "dsp.js", "asr-worker.js", "xform.js", "nle-core.js",
  "nle-ui.js", "nle-play.js", "nle-mix.js", "glfx.js", "colour.js", "afx.js",
  "fxlib.bin", "enhance-worker.js", "enhance-core.js", "denoise.js",
  "seg-worker.js", "fonts.json.gz", "manifest.webmanifest",
  "icons/icon-192.png?v=2", "icons/icon-512.png?v=2", "icons/maskable-512.png?v=2",
  "icons/apple-touch-icon.png", "icons/favicon-64.png", "logo.png",
  "vendor/deepfilter.mjs", "vendor/nspell.mjs", "spell.js", "sfx.js",
  "offline.js", "v9.js", "pm.js", "rz.js", "storage-guard.js",
  "titles.js", "lyrics.js", "donate.js", "vendor/qrcode.mjs"
];

const cleanResponse = async (res) =>
  res && res.redirected
    ? new Response(await res.blob(), {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      })
    : res;

self.addEventListener("install", (ev) => {
  ev.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Precache core app shell without blocking on multi-MB external CDN libraries
    await Promise.all(
      CORE_ASSETS.map(async (url) => {
        try {
          const res = await fetch(url);
          if (res.ok) await cache.put(url, await cleanResponse(res));
        } catch {}
      })
    );
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith("re-v") && k !== CACHE_NAME) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (ev) => {
  const req = ev.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (
    /\.mp4$/i.test(url.pathname) ||
    url.host === "redeye-download.sites.tab.bot" ||
    url.searchParams.has("re-pack") ||
    req.headers.has("range")
  ) {
    return;
  }

  // Google Fonts: cache-first
  if (url.host === "fonts.googleapis.com" || url.host === "fonts.gstatic.com") {
    ev.respondWith(
      caches.open("re-fonts").then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok || res.type === "opaque") cache.put(req, res.clone());
        return res;
      }).catch(() => fetch(req))
    );
    return;
  }

  // External CDN / AI model assets: cache-first (lazy cached on first use)
  if (
    url.host === "cdn.jsdelivr.net" ||
    url.host === "unpkg.com" ||
    url.host === "storage.googleapis.com"
  ) {
    ev.respondWith(
      caches.open("re-models").then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  // Same-origin requests
  if (url.origin === location.origin) {
    const isNav = req.mode === "navigate" || /\.html$/i.test(url.pathname) || url.pathname.endsWith("/");
    if (isNav) {
      // HTML navigations: network-first with cache fallback
      ev.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        try {
          const res = await fetch(req);
          if (res.ok) cache.put(req, await cleanResponse(res.clone()));
          return res;
        } catch {
          const p = url.pathname;
          const alias = /\/editor$/.test(p) ? "editor.html" : /\/index$/.test(p) ? "index.html" : null;
          const hit =
            (await cache.match(req, { ignoreSearch: true })) ||
            (alias && (await cache.match(alias))) ||
            (await cache.match(/editor/.test(p) ? "editor.html" : "index.html"));
          return hit ? cleanResponse(hit) : Response.error();
        }
      })());
    } else {
      // Static assets (JS, CSS, images, bins): stale-while-revalidate for instant load
      ev.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const hit = await cache.match(req) || await cache.match(req, { ignoreSearch: true });
        const netPromise = fetch(req).then(async (res) => {
          if (res.ok) cache.put(req, await cleanResponse(res.clone()));
          return res;
        }).catch(() => null);
        if (hit) {
          ev.waitUntil(netPromise);
          return cleanResponse(hit);
        }
        const netRes = await netPromise;
        return netRes || Response.error();
      })());
    }
  }
});
