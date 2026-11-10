const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function setup(options = {}) {
  const timers = new Map();
  let timerId = 0;
  const windowEvents = {};
  const documentEvents = {};
  const location = { href: 'https://example.test/voxin-evo-t4/one/' };
  const calls = { plays: [], pushes: [], posts: [] };
  class Element {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.attributes = {};
      this.events = {};
      this.dataset = {};
      this.hidden = false;
      this.paused = true;
      this.ended = false;
      this.seeking = false;
      this.currentTime = 0;
      this.duration = 30;
      this.readyState = 4;
      this.videoWidth = 1280;
      this.buffered = { length: 1, start: () => 0, end: () => 30 };
    }
    addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
    emit(name, value = {}) { for (const fn of this.events[name] || []) fn(value); }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) {
      delete this.attributes[name];
      if (name === 'src') this.src = '';
      if (name === 'id') this.id = '';
    }
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    appendChild(node) {
      if (node.parent) node.parent.children = node.parent.children.filter(x => x !== node);
      this.children.push(node);
      node.parent = this;
    }
    remove() {
      this.removed = true;
      if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
      return this.children.filter(node => selector === 'source'
        ? node.tag === 'source' : node.className === 'video-link');
    }
    closest(selector) { return selector === 'a.video-link' && this.className === 'video-link' ? this : null; }
    play() {
      calls.plays.push({ video: this, coverVisible: stage.children.some(x => x.id === 'videoPreview' && !x.removed) });
      this.paused = false;
      this.emit('play');
      this.emit('playing');
      return Promise.resolve();
    }
    pause() { if (!this.paused) { this.paused = true; this.emit('pause'); } }
    load() { this.loads = (this.loads || 0) + 1; }
  }
  const stage = new Element('div');
  const video = new Element('video');
  video.id = 'trainingVideo';
  video.appendChild(new Element('source'));
  stage.appendChild(video);
  const preview = new Element('button');
  preview.id = 'videoPreview';
  stage.appendChild(preview);
  const directory = new Element('nav');
  const topicData = ['one', 'two', 'three'].map(slug => ({
    slug, title: slug.toUpperCase(),
    file: slug === 'three' ? null : slug + '/' + slug + '.mp4?v=1',
    cover: slug === 'three' ? null : 'covers/' + slug + '.jpg'
  }));
  for (const item of topicData) {
    const link = new Element('a');
    link.className = 'video-link';
    link.href = 'https://example.test/voxin-evo-t4/' + item.slug + '/';
    directory.appendChild(link);
  }
  const status = new Element('div');
  status.hidden = true;
  const text = new Element('div');
  const retry = new Element('button');
  const direct = new Element('a');
  const title = new Element('div');
  const nodes = {
    videoCatalog: { textContent: JSON.stringify({ root: '../', topics: topicData }) },
    trainingVideo: video, videoDirectory: directory,
    videoPreview: preview, videoStatus: status, statusText: text,
    retryVideo: retry, directVideo: direct
  };
  const worker = {
    postMessage(data, ports) {
      calls.posts.push(data);
      if (ports && data.type === 'WARM') ports[0].postMessage({ ok: true });
    }
  };
  const navigator = { connection: options.connection };
  if (options.worker) navigator.serviceWorker = {
    controller: worker,
    register: async () => ({ active: worker }),
    ready: Promise.resolve({ active: worker }),
    addEventListener() {}
  };
  class Channel {
    constructor() {
      this.port1 = { close() {} };
      this.port2 = { postMessage: data => this.port1.onmessage?.({ data }) };
    }
  }
  const document = {
    hidden: false, title: '',
    getElementById: id => nodes[id],
    createElement: tag => new Element(tag),
    querySelector: selector => selector === '.video-stage' ? stage : selector === '.video-title' ? title : directory,
    addEventListener: (name, fn) => { documentEvents[name] = fn; }
  };
  const window = {
    isSecureContext: true,
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id),
    addEventListener: (name, fn) => { windowEvents[name] = fn; }
  };
  const history = {
    replaceState() {},
    pushState(state, _, url) { location.href = url; calls.pushes.push(url); }
  };
  const context = { document, navigator, window, history, location, URL, MessageChannel: Channel, Set, Object, Number, JSON };
  const exported = 'globalThis.testApi = {get active(){return activeVideo;},get standby(){return standby;},get job(){return job;},scheduleWarm,switchTopic,enoughBuffer,topics,attemptedMedia,noteIntent};})();';
  const code = fs.readFileSync('player.js', 'utf8').replace(/\}\)\(\);\s*$/, exported);
  vm.runInNewContext(code, context);
  return {
    api: context.testApi, video, preview, stage, directory, status, text, retry, direct,
    calls, windowEvents, documentEvents, location, document,
    tick() {
      const pending = [...timers.values()];
      timers.clear();
      for (const fn of pending) fn();
    },
    click(index, extras = {}) {
      let prevented = false;
      directory.emit('click', {
        target: directory.children[index], button: 0,
        preventDefault() { prevented = true; }, ...extras
      });
      return prevented;
    }
  };
}

