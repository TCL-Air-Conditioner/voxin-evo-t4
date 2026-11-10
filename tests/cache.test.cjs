const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');

const ROOT = 'https://example.test/voxin-evo-t4/';
const bytes = Buffer.from('0123456789');
const hash = createHash('sha256').update(bytes).digest('hex');

class MemoryCache {
  constructor() { this.entries = new Map(); }
  key(value) { return typeof value === 'string' ? value : value.url; }
  async match(value) { return this.entries.get(this.key(value))?.clone(); }
  async put(value, response) {
    assert.equal(response.status, 200, 'partial responses must never be cached');
    this.entries.set(this.key(value), response.clone());
  }
  async delete(value) { return this.entries.delete(this.key(value)); }
  async keys() { return [...this.entries.keys()].map(url => new Request(url)); }
}

function setup() {
  const cachesByName = new Map();
  const handlers = {};
  const network = [];
  let fetchImpl = async request => {
    network.push(typeof request === 'string' ? request : request.url);
    return new Response(bytes, { headers: { 'Content-Type': 'video/mp4', ETag: '"original"' } });
  };
  const config = {
    version: 'build-2',
    pages: ['./', 'one/', 'two/'],
    assets: ['brand-logo.png?v=123'],
    videos: ['one', 'two', 'three', 'four', 'five'].map(slug => ({
      url: slug + '/' + slug + '.mp4?v=123', bytes: bytes.length, hash
    }))
  };
  const caches = {
    async open(name) {
      if (!cachesByName.has(name)) cachesByName.set(name, new MemoryCache());
      return cachesByName.get(name);
    },
    async keys() { return [...cachesByName.keys()]; },
    async delete(name) { return cachesByName.delete(name); }
  };
  const self = {
    registration: { scope: ROOT },
    addEventListener(name, handler) { handlers[name] = handler; },
    async skipWaiting() {},
    clients: { async claim() {} }
  };
  const context = {
    self, caches, URL, Request, Response, Headers, Blob, AbortController,
    crypto: webcrypto, Uint8Array, Map, Set, Promise, Date, Number
  };
  const source = fs.readFileSync('sw-template.js', 'utf8').replace('__CACHE_CONFIG__', JSON.stringify(config));
  vm.runInNewContext(source + '\nglobalThis.testApi = {storeMedia,cachedVideoResponse,warmVideo,MEDIA_CACHE,STATIC_CACHE,pageKey};', context);
  context.fetch = (...args) => fetchImpl(...args);
  function event(request) {
    const promises = [];
    let response;
    return {
      request,
      waitUntil(promise) { promises.push(promise); },
      respondWith(promise) { response = promise; },
      async result() {
        const result = response ? await response : undefined;
        await Promise.all(promises);
        return result;
      }
    };
  }
  return {
    ...context.testApi, caches, cachesByName, handlers, config, network, event,
    setFetch(fn) { fetchImpl = fn; }
  };
}

function fullResponse() {
  return new Response(bytes, { headers: {
    'Content-Type': 'video/mp4', 'Content-Length': '10',
    ETag: '"original"', 'Last-Modified': 'Mon, 09 Nov 2026 00:00:00 GMT'
  } });
}

test('full cache serves correct start, open-ended and suffix ranges', async () => {
  const s = setup();
  for (const [range, expected, contentRange] of [
    ['bytes=2-5', '2345', 'bytes 2-5/10'],
    ['bytes=7-', '789', 'bytes 7-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'],
    ['bytes=0-100', '0123456789', 'bytes 0-9/10']
  ]) {
    const response = await s.cachedVideoResponse(new Request(ROOT + 'one/', { headers: { Range: range } }), fullResponse());
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), contentRange);
    assert.equal(response.headers.get('Content-Length'), String(expected.length));
    assert.equal(await response.text(), expected);
  }
});

test('invalid or out-of-bounds ranges return 416', async () => {
  const s = setup();
  for (const range of ['bytes=10-', 'bytes=8-2', 'bytes=-0', 'bytes=-', 'bytes=foo']) {
    const response = await s.cachedVideoResponse(new Request(ROOT, { headers: { Range: range } }), fullResponse());
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('Content-Range'), 'bytes */10');
  }
});

test('multiple ranges and mismatched If-Range safely return full media', async () => {
  const s = setup();
  for (const headers of [
    { Range: 'bytes=0-1,4-5' },
    { Range: 'bytes=0-1', 'If-Range': '"different"' }
  ]) {
    const response = await s.cachedVideoResponse(new Request(ROOT, { headers }), fullResponse());
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '0123456789');
  }
});

test('matching If-Range preserves 206', async () => {
  const s = setup();
  const response = await s.cachedVideoResponse(new Request(ROOT, {
    headers: { Range: 'bytes=0-1', 'If-Range': '"original"' }
  }), fullResponse());
  assert.equal(response.status, 206);
});

test('full verified media persists and is served without network', async () => {
  const s = setup();
  const url = new URL(s.config.videos[0].url, ROOT).href;
  assert.equal(await s.storeMedia(url, fullResponse()), true);
  const e = s.event(new Request(url, { headers: { Range: 'bytes=3-6' } }));
  s.handlers.fetch(e);
  const response = await e.result();
  assert.equal(await response.text(), '3456');
  assert.equal(response.status, 206);
  assert.equal(s.network.length, 0);
});

