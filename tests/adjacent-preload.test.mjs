import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTool, vue, window, waitFor} from './helpers/tool-dom.mjs';

const {createAdjacentPreloader} = await import(await loadTool('src/composables/useAdjacentPreload.js'));
const WorkViewer = (await import(await loadTool('src/components/photography/WorkViewer.vue'))).default;
const display = id => `/api/media/${encodeURIComponent(id)}/display`;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((r, j) => { resolve = r; reject = j; });
  return {promise, resolve, reject};
};
const settle = async () => { await new Promise(setImmediate); await vue.nextTick(); };
const headResponse = (status = 200) => new Response(null, {status});
const snapshot = (workId = 'work-one', ids = ['first', 'second', 'third'], index = 0) => ({workId, ids, index});

function environment() {
  const document = Object.assign(new EventTarget(), {visibilityState: 'visible', hidden: false});
  const connection = Object.assign(new EventTarget(), {saveData: false});
  const navigator = {onLine: true, connection};
  const window = Object.assign(new EventTarget(), {matchMedia: () => ({matches: false})});
  return {document, navigator, window};
}

function fakeTimers() {
  let sequence = 0;
  const pending = new Map();
  return {
    pending,
    setTimeout(callback, delay) { const id = ++sequence; pending.set(id, {callback, delay}); return id; },
    clearTimeout(id) { pending.delete(id); },
    expire() {
      for (const [id, timer] of [...pending]) {
        if (!pending.has(id)) continue;
        pending.delete(id);
        timer.callback();
      }
    },
  };
}

function nativeImages() {
  const images = [], sources = [];
  const stats = {live: 0, peak: 0};
  class MockImage extends EventTarget {
    constructor() {
      super();
      this._src = '';
      this.onload = null;
      this.onerror = null;
      this.fetchPriority = '';
      this.decoding = '';
      this.decodeCalls = 0;
      this.decodingResult = deferred();
      this.attributes = new Map();
      images.push(this);
    }
    get src() { return this._src; }
    set src(value) {
      if (this._src) stats.live--;
      this._src = String(value || '');
      if (this._src) {
        stats.live++;
        stats.peak = Math.max(stats.peak, stats.live);
        sources.push(this._src);
      }
    }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === 'src') this.src = value;
      if (name === 'fetchpriority') this.fetchPriority = value;
    }
    getAttribute(name) { return name === 'src' ? this.src : this.attributes.get(name) || null; }
    removeAttribute(name) { this.attributes.delete(name); if (name === 'src') this.src = ''; }
    decode() { this.decodeCalls++; return this.decodingResult.promise; }
    load() {
      this.complete = true;
      this.naturalWidth = 1200;
      this.naturalHeight = 800;
      this.onload?.({target: this});
      this.dispatchEvent(new Event('load'));
    }
    fail() { this.onerror?.({target: this}); this.dispatchEvent(new Event('error')); }
  }
  return {Image: MockImage, imageFactory: () => new MockImage(), images, sources, stats};
}

function mockedHeads({ignoreAbort = false, automatic = false} = {}) {
  const calls = [];
  const fetcher = (url, options = {}) => {
    const pending = deferred();
    const call = {url, options, pending, done: false};
    calls.push(call);
    const abort = () => {
      if (!ignoreAbort && !call.done) {
        call.done = true;
        pending.reject(new DOMException('Fixture aborted', 'AbortError'));
      }
    };
    options.signal?.addEventListener('abort', abort, {once: true});
    call.resolve = (status = 200) => {
      if (call.done) return;
      call.done = true;
      options.signal?.removeEventListener('abort', abort);
      pending.resolve(typeof status === 'object' ? status : headResponse(status));
    };
    call.reject = error => {
      if (call.done) return;
      call.done = true;
      options.signal?.removeEventListener('abort', abort);
      pending.reject(error);
    };
    assert.equal(options.method, 'HEAD', 'prefetch permission requests must only use HEAD');
    assert.match(url, /^\/api\/media\/.+\/display$/);
    if (automatic) call.resolve();
    return pending.promise;
  };
  return {calls, fetcher, finish() { for (const call of calls) call.resolve(); }};
}

