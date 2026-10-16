// Bounded scheduler (fake timers, deterministic) and the DOM helpers the banner relies on:
// visibility, own-mutation filtering and main-container choice. DOM parts run in SIMULATED
// jsdom, not a real browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createContentEnv, BASE_CONTENT_FILES, settle } from './support/content-harness.mjs';

const require = createRequire(import.meta.url);
const dom = require('../extension/src/content/dom.js');

const flush = () => new Promise((r) => setImmediate(r));

/** Fake clock + timers: advance() fires due timers in time order and lets async work settle. */
function fakeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: t + Math.max(0, ms), fn, seq: id });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    pending: () => timers.size,
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, v] of timers) if (v.at <= end && (!next || v.at < next.v.at || (v.at === next.v.at && v.seq < next.v.seq))) next = { id, v };
        if (!next) break;
        t = next.v.at;
        timers.delete(next.id);
        next.v.fn();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}

function scheduler(clock, fn, opts = {}) {
  return dom.createScheduler(fn, Object.assign({ minInterval: 250, maxWait: 1200, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now }, opts));
}

test('a single request runs once after the quiet period, then the scheduler is idle', async () => {
  const clock = fakeClock();
  const runs = [];
  const s = scheduler(clock, () => runs.push(clock.now()));
  s.request();
  await clock.advance(49);
  assert.equal(runs.length, 0);
  await clock.advance(1);
  assert.deepEqual(runs, [50]);
  await clock.advance(10000);
  assert.equal(runs.length, 1, 'no repeated work without new requests');
  assert.equal(clock.pending(), 0);
  assert.equal(s.stats().runs, 1);
});

test('a continuous request stream never postpones a run beyond maxWait, and runs respect minInterval', async () => {
  const clock = fakeClock();
  const runs = [];
  const s = scheduler(clock, () => runs.push(clock.now()));
  const firstRequest = clock.now();
  for (let i = 0; i < 600; i++) {
    s.request(); // every 10 ms for 6 s: never quiet
    await clock.advance(10);
  }
  assert.ok(runs.length >= 4, 'runs happened during the storm: ' + runs.length);
  assert.ok(runs[0] - firstRequest <= 1200, 'first run within maxWait');
  for (let i = 1; i < runs.length; i++) {
    const gap = runs[i] - runs[i - 1];
    assert.ok(gap <= 1200 + 10, 'gap ' + gap + ' exceeds maxWait');
    assert.ok(gap >= 250, 'gap ' + gap + ' below minInterval');
  }
});

test('bursty requests are spaced by minInterval', async () => {
  const clock = fakeClock();
  const runs = [];
  const s = scheduler(clock, () => runs.push(clock.now()), { quiet: 0 });
  for (let i = 0; i < 20; i++) {
    s.request();
    await clock.advance(100);
  }
  await clock.advance(1000);
  for (let i = 1; i < runs.length; i++) assert.ok(runs[i] - runs[i - 1] >= 250);
  assert.ok(runs.length >= 6 && runs.length <= 9, 'about one run per 250 ms: ' + runs.length);
});

test('runs never overlap; requests during a run cause exactly one follow-up run', async () => {
  const clock = fakeClock();
  let active = 0;
  let maxActive = 0;
  let release;
  let calls = 0;
  const s = scheduler(clock, async () => {
    calls++;
    active++;
    maxActive = Math.max(maxActive, active);
    if (calls === 1) await new Promise((r) => (release = r));
    active--;
  });
  s.request();
  await clock.advance(60);
  assert.equal(calls, 1);
  for (let i = 0; i < 5; i++) {
    s.request();
    await clock.advance(100); // timers may fire while the first run is still pending
  }
  assert.equal(calls, 1, 'no second run while the first is in progress');
  release();
  await flush();
  await clock.advance(2000);
  assert.equal(calls, 2, 'exactly one follow-up run');
  assert.equal(maxActive, 1);
  await clock.advance(5000);
  assert.equal(calls, 2);
});

test('flush runs immediately and cancels the pending timer; stop prevents further runs', async () => {
  const clock = fakeClock();
  let calls = 0;
  const s = scheduler(clock, () => calls++);
  s.request();
  await s.flush();
  assert.equal(calls, 1);
  await clock.advance(3000);
  assert.equal(calls, 1, 'the timer armed by request() was cancelled by flush()');
  s.request();
  s.stop();
  await clock.advance(3000);
  s.request();
  await clock.advance(3000);
  assert.equal(calls, 1);
  assert.equal(s.stats().stopped, true);
});