test('206 partial data and changed bytes are rejected as full cache entries', async () => {
  const s = setup();
  const url = new URL(s.config.videos[0].url, ROOT).href;
  assert.equal(await s.storeMedia(url, new Response('01', { status: 206 })), false);
  assert.equal(await s.storeMedia(url, new Response('abcdefghij')), false);
  assert.equal((await (await s.caches.open(s.MEDIA_CACHE)).keys()).length, 0);
});

test('only four complete videos are retained', async () => {
  const s = setup();
  for (const item of s.config.videos) {
    await s.storeMedia(new URL(item.url, ROOT).href, fullResponse());
  }
  const cache = await s.caches.open(s.MEDIA_CACHE);
  assert.equal((await cache.keys()).length, 4);
  assert.equal(await cache.match(new URL(s.config.videos[0].url, ROOT).href), undefined);
});

test('cache storage failure still allows native streaming', async () => {
  const s = setup();
  s.caches.open = async () => { throw Error('storage unavailable'); };
  const url = new URL(s.config.videos[0].url, ROOT).href;
  s.setFetch(async () => new Response('01', { status: 206 }));
  const e = s.event(new Request(url, { headers: { Range: 'bytes=0-1' } }));
  s.handlers.fetch(e);
  const response = await e.result();
  assert.equal(response.status, 206);
  assert.equal(await response.text(), '01');
});

test('unreadable cached media falls back to native streaming', async () => {
  const s = setup();
  const cache = await s.caches.open(s.MEDIA_CACHE);
  cache.match = async () => ({
    headers: new Headers(),
    blob: async () => { throw Error('cache read failed'); }
  });
  s.setFetch(async () => new Response('01', { status: 206 }));
  const url = new URL(s.config.videos[0].url, ROOT).href;
  const e = s.event(new Request(url, { headers: { Range: 'bytes=0-1' } }));
  s.handlers.fetch(e);
  const response = await e.result();
  assert.equal(response.status, 206);
  assert.equal(await response.text(), '01');
});

test('cached navigation returns immediately and survives an offline refresh', async () => {
  const s = setup();
  const cache = await s.caches.open(s.STATIC_CACHE);
  await cache.put(ROOT + 'one/', new Response('<h1>saved page</h1>'));
  s.setFetch(async () => { throw Error('offline'); });
  const e = s.event(new Request(ROOT + 'one/?scan=wechat'));
  s.handlers.fetch(e);
  const response = await e.result();
  assert.match(await response.text(), /saved page/);
});

test('other products and unknown media versions are outside the cache routes', async () => {
  const s = setup();
  for (const url of [
    'https://example.test/360-round-cassette/one/',
    ROOT + 'one/one.mp4?v=new-version',
    'https://other.test/voxin-evo-t4/one/'
  ]) {
    const e = s.event(new Request(url));
    s.handlers.fetch(e);
    assert.equal(await e.result(), undefined);
  }
});

test('worker activation retains unchanged media and removes obsolete versions only', async () => {
  const s = setup();
  const cache = await s.caches.open(s.MEDIA_CACHE);
  const keep = new URL(s.config.videos[0].url, ROOT).href;
  await s.storeMedia(keep, fullResponse());
  await cache.put(ROOT + 'old.mp4?v=old', fullResponse());
  await s.caches.open('tcl-voxin-evo-t4-pages-build-1');
  await s.caches.open('unrelated-product-cache');
  const e = s.event();
  s.handlers.activate(e);
  await e.result();
  assert(await cache.match(keep));
  assert.equal(await cache.match(ROOT + 'old.mp4?v=old'), undefined);
  assert(!(await s.caches.keys()).includes('tcl-voxin-evo-t4-pages-build-1'));
  assert((await s.caches.keys()).includes('unrelated-product-cache'));
});

test('background warming deduplicates requests for the same video', async () => {
  const s = setup();
  const url = new URL(s.config.videos[0].url, ROOT).href;
  const results = await Promise.all([s.warmVideo(url, 'tab-1'), s.warmVideo(url, 'tab-2')]);
  assert.deepEqual(results, [true, true]);
  assert.equal(s.network.length, 1);
});

test('another tab cannot cancel the owning tab background request', async () => {
  const s = setup();
  let aborts = 0;
  s.setFetch((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => { aborts++; reject(Error('cancelled')); });
  }));
  const url = new URL(s.config.videos[0].url, ROOT).href;
  const promise = s.warmVideo(url, 'owner');
  await new Promise(resolve => setTimeout(resolve, 0));
  s.handlers.message({ source: { id: 'other', url: ROOT + 'one/' }, data: { type: 'CANCEL' } });
  assert.equal(aborts, 0);
  s.handlers.message({ source: { id: 'owner', url: ROOT + 'one/' }, data: { type: 'CANCEL' } });
  assert.equal(await promise, false);
  assert.equal(aborts, 1);
});