function controller({env = environment(), images = nativeImages(), heads = mockedHeads(), timers = fakeTimers()} = {}) {
  const preload = createAdjacentPreloader({
    ...env, imageFactory: images.imageFactory, fetcher: heads.fetcher, timeoutMs: 40,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  return {
    preload, env, images, heads, timers,
    async close() {
      preload.dispose();
      heads.finish();
      for (const image of images.images) image.decodingResult.resolve();
      await settle();
    },
  };
}

async function authorized(preload, id, options) {
  return await preload.authorize(id, options);
}

test('adjacent images wait for current decode and request only unique wrapped display neighbors at low priority', async () => {
  const c = controller();
  try {
    c.preload.update(snapshot('work', ['first', 'next-photo', 'middle', 'last-photo'], 0));
    assert.equal(c.images.images.length, 0);
    c.preload.decoded('middle');
    await settle();
    assert.equal(c.images.images.length, 0);
    assert.equal(c.preload.decoded('first'), undefined);
    await settle();
    assert.deepEqual([...c.images.sources].sort(), [display('last-photo'), display('next-photo')].sort());
    for (const image of c.images.images) {
      assert.equal(image.fetchPriority, 'low');
      assert.equal(image.decoding, 'async');
      assert.ok(image.crossOrigin == null || image.crossOrigin === '', 'prefetch must preserve the normal no-CORS image request');
    }
    assert.equal(c.heads.calls.length, 0);
    assert.equal(c.images.stats.peak, 2);
    assert.equal(c.preload.wasPrefetched('unrelated-valid-photo'), true);
    assert.equal(c.preload.wasPrefetched(''), false);
  } finally { await c.close(); }
});

test('empty, single, two-photo and repeated-id groups do not create duplicate or current-image preloads', async () => {
  for (const {ids, expected} of [
    {ids: [], expected: []},
    {ids: ['one'], expected: []},
    {ids: ['one', 'two'], expected: [display('two')]},
    {ids: ['one', 'one'], expected: []},
    {ids: ['one', 'two', 'two'], expected: [display('two')]},
    {ids: ['one', 'one', 'two'], expected: [display('two')]},
    {ids: ['one', '../invalid', 'invalid/photo'], expected: []},
  ]) {
    const c = controller();
    try {
      c.preload.update(snapshot('dedup', ids));
      c.preload.decoded(ids[0]);
      c.preload.decoded(ids[0]);
      await settle();
      assert.deepEqual(c.images.sources, expected);
      assert.ok(c.images.stats.peak <= 2);
    } finally { await c.close(); }
  }
});

test('same-context decode and update events do not repeat successful or failed image attempts', async () => {
  const c = controller();
  try {
    c.preload.update(snapshot());
    c.preload.decoded('first');
    await settle();
    const [loaded, failed] = c.images.images;
    loaded.load();
    loaded.decodingResult.resolve();
    failed.fail();
    await settle();
    c.preload.update(snapshot());
    c.preload.decoded('first');
    c.preload.decoded('first');
    await settle();
    assert.equal(c.images.images.length, 2);
    assert.equal(c.heads.calls.length, 0);
    assert.equal(c.preload.wasPrefetched('never-adjacent'), true);
  } finally { await c.close(); }
});

test('malformed, external and original-looking IDs cannot produce native hints or permission requests', async () => {
  const c = controller();
  try {
    c.preload.update(snapshot('latch', ['current', 'valid-neighbor']));
    c.preload.decoded('current');
    await settle();
    assert.equal(c.images.images.length, 1);
    for (const id of ['', '../outside', 'https://example.invalid/photo', 'photo/original', 'photo?variant=original', 'photo%2Foriginal', null]) {
      c.preload.update(snapshot('malformed', ['current', id]));
      c.preload.decoded('current');
      await settle();
      assert.equal(c.images.images.length, 1);
      assert.equal(c.preload.wasPrefetched(id), false);
      assert.equal(await authorized(c.preload, id), false);
      assert.equal(c.heads.calls.length, 0);
    }
    assert.deepEqual(c.images.sources, [display('valid-neighbor')]);
  } finally { await c.close(); }
});

test('active source, work and list changes release old images and ignore their late load or decode callbacks', async () => {
  for (const next of [
    snapshot('work-one', ['first', 'second', 'third'], 1),
    snapshot('work-two', ['new-first', 'new-second', 'new-third'], 0),
    snapshot('work-one', ['first', 'new-second', 'new-third'], 0),
  ]) {
    const c = controller();
    try {
      c.preload.update(snapshot());
      c.preload.decoded('first');
      await settle();
      const old = [...c.images.images];
      old[0].load();
      c.preload.update(next);
      assert.ok(old.every(image => image.src === ''));
      old[0].decodingResult.resolve();
      old[1].load();
      old[1].decodingResult.resolve();
      await settle();
      assert.equal(c.images.images.length, 2);
      c.preload.decoded(next.ids[next.index]);
      await settle();
      assert.ok(c.images.images.length > 2);
      assert.ok(c.images.stats.live <= 2);
      assert.ok(c.images.stats.peak <= 2);
    } finally { await c.close(); }
  }
});

test('rapid snapshot changes dispatch only the final decoded context and retain at most two native images', async () => {
  const c = controller();
  try {
    c.preload.update(snapshot('old', ['old-current', 'old-next', 'old-previous']));
    c.preload.decoded('old-current');
    await settle();
    const old = [...c.images.images];
    c.preload.update(snapshot('middle', ['middle-current', 'middle-next', 'middle-previous']));
    c.preload.update(snapshot('latest', ['latest-current', 'latest-next', 'latest-previous']));
    c.preload.decoded('middle-current');
    old.forEach(image => { image.load(); image.decodingResult.resolve(); });
    await settle();
    assert.equal(c.images.images.length, 2);
    c.preload.decoded('latest-current');
    await settle();
    assert.equal(c.images.images.length, 4);
    assert.ok(c.images.sources.every(url => !url.includes('middle-')));
    assert.ok(c.images.stats.peak <= 2);
  } finally { await c.close(); }
});

test('hidden, saveData and offline conditions cancel preloads and require a new current decode after recovery', async () => {
  for (const condition of ['hidden', 'saveData', 'offline']) {
    const c = controller();
    const change = blocked => {
      if (condition === 'hidden') {
        c.env.document.hidden = blocked;
        c.env.document.visibilityState = blocked ? 'hidden' : 'visible';
        c.env.document.dispatchEvent(new Event('visibilitychange'));
      } else if (condition === 'saveData') {
        c.env.navigator.connection.saveData = blocked;
        c.env.navigator.connection.dispatchEvent(new Event('change'));
      } else {
        c.env.navigator.onLine = !blocked;
        c.env.window.dispatchEvent(new Event(blocked ? 'offline' : 'online'));
      }
    };
    try {
      c.preload.update(snapshot());
      c.preload.decoded('first');
      await settle();
      change(true);
      assert.ok(c.images.images.every(image => image.src === ''));
      assert.equal(c.preload.wasPrefetched('unrelated-valid-photo'), true);
      c.preload.decoded('first');
      await settle();
      assert.equal(c.images.images.length, 2);
      change(false);
      await settle();
      assert.equal(c.images.images.length, 2);
      c.preload.decoded('first');
      await settle();
      assert.equal(c.images.images.length, 4);
      assert.ok(c.images.stats.peak <= 2);
    } finally { await c.close(); }
  }
});

test('timeout and disposal release image requests, suppress stale events and remove scheduled work', async () => {
  const c = controller();
  try {
    c.preload.update(snapshot());
    c.preload.decoded('first');
    await settle();
    assert.ok(c.timers.pending.size > 0);
    c.timers.expire();
    await settle();
    assert.ok(c.images.images.every(image => image.src === ''));
    assert.equal(c.timers.pending.size, 0);
    const count = c.images.images.length;
    c.preload.decoded('first');
    await settle();
    assert.equal(c.images.images.length, count);
    c.preload.update(snapshot('other', ['other-first', 'other-next']));
    c.preload.decoded('other-first');
    await settle();
    c.preload.dispose();
    assert.ok(c.images.images.every(image => image.src === ''));
    assert.equal(c.timers.pending.size, 0);
    c.preload.update(snapshot());
    c.preload.decoded('first');
    c.env.window.dispatchEvent(new Event('online'));
    c.images.images.forEach(image => { image.load(); image.decodingResult.resolve(); });
    await settle();
    assert.equal(c.images.images.length, count + 1);
  } finally { await c.close(); }
});

test('reduced motion alone keeps adjacent preloading enabled', async () => {
  const env = environment();
  env.window.matchMedia = () => ({matches: true});
  const c = controller({env});
  try {
    c.preload.update(snapshot());
    c.preload.decoded('first');
    await settle();
    assert.equal(c.images.images.length, 2);
  } finally { await c.close(); }
});

test('document permission latch survives image failure, release, disposal and a new controller', async () => {
  const env = environment();
  const first = controller({env});
  try {
    assert.equal(first.preload.wasPrefetched('unrelated'), false);
    first.preload.update(snapshot('two', ['one', 'two']));
    first.preload.decoded('one');
    await settle();
    first.images.images[0].fail();
    await settle();
    assert.equal(first.preload.wasPrefetched('unrelated'), true);
    first.preload.dispose();
    const second = controller({env});
    try {
      assert.equal(second.preload.wasPrefetched('new-work-photo'), true);
      const permission = authorized(second.preload, 'new-work-photo');
      await waitFor(() => second.heads.calls.length === 1);
      const call = second.heads.calls[0];
      assert.equal(call.url, display('new-work-photo'));
      assert.equal(call.options.credentials, 'same-origin');
      assert.equal(call.options.cache, 'no-store');
      assert.equal(call.options.mode, 'same-origin');
      assert.ok(call.options.signal);
      call.resolve();
      assert.equal(await permission, true);
    } finally { await second.close(); }
    const fresh = controller();
    try { assert.equal(fresh.preload.wasPrefetched('new-work-photo'), false); }
    finally { await fresh.close(); }
  } finally { await first.close(); }
});

test('fresh HEAD authorization fails closed for denied or redirected responses, network errors, cancellation and blocked environments', async () => {
  for (const outcome of ['denied', 'partial', 'redirected', 'network', 'abort', 'timeout', 'offline', 'hidden']) {
    const c = controller();
    try {
      c.preload.update(snapshot('two', ['one', 'two']));
      c.preload.decoded('one');
      await settle();
      if (outcome === 'offline' || outcome === 'hidden') {
        if (outcome === 'offline') {
          c.env.navigator.onLine = false;
          c.env.window.dispatchEvent(new Event('offline'));
        } else {
          c.env.document.visibilityState = 'hidden';
          c.env.document.dispatchEvent(new Event('visibilitychange'));
        }
        assert.equal(await authorized(c.preload, 'two'), false);
        assert.equal(c.heads.calls.length, 0);
        continue;
      }
      const abort = new AbortController();
      const permission = authorized(c.preload, 'two', {signal: abort.signal});
      await waitFor(() => c.heads.calls.length === 1);
      const call = c.heads.calls[0];
      if (outcome === 'denied') call.resolve(404);
      if (outcome === 'partial') call.resolve(206);
      if (outcome === 'redirected') call.resolve({status: 200, redirected: true});
      if (outcome === 'network') call.reject(new Error('Fixture unavailable'));
      if (outcome === 'abort') abort.abort();
      if (outcome === 'timeout') c.timers.expire();
      assert.equal(await permission, false);
      if (outcome === 'abort' || outcome === 'timeout') assert.equal(call.options.signal.aborted, true);
      assert.equal(c.preload.wasPrefetched('two'), true);
    } finally { await c.close(); }
  }
});

test('in-flight permission checks stop on hidden, offline or disposal while saveData still allows an explicit check', async () => {
  for (const condition of ['hidden', 'offline', 'dispose', 'saveData']) {
    const c = controller();
    try {
      c.preload.update(snapshot('two', ['one', 'two']));
      c.preload.decoded('one');
      await settle();
      const permission = authorized(c.preload, 'two');
      await waitFor(() => c.heads.calls.length === 1);
      const call = c.heads.calls[0];
      if (condition === 'hidden') {
        c.env.document.visibilityState = 'hidden';
        c.env.document.dispatchEvent(new Event('visibilitychange'));
      } else if (condition === 'offline') {
        c.env.navigator.onLine = false;
        c.env.window.dispatchEvent(new Event('offline'));
      } else if (condition === 'dispose') {
        c.preload.dispose();
      } else {
        c.env.navigator.connection.saveData = true;
        c.env.navigator.connection.dispatchEvent(new Event('change'));
        assert.equal(call.options.signal.aborted, false);
        call.resolve();
      }
      assert.equal(await permission, condition === 'saveData');
      assert.equal(call.options.signal.aborted, condition !== 'saveData');
      assert.ok(c.images.images.every(image => image.src === ''));
      assert.equal(c.preload.wasPrefetched('unrelated-photo'), true);
    } finally { await c.close(); }
  }
});

function work(id = 'group', ids = ['first', 'second', 'third']) {
  return {
    id, title: `Work ${id}`, text: 'Fixture caption', assets: ids,
    media: ids.map(id => ({id, width: 1200, height: 800})), allowOriginal: true,
  };
}
const currentImage = host => host.querySelector('.work-viewer__stage img.photo-media__image');
const nextButton = host => host.querySelector('button[aria-label="下一张照片"]');

async function mountViewer(record, {testDocument, images = nativeImages(), heads = mockedHeads({automatic: true})} = {}) {
  const previous = {
    document: globalThis.document, fetch: globalThis.fetch, Image: globalThis.Image,
    windowImage: window.Image, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
  };
  const doc = testDocument || previous.document.implementation.createHTMLDocument('Adjacent preloader fixture');
  Object.defineProperty(doc, 'visibilityState', {configurable: true, value: 'visible'});
  Object.defineProperty(doc, 'hidden', {configurable: true, value: false});
  globalThis.document = doc;
  globalThis.fetch = heads.fetcher;
  globalThis.Image = images.Image;
  window.Image = images.Image;
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {onLine: true, connection: Object.assign(new EventTarget(), {saveData: false})}});
  const props = vue.reactive({work: record});
  const host = doc.createElement('div');
  doc.body.append(host);
  const app = vue.createApp({render: () => vue.h(WorkViewer, props)});
  app.component('RouterLink', {props: ['to'], setup: (props, {slots}) => () => vue.h('a', {href: props.to}, slots.default?.())});
  app.mount(host);
  let mounted = true;
  return {
    host, props, images, heads, document: doc,
    unmount() { if (mounted) { mounted = false; app.unmount(); } },
    async close() {
      if (mounted) { mounted = false; app.unmount(); }
      heads.finish();
      images.images.forEach(image => image.decodingResult.resolve());
      await settle();
      host.remove();
      globalThis.document = previous.document;
      globalThis.fetch = previous.fetch;
      globalThis.Image = previous.Image;
      window.Image = previous.windowImage;
      if (previous.navigator) Object.defineProperty(globalThis, 'navigator', previous.navigator);
      else delete globalThis.navigator;
    },
  };
}

