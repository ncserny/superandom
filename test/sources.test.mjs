/**
 * Collector tests.
 *
 * The collectors take their event target, clock and timers by injection, so the
 * whole set runs in plain Node against a fake target. No DOM, no jsdom.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPointerCollector,
  createKeyboardCollector,
  createTouchCollector,
  createScrollCollector,
  createRafCollector,
  createAmbientCollector,
  createCollector,
  ALL_COLLECTORS,
} from '../build/internal.mjs';

/** Counts listener registration so leaks are visible. */
class FakeTarget {
  constructor() {
    this.listeners = new Map();
    this.addCount = 0;
    this.removeCount = 0;
    this.options = [];
  }

  addEventListener(type, handler, options) {
    this.addCount++;
    this.options.push({ type, options });
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.removeCount++;
    this.listeners.get(type)?.delete(handler);
  }

  dispatch(type, event) {
    for (const handler of this.listeners.get(type) ?? []) handler({ type, ...event });
  }

  get liveCount() {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

function harness(extra = {}) {
  const absorbed = [];
  const target = new FakeTarget();
  const context = {
    target,
    now: () => 0,
    absorb: (id, bytes, bits, sample, trusted, at) => {
      // Copy: the collectors reuse a scratch buffer by design.
      absorbed.push({ id, bytes: Uint8Array.from(bytes), bits, sample, trusted, at });
    },
    ...extra,
  };
  return { target, context, absorbed };
}

test('pointer throttles to roughly one sample per frame', () => {
  const { target, context, absorbed } = harness();
  const collector = createPointerCollector();
  collector.start(context);

  // 60 events across 100ms. At a 16ms throttle that is at most 7 samples.
  for (let i = 0; i < 60; i++) {
    target.dispatch('pointermove', {
      timeStamp: (i * 100) / 60,
      clientX: i,
      clientY: i * 2,
      movementX: 1,
      movementY: 2,
      pointerType: 'mouse',
    });
  }

  assert.ok(absorbed.length <= 7, `absorbed ${absorbed.length} samples, expected at most 7`);
  assert.ok(absorbed.length >= 5, `absorbed only ${absorbed.length} samples`);
  assert.ok(absorbed.every((a) => a.id === 'pointer'));
  collector.stop();
});

test('pointer button events are not throttled and are worth more', () => {
  const { target, context, absorbed } = harness();
  const collector = createPointerCollector();
  collector.start(context);

  for (let i = 0; i < 10; i++) {
    target.dispatch('pointerdown', { timeStamp: i, clientX: i, clientY: i, buttons: 1 });
  }
  assert.equal(absorbed.length, 10);
  assert.ok(absorbed.every((a) => a.bits === 4));
  collector.stop();
});

test('pointer credits pen axes above mouse', () => {
  const { target, context, absorbed } = harness();
  const collector = createPointerCollector();
  collector.start(context);

  target.dispatch('pointermove', { timeStamp: 100, pointerType: 'mouse', clientX: 1, clientY: 1 });
  target.dispatch('pointermove', { timeStamp: 200, pointerType: 'pen', clientX: 2, clientY: 2, pressure: 0.42 });

  assert.equal(absorbed[0].bits, 2, 'mouse move should claim 2 bits');
  assert.equal(absorbed[1].bits, 3, 'pen move should claim an extra bit for the analog axes');
  // The pen sample carries more bytes, because the analog axes are appended.
  assert.ok(absorbed[1].bytes.length > absorbed[0].bytes.length);
  collector.stop();
});

test('pointer uses coalesced events without absorbing the whole batch', () => {
  const { target, context, absorbed } = harness();
  const collector = createPointerCollector();
  collector.start(context);

  const batch = [];
  for (let i = 0; i < 40; i++) {
    batch.push({ timeStamp: 100 + i, clientX: i, clientY: i, movementX: 1, movementY: 1 });
  }
  target.dispatch('pointermove', {
    timeStamp: 140,
    clientX: 39,
    clientY: 39,
    getCoalescedEvents: () => batch,
  });

  assert.equal(absorbed.length, 1);
  // One frame's worth of bytes, not forty.
  assert.ok(absorbed[0].bytes.length < 200, `absorbed ${absorbed[0].bytes.length} bytes`);
  collector.stop();
});

test('pointer marks synthetic events untrusted', () => {
  const { target, context, absorbed } = harness();
  const collector = createPointerCollector();
  collector.start(context);

  target.dispatch('pointermove', { timeStamp: 100, isTrusted: false, clientX: 1, clientY: 1 });
  assert.equal(absorbed[0].trusted, false);
  collector.stop();
});

test('keyboard never reads anything but timing', () => {
  // The privacy contract, enforced rather than documented. Every property that
  // could reveal what was typed is a getter that fails the test if touched.
  const { target, context, absorbed } = harness();
  const collector = createKeyboardCollector();
  collector.start(context);

  const forbidden = ['key', 'code', 'keyCode', 'which', 'charCode', 'target', 'data'];
  const touched = [];

  for (let i = 0; i < 5; i++) {
    const event = { type: 'keydown', timeStamp: i * 120 };
    for (const property of forbidden) {
      Object.defineProperty(event, property, {
        get() {
          touched.push(property);
          return 'SECRET';
        },
        enumerable: true,
      });
    }
    // Dispatch directly so the spread in FakeTarget.dispatch cannot read them.
    for (const handler of target.listeners.get('keydown')) handler(event);
  }

  assert.deepEqual(touched, [], `keyboard collector read ${touched.join(', ')}`);
  assert.equal(absorbed.length, 5);
  // Only the interval is absorbed: eight bytes, one double.
  assert.ok(absorbed.every((a) => a.bytes.length === 8));
  collector.stop();
});

test('keyboard does not credit the first event, which has no interval', () => {
  const { target, context, absorbed } = harness();
  const collector = createKeyboardCollector();
  collector.start(context);

  target.dispatch('keydown', { timeStamp: 1000 });
  target.dispatch('keydown', { timeStamp: 1140 });

  assert.equal(absorbed[0].bits, 0);
  assert.equal(absorbed[1].bits, 1);
  collector.stop();
});

test('touch absorbs contact geometry', () => {
  const { target, context, absorbed } = harness();
  const collector = createTouchCollector();
  collector.start(context);

  target.dispatch('touchstart', {
    timeStamp: 500,
    changedTouches: [{ clientX: 10, clientY: 20, radiusX: 12.5, radiusY: 11.25, force: 0.63 }],
  });

  assert.equal(absorbed.length, 1);
  assert.equal(absorbed[0].bits, 4);
  assert.ok(absorbed[0].bytes.length > 24);
  collector.stop();
});

test('scroll throttles more loosely than pointer', () => {
  const { target, context, absorbed } = harness();
  const collector = createScrollCollector();
  collector.start(context);

  // 20 events over 100ms, with a 50ms throttle.
  for (let i = 0; i < 20; i++) {
    target.dispatch('wheel', { timeStamp: i * 5, deltaY: 120, deltaMode: 0 });
  }
  assert.ok(absorbed.length <= 3, `absorbed ${absorbed.length}`);
  collector.stop();
});

test('raf absorbs the residual after removing nominal frame time', () => {
  let frameCallback = null;
  const { context, absorbed } = harness({
    requestFrame: (callback) => {
      frameCallback = callback;
      return 1;
    },
    cancelFrame: () => {},
    setTimer: (fn) => fn,
    isVisible: () => true,
  });

  const collector = createRafCollector();
  collector.start(context);

  // A perfectly regular 60Hz stream has almost no residual, so it earns little.
  let time = 0;
  for (let i = 0; i < 5; i++) {
    time += 1000 / 60;
    const callback = frameCallback;
    frameCallback = null;
    callback(time);
  }

  assert.ok(absorbed.length >= 3, `absorbed ${absorbed.length} frames`);
  assert.ok(absorbed.every((a) => a.id === 'raf' && a.bits === 0.5));
  collector.stop();
});

test('ambient records the timing of environment changes', () => {
  const { target, context, absorbed } = harness();
  const collector = createAmbientCollector();
  collector.start(context);

  target.dispatch('visibilitychange', { timeStamp: 1000 });
  target.dispatch('online', { timeStamp: 4000 });

  assert.equal(absorbed.length, 2);
  assert.ok(absorbed.every((a) => a.id === 'ambient'));
  collector.stop();
});

test('every collector removes exactly the listeners it added', () => {
  // A collector that leaks listeners keeps a detached page alive.
  for (const id of ALL_COLLECTORS) {
    const { target, context } = harness({
      requestFrame: () => 1,
      cancelFrame: () => {},
      setTimer: () => 1,
      clearTimer: () => {},
      isVisible: () => true,
      documentRef: null,
      navigatorRef: null,
    });

    const collector = createCollector(id);
    collector.start(context);
    const added = target.addCount;
    collector.stop();

    assert.equal(target.removeCount, added, `${id} added ${added}, removed ${target.removeCount}`);
    assert.equal(target.liveCount, 0, `${id} left listeners attached`);
  }
});

test('collectors attach passively and in the capture phase', () => {
  // Passive so a handler can never delay scrolling, capture so page code calling
  // stopPropagation cannot starve the collectors.
  const { target, context } = harness();
  const collector = createPointerCollector();
  collector.start(context);

  assert.ok(target.options.length > 0);
  for (const entry of target.options) {
    assert.equal(entry.options.passive, true, `${entry.type} is not passive`);
    assert.equal(entry.options.capture, true, `${entry.type} is not in the capture phase`);
  }
  collector.stop();
});

test('a stopped collector absorbs nothing further', () => {
  const { target, context, absorbed } = harness();
  const collector = createPointerCollector();
  collector.start(context);
  target.dispatch('pointermove', { timeStamp: 100, clientX: 1, clientY: 1 });
  const before = absorbed.length;

  collector.stop();
  target.dispatch('pointermove', { timeStamp: 500, clientX: 2, clientY: 2 });
  assert.equal(absorbed.length, before);
});

test('collectors survive a missing host capability instead of throwing', () => {
  // No requestAnimationFrame, no timers, no document: every collector that needs
  // one must quietly do nothing.
  const { target, context } = harness();
  for (const id of ALL_COLLECTORS) {
    const collector = createCollector(id);
    assert.doesNotThrow(() => collector.start(context), `${id} threw on a bare host`);
    assert.doesNotThrow(() => collector.stop(), `${id} threw on stop`);
  }
  assert.equal(target.liveCount, 0);
});

test('createCollector rejects an unknown source', () => {
  assert.throws(() => createCollector('telepathy'), /unknown source/);
});
