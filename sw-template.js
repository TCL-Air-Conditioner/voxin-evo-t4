/* Generated with versioned URLs by build_pages.py. Scope stays inside this product. */
'use strict';
const CONFIG = __CACHE_CONFIG__;
const ROOT = self.registration.scope;
const PREFIX = 'tcl-voxin-evo-t4-';
const STATIC_CACHE = PREFIX + 'pages-' + CONFIG.version;
const MEDIA_CACHE = PREFIX + 'videos-v1';
const MAX_FILES = 4;
const MAX_BYTES = 24 * 1024 * 1024;
const videos = new Map(CONFIG.videos.map(item => [new URL(item.url, ROOT).href, item]));
const pages = new Set(CONFIG.pages.map(path => new URL(path, ROOT).href));
const assets = new Set(CONFIG.assets.map(path => new URL(path, ROOT).href));
const storing = new Map();
let mediaWrites = Promise.resolve();
let warmJob;

function pageKey(url) {
  const key = new URL(url);
  key.search = '';
  key.hash = '';
  if (key.pathname.endsWith('/index.html')) {
    key.pathname = key.pathname.slice(0, -10);
  }
  return pages.has(key.href) ? key.href : null;
}

async function storeMedia(url, response) {
  const item = videos.get(url);
  if (!item || response.status !== 200) return false;
  const body = await response.blob();
  if (body.size !== item.bytes || body.size > MAX_BYTES) return false;
  const digest = await crypto.subtle.digest('SHA-256', await body.arrayBuffer());
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== item.hash) return false;
  const headers = new Headers(response.headers);
  headers.delete('Content-Encoding');
  headers.delete('Content-Range');
  headers.set('Content-Length', String(body.size));
  headers.set('Content-Type', 'video/mp4');
  headers.set('Accept-Ranges', 'bytes');
  const write = mediaWrites.then(async function () {
    const cache = await caches.open(MEDIA_CACHE);
    await cache.put(url, new Response(body, { status: 200, headers }));
    let keys = await cache.keys();
    let size = keys.reduce((total, key) => total + (videos.get(key.url)?.bytes || 0), 0);
    while (keys.length > MAX_FILES || size > MAX_BYTES) {
      const oldest = keys.shift();
      await cache.delete(oldest);
      size -= videos.get(oldest.url)?.bytes || 0;
    }
    return true;
  });
  mediaWrites = write.catch(function () {});
  return write;
}

async function cachedVideoResponse(request, cached) {
  const range = request.headers.get('Range');
  if (!range) return cached;
  const ifRange = request.headers.get('If-Range');
  if (ifRange) {
    const etag = cached.headers.get('ETag');
    const modified = cached.headers.get('Last-Modified');
    const dateMatches = Number.isFinite(Date.parse(ifRange)) &&
      Number.isFinite(Date.parse(modified)) && Date.parse(ifRange) >= Date.parse(modified);
    if (ifRange !== etag && !dateMatches) return cached;
  }
  // Multiple or unknown ranges may be ignored, returning the complete 200 response.
  if (range.includes(',') || !range.startsWith('bytes=')) return cached;
  const body = await cached.blob();
  const size = body.size;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  let start;
  let end;
  if (match && (match[1] || match[2])) {
    if (!match[1]) {
      const suffix = Number(match[2]);
      start = Math.max(0, size - suffix);
      end = suffix > 0 ? size - 1 : -1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    }
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || start >= size || end < start) {
    return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
  }
  const headers = new Headers(cached.headers);
  headers.set('Content-Range', 'bytes ' + start + '-' + end + '/' + size);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(body.slice(start, end + 1), { status: 206, headers });
}

async function mediaResponse(event, url) {
  try {
    const cached = await (await caches.open(MEDIA_CACHE)).match(url);
    if (cached) return await cachedVideoResponse(event.request, cached);
  } catch (_) {
    // Storage failures must not prevent ordinary native playback.
  }
  const response = await fetch(event.request);
  if (response.status === 200) {
    const write = storeMedia(url, response.clone()).catch(function () { return false; });
    storing.set(url, write);
    event.waitUntil(write.finally(function () {
      if (storing.get(url) === write) storing.delete(url);
    }));
  }
  return response;
}

async function refreshStatic(key, request) {
  const response = await fetch(request || key);
  if (response.status === 200 && response.type !== 'opaque') {
    try {
      await (await caches.open(STATIC_CACHE)).put(key, response.clone());
    } catch (_) {}
  }
  return response;
}

async function staticResponse(event, key) {
  let cached;
  try { cached = await (await caches.open(STATIC_CACHE)).match(key); } catch (_) {}
  if (cached) {
    if (pages.has(key)) {
      event.waitUntil(refreshStatic(key, new Request(key, { cache: 'no-cache' })).catch(function () {}));
    }
    return cached;
  }
  return refreshStatic(key, event.request);
}

async function warmVideo(url, owner) {
  if (warmJob && warmJob.url === url) return warmJob.promise;
  if (warmJob) warmJob.controller.abort();
  const controller = new AbortController();
  const job = { url, owner, controller };
  job.promise = (async function () {
    const cache = await caches.open(MEDIA_CACHE);
    if (await cache.match(url)) return true;
    if (storing.has(url)) return storing.get(url);
    const response = await fetch(url, { signal: controller.signal, credentials: 'same-origin' });
    if (controller.signal.aborted) return false;
    return storeMedia(url, response);
  })().catch(function () { return false; }).finally(function () {
    if (warmJob === job) warmJob = null;
  });
  warmJob = job;
  return job.promise;
}

self.addEventListener('install', function (event) {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(PREFIX + 'pages-') && key !== STATIC_CACHE)
      .map(key => caches.delete(key)));
    try {
      const cache = await caches.open(MEDIA_CACHE);
      const old = (await cache.keys()).filter(key => !videos.has(key.url));
      await Promise.all(old.map(key => cache.delete(key)));
    } catch (_) {}
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== new URL(ROOT).origin || !url.href.startsWith(ROOT)) return;
  if (videos.has(url.href)) {
    event.respondWith(mediaResponse(event, url.href));
    return;
  }
  const key = pageKey(url.href);
  if (key || assets.has(url.href)) event.respondWith(staticResponse(event, key || url.href));
});
self.addEventListener('message', function (event) {
  const data = event.data || {};
  const owner = event.source && event.source.id;
  const sourceURL = event.source && event.source.url;
  if (!sourceURL || !sourceURL.startsWith(ROOT)) return;
  if (data.type === 'CANCEL') {
    if (warmJob && warmJob.owner === owner) warmJob.controller.abort();
    return;
  }
  let url;
  try { url = new URL(data.url, ROOT).href; } catch (_) { return; }
  const port = event.ports && event.ports[0];
  if (data.type === 'WARM' && videos.has(url)) {
    event.waitUntil(warmVideo(url, owner).then(function (ok) {
      if (port) port.postMessage({ ok });
    }));
  }
  if (data.type === 'PAGE') {
    const key = pageKey(url) || (assets.has(url) ? url : null);
    if (key) {
      event.waitUntil((async function () {
        const cache = await caches.open(STATIC_CACHE);
        if (!(await cache.match(key))) await refreshStatic(key);
      })().catch(function () {}));
    }
  }
});