test('WorkViewer waits for native current decode, HEAD-checks a speculative selection and displays its normal fresh URL', async () => {
  const heads = mockedHeads();
  const m = await mountViewer(work(), {heads});
  const decoding = deferred();
  try {
    await waitFor(() => currentImage(m.host));
    const first = currentImage(m.host);
    assert.equal(first.getAttribute('src'), display('first'));
    assert.equal(m.images.images.length, 0);
    assert.equal(heads.calls.length, 0);
    first.decode = () => decoding.promise;
    first.dispatchEvent(new window.Event('load'));
    await settle();
    assert.equal(m.images.images.length, 0);
    decoding.resolve();
    await waitFor(() => m.images.images.length === 2);
    assert.deepEqual([...m.images.sources].sort(), [display('second'), display('third')].sort());
    nextButton(m.host).click();
    await waitFor(() => heads.calls.length === 1);
    assert.equal(heads.calls[0].url, display('second'));
    assert.equal(currentImage(m.host), first);
    assert.match(m.host.querySelector('.work-viewer__count').textContent, /1\s*\/\s*3/);
    heads.calls[0].resolve();
    await waitFor(() => currentImage(m.host)?.getAttribute('src') === display('second'));
    assert.equal(currentImage(m.host).getAttribute('src'), '/api/media/second/display');
    assert.ok(m.host.querySelector('a[href="/api/media/second/original"]'));
    assert.ok(heads.calls.every(call => call.options.method === 'HEAD' && !call.url.includes('/original')));
    assert.ok(m.images.sources.every(url => url.endsWith('/display')));
  } finally { decoding.resolve(); await m.close(); }
});