test('a throwing or rejecting run is reported and does not stop the scheduler', async () => {
  const clock = fakeClock();
  const errors = [];
  let calls = 0;
  const s = scheduler(
    clock,
    async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      if (calls === 2) return Promise.reject(new Error('async boom'));
    },
    { onError: (e) => errors.push(e.message) }
  );
  for (let i = 0; i < 3; i++) {
    s.request();
    await clock.advance(400);
  }
  assert.equal(calls, 3);
  assert.deepEqual(errors, ['boom', 'async boom']);
});

/* ------------------------------------------------------------------ DOM helpers (jsdom) */

function env(html) {
  return createContentEnv({ url: 'https://dbc-1.cloud.databricks.com/jobs?o=42', html, files: BASE_CONTENT_FILES });
}

test('isVisible is ancestor-aware: hidden, display:none ancestors and visibility:hidden are not visible', () => {
  const e = env(`<body><style>.gone{display:none}</style>
    <div hidden><main id="a"></main></div>
    <div class="gone"><main id="b"></main></div>
    <main id="c" style="visibility:hidden"></main>
    <div style="display:contents"><main id="d"></main></div>
    <main id="e"></main></body>`);
  const { isVisible } = e.window.DCC.dom;
  const $ = (id) => e.document.getElementById(id);
  assert.equal(isVisible($('a')), false);
  assert.equal(isVisible($('b')), false);
  assert.equal(isVisible($('c')), false);
  assert.equal(isVisible($('d')), true);
  assert.equal(isVisible($('e')), true);
  const detached = e.document.createElement('main');
  assert.equal(isVisible(detached), false);
  e.close();
});

test('isOwnMutation ignores changes made only to data-dcc nodes', async () => {
  const e = env('<body><main><h1>Jobs</h1></main></body>');
  const w = e.window;
  const d = e.document;
  const main = d.querySelector('main');
  const records = [];
  new w.MutationObserver((rs) => records.push(...rs)).observe(d.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
  const badge = d.createElement('span');
  badge.setAttribute('data-dcc', 'badge');
  main.querySelector('h1').appendChild(badge); // ours, added to a native element
  badge.textContent = '$1.00'; // inside ours
  await settle(5);
  assert.ok(records.length >= 2);
  assert.ok(records.every((r) => w.DCC.dom.isOwnMutation(r)), 'all of these are ours');
  records.length = 0;
  main.appendChild(d.createElement('p')); // native
  main.querySelector('h1').setAttribute('class', 'x');
  await settle(5);
  assert.ok(records.length >= 2);
  assert.ok(records.every((r) => !w.DCC.dom.isOwnMutation(r)), 'native changes are not ours');
  e.close();
});

test('findBannerContainer picks the innermost visible main outside modals and our own nodes', () => {
  const e = env(`<body>
    <div data-testid="main-content" id="outer"><main id="inner"><div role="main" id="innermost"></div></main></div>
    <div style="display:none"><main id="hiddenMain"></main></div>
    <div role="dialog"><main id="modalMain"></main></div>
    <div data-dcc="x"><main id="ownMain"></main></div>
  </body>`);
  const native = e.window.DCC.native;
  assert.equal(native.findBannerContainer(e.document).id, 'innermost');
  e.document.getElementById('innermost').remove();
  assert.equal(native.findBannerContainer(e.document).id, 'inner');
  e.close();
});

test('findBannerContainer keeps a preferred valid container and skips offscreen regions when layout is known', () => {
  const e = env('<body><main id="a"></main><main id="b"></main></body>');
  const d = e.document;
  const native = e.window.DCC.native;
  assert.equal(native.findBannerContainer(d).id, 'a');
  assert.equal(native.findBannerContainer(d, { prefer: d.getElementById('b') }).id, 'b');
  // Simulated layout: "a" is off-canvas to the left, "b" is on screen.
  const rect = (left, width) => () => ({ left, right: left + width, top: 0, bottom: 500, width, height: 500, x: left, y: 0 });
  d.getElementById('a').getBoundingClientRect = rect(-2000, 800);
  d.getElementById('b').getBoundingClientRect = rect(200, 800);
  assert.equal(native.findBannerContainer(d).id, 'b');
  assert.equal(native.findBannerContainer(d, { prefer: d.getElementById('a') }).id, 'b', 'an offscreen preferred container is abandoned');
  e.close();
});