test('first play removes the preview before synchronous native play', () => {
  const s = setup();
  s.preview.emit('click');
  assert.equal(s.calls.plays.length, 1);
  assert.equal(s.calls.plays[0].coverVisible, false);
  assert.equal(s.video.paused, false);
});
test('a theme link changes source, title and history without leaving the document', () => {
  const s = setup();
  assert.equal(s.click(1), true);
  assert.equal(s.api.active.src, 'https://example.test/voxin-evo-t4/two/two.mp4?v=1');
  assert.equal(s.api.active.paused, false);
  assert.match(s.document.title, /TWO/);
  assert.equal(s.calls.pushes.length, 1);
  assert.equal(s.directory.children[1].getAttribute('aria-current'), 'page');
  assert.equal(s.calls.plays[0].coverVisible, false);
});
test('a prepared player is reused rather than reloading the same video', () => {
  const s = setup();
  s.api.scheduleWarm();
  const prepared = s.api.standby.video;
  assert.equal(prepared.paused, true);
  s.click(1);
  assert.equal(s.api.active, prepared);
  assert.equal(s.api.active.loads, undefined);
  assert.equal(s.api.active.hidden, false);
});
test('background preload does not run without enough current-video buffer', () => {
  const s = setup();
  s.video.buffered.end = () => 2;
  s.api.scheduleWarm();
  assert.equal(s.api.standby, undefined);
});
test('save-data and slow connections suppress speculative downloads', () => {
  for (const connection of [{ saveData: true }, { effectiveType: '2g' }]) {
    const s = setup({ connection });
    s.api.scheduleWarm();
    assert.equal(s.api.standby, undefined);
  }
});
test('buffering stops the inactive player and keeps active controls intact', () => {
  const s = setup();
  s.preview.emit('click');
  s.api.scheduleWarm();
  assert(s.api.standby);
  s.video.emit('waiting');
  assert.equal(s.api.standby, null);
  assert.equal(s.video.paused, false);
  assert.equal(s.video.loads, undefined);
});
test('back navigation selects the right topic without forced autoplay', () => {
  const s = setup();
  s.click(1);
  s.location.href = 'https://example.test/voxin-evo-t4/one/';
  s.windowEvents.popstate();
  assert.equal(s.api.active.paused, true);
  assert.equal(s.calls.plays.length, 1);
  assert.equal(s.calls.pushes.length, 1);
  assert.equal(s.stage.children.filter(x => x.id === 'videoPreview').length, 1);
});
test('modified clicks and unavailable themes retain normal anchor behavior', () => {
  const s = setup();
  assert.equal(s.click(1, { ctrlKey: true }), false);
  assert.equal(s.click(2), false);
  assert.equal(s.calls.pushes.length, 0);
});
test('errors from a discarded video cannot overwrite the new topic', () => {
  const s = setup();
  const old = s.video;
  s.click(1);
  old.emit('error');
  assert.equal(s.api.active.paused, false);
  assert(!s.text.textContent?.includes('could not load'));
});
test('worker warming caches current clip then exactly one next clip', async () => {
  const s = setup({ worker: true });
  await new Promise(resolve => setImmediate(resolve));
  s.api.scheduleWarm();
  s.tick();
  s.tick();
  const media = s.calls.posts.filter(x => x.type === 'WARM');
  assert.equal(media.length, 2);
  assert.match(media[0].url, /one\.mp4/);
  assert.match(media[1].url, /two\.mp4/);
  assert(s.api.standby);
  assert(s.calls.posts.some(x => x.type === 'PAGE' && /one\/$/.test(x.url)));
});