test('denied speculative selection keeps the current photo and retry performs another permission check', async () => {
  const heads = mockedHeads();
  const m = await mountViewer(work(), {heads});
  try {
    await waitFor(() => currentImage(m.host));
    const first = currentImage(m.host);
    first.decode = async () => {};
    first.dispatchEvent(new window.Event('load'));
    await waitFor(() => m.images.images.length === 2);
    m.images.images.forEach(image => image.fail());
    nextButton(m.host).click();
    await waitFor(() => heads.calls.length === 1);
    heads.calls[0].resolve(404);
    await waitFor(() => m.host.querySelector('[role="alert"]'));
    assert.equal(currentImage(m.host), first);
    assert.equal(m.host.querySelector('img[src="/api/media/second/display"]'), null);
    const retry = m.host.querySelector('[role="alert"] button');
    assert.ok(retry);
    retry.click();
    retry.click();
    await waitFor(() => heads.calls.length === 2);
    await settle();
    assert.equal(heads.calls.length, 2);
    assert.equal(heads.calls[1].url, display('second'));
    heads.calls[1].resolve();
    await waitFor(() => currentImage(m.host)?.getAttribute('src') === display('second'));
    assert.equal(m.host.querySelector('[role="alert"]'), null);
  } finally { await m.close(); }
});

test('document-latched remount checks permission before presenting even a never-prefetched initial photo', async () => {
  const first = await mountViewer(work());
  const doc = first.document;
  try {
    await waitFor(() => currentImage(first.host));
    currentImage(first.host).decode = async () => {};
    currentImage(first.host).dispatchEvent(new window.Event('load'));
    await waitFor(() => first.images.images.length === 2);
  } finally { await first.close(); }
  const heads = mockedHeads();
  const next = await mountViewer(work('unrelated', ['unrelated-current', 'unrelated-next']), {testDocument: doc, heads});
  try {
    await waitFor(() => heads.calls.length === 1);
    assert.equal(heads.calls[0].url, display('unrelated-current'));
    assert.equal(currentImage(next.host), null);
    heads.calls[0].resolve(404);
    await waitFor(() => next.host.querySelector('[role="alert"]'));
    assert.equal(currentImage(next.host), null);
    assert.equal(next.images.images.length, 0);
  } finally { await next.close(); }
});

test('rapid manual selections abort an older HEAD and only the latest authorized target becomes current', async () => {
  const heads = mockedHeads({ignoreAbort: true});
  const m = await mountViewer(work(), {heads});
  try {
    await waitFor(() => currentImage(m.host));
    const first = currentImage(m.host);
    first.decode = async () => {};
    first.dispatchEvent(new window.Event('load'));
    await waitFor(() => m.images.images.length === 2);
    nextButton(m.host).click();
    await waitFor(() => heads.calls.length === 1);
    nextButton(m.host).click();
    await waitFor(() => heads.calls.length === 2);
    assert.equal(heads.calls[0].url, display('second'));
    assert.equal(heads.calls[1].url, display('third'));
    assert.equal(heads.calls[0].options.signal.aborted, true);
    assert.equal(currentImage(m.host), first);
    heads.calls[0].resolve();
    await settle();
    assert.equal(currentImage(m.host), first);
    heads.calls[1].resolve();
    await waitFor(() => currentImage(m.host)?.getAttribute('src') === display('third'));
    assert.equal(m.host.querySelector('img[src="/api/media/second/display"]'), null);
    assert.match(m.host.querySelector('.work-viewer__count').textContent, /3\s*\/\s*3/);
  } finally { await m.close(); }
});

test('work changes and unmount abort pending permission checks and ignore their late successful responses', async () => {
  const heads = mockedHeads({ignoreAbort: true});
  const m = await mountViewer(work(), {heads});
  try {
    await waitFor(() => currentImage(m.host));
    currentImage(m.host).decode = async () => {};
    currentImage(m.host).dispatchEvent(new window.Event('load'));
    await waitFor(() => m.images.images.length === 2);
    nextButton(m.host).click();
    await waitFor(() => heads.calls.length === 1);
    const old = heads.calls[0];
    m.props.work = work('replacement', ['replacement-current', 'replacement-next']);
    await waitFor(() => heads.calls.length === 2);
    assert.equal(old.options.signal.aborted, true);
    assert.equal(heads.calls[1].url, display('replacement-current'));
    old.resolve();
    await settle();
    assert.equal(m.host.querySelector('img[src="/api/media/second/display"]'), null);
    heads.calls[1].resolve();
    await waitFor(() => currentImage(m.host)?.getAttribute('src') === display('replacement-current'));
    currentImage(m.host).decode = async () => {};
    currentImage(m.host).dispatchEvent(new window.Event('load'));
    await waitFor(() => m.images.images.length > 2);
    nextButton(m.host).click();
    await waitFor(() => heads.calls.length === 3);
    m.unmount();
    assert.equal(heads.calls[2].options.signal.aborted, true);
    assert.ok(m.images.images.every(image => image.src === ''));
    const count = m.images.images.length;
    heads.calls[2].resolve();
    m.images.images.forEach(image => { image.load(); image.decodingResult.resolve(); });
    await settle();
    assert.equal(m.images.images.length, count);
    assert.equal(m.host.querySelector('img'), null);
  } finally { await m.close(); }
});
