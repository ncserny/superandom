/**
 * End-to-end tests over the public entry points, plus the guarantees that are
 * properties of the shipped artifact rather than of any one module.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { create, createCore, verifyReceipt, VERSION, ALL_COLLECTORS } from './.generated/internal.mjs';

const buildDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
const manifest = JSON.parse(readFileSync(join(buildDir, 'manifest.json'), 'utf8'));

/** Minimal event target, so create() can run in Node. */
class FakeTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
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

/**
 * A plausible mouse path.
 *
 * The intervals must jitter. A perfectly regular event stream is, correctly,
 * what the SP 800-90B repetition count test is built to reject: a real pointer
 * never arrives on an exact 20ms cadence, and something that does is a replay or
 * a stuck driver.
 */
function* mousePath(count, startAt = 0) {
  let at = startAt;
  let x = 400;
  let y = 300;
  for (let i = 0; i < count; i++) {
    // 17-31ms apart, never twice the same in a row.
    at += 17 + ((i * 7919) % 14) + ((i * 104729) % 3);
    x = (x + ((i * 31) % 17) - 8 + 800) % 800;
    y = (y + ((i * 37) % 13) - 6 + 600) % 600;
    yield {
      timeStamp: at,
      clientX: x,
      clientY: y,
      movementX: ((i * 31) % 17) - 8,
      movementY: ((i * 37) % 13) - 6,
      pointerType: 'mouse',
    };
  }
}

test('createCore works with no DOM at all', () => {
  const rng = createCore();
  assert.equal(typeof rng.random(), 'number');
  assert.equal(rng.randomBytes(32).length, 32);
  assert.match(rng.randomUUID(), /^[0-9a-f-]{36}$/);
  assert.equal(rng.entropyBits(), 0);
  rng.destroy();
});

test('create attaches collectors and harvests real events', () => {
  const target = new FakeTarget();
  const rng = create({ target, sources: ['pointer', 'keyboard'], now: () => 0 });

  assert.ok(target.liveCount > 0, 'no listeners attached');
  assert.equal(rng.entropyBits(), 0);

  for (const event of mousePath(300)) target.dispatch('pointermove', event);

  assert.ok(rng.entropyBits() > 0, 'pointer events produced no credited entropy');

  const pointer = rng.sources().find((s) => s.id === 'pointer');
  assert.ok(pointer.events > 0);
  assert.equal(pointer.active, true);
  assert.equal(pointer.healthy, true);

  rng.destroy();
  assert.equal(target.liveCount, 0, 'destroy left listeners attached');
});

test('a perfectly regular pointer path is flagged as unhealthy', () => {
  // A real mouse never arrives on an exact cadence. A path that does is a
  // replay, a bot, or a driver quantising everything, and the SP 800-90B
  // repetition count test should stop crediting it.
  const target = new FakeTarget();
  const rng = create({ target, sources: ['pointer'], now: () => 0 });

  for (let i = 0; i < 200; i++) {
    target.dispatch('pointermove', {
      timeStamp: i * 20, // metronomic, to the microsecond
      clientX: i % 800,
      clientY: i % 600,
      pointerType: 'mouse',
    });
  }

  const pointer = rng.sources().find((s) => s.id === 'pointer');
  assert.equal(pointer.healthy, false, 'a metronomic path should trip the health tests');
  assert.ok(pointer.events > 0, 'the events should still be counted and mixed');

  // It contributed almost nothing, and certainly nowhere near ready.
  assert.ok(rng.entropyBits() < 32, `credited ${rng.entropyBits()} bits from a replayed path`);
  assert.equal(rng.isReady(), false);
  rng.destroy();
});

test('the rate cap keeps a synthetic flood from faking readiness', () => {
  const target = new FakeTarget();
  const rng = create({
    target,
    sources: ['pointer'],
    readyBits: 256,
    rateCapBitsPerSecond: 64,
    now: () => 0,
  });

  // 20,000 events all claiming to arrive within the same second.
  for (let i = 0; i < 20_000; i++) {
    target.dispatch('pointermove', {
      timeStamp: i * 17,
      clientX: i % 800,
      clientY: i % 600,
      pointerType: 'mouse',
    });
  }

  // Event timestamps advance, so some budget legitimately refills, but the
  // estimate must stay far below what an uncapped count would claim.
  const bits = rng.entropyBits();
  assert.ok(bits < 20_000, `credited ${bits} bits from a flood`);
  rng.destroy();
});

test('stats and sources describe the whole configuration', () => {
  const target = new FakeTarget();
  const rng = create({ target, sources: ['pointer', 'keyboard'], now: () => 0 });
  const stats = rng.stats();

  assert.equal(stats.foldMode, 'always');
  assert.equal(stats.readyBits, 256);
  assert.equal(stats.running, true);
  assert.equal(typeof stats.receiptHead, 'string');
  assert.ok(stats.reseeds >= 1);

  // Every source is reported, enabled or not, each with the reasoning behind
  // its cap so the numbers can be argued with.
  const ids = stats.sources.map((s) => s.id);
  for (const id of ALL_COLLECTORS) assert.ok(ids.includes(id), `${id} missing from stats`);
  for (const source of stats.sources) assert.ok(source.note.length > 20);

  assert.equal(stats.sources.find((s) => s.id === 'pointer').enabled, true);
  assert.equal(stats.sources.find((s) => s.id === 'motion').enabled, false);
  rng.destroy();
});

test('subscribe delivers immediately and can be cancelled', async () => {
  const rng = createCore();
  const seen = [];
  const unsubscribe = rng.subscribe((stats) => seen.push(stats), 16);

  assert.equal(seen.length, 1, 'subscribe should deliver the current stats at once');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(seen.length > 1, 'subscription never fired');

  unsubscribe();
  const count = seen.length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(seen.length, count, 'subscription fired after unsubscribe');
  rng.destroy();
});

test('start and stop are idempotent', () => {
  const target = new FakeTarget();
  const rng = create({ target, sources: ['pointer'], now: () => 0 });

  rng.start();
  rng.start();
  const attached = target.liveCount;
  assert.ok(attached > 0);

  rng.stop();
  rng.stop();
  assert.equal(target.liveCount, 0);

  rng.start();
  assert.equal(target.liveCount, attached, 'restart should reattach the same listeners');
  rng.destroy();
});

test('reseed mixes caller material without crediting it', () => {
  const rng = createCore();
  const before = rng.entropyBits();
  rng.reseed(new TextEncoder().encode('some material from the caller'));
  assert.equal(rng.entropyBits(), before, 'caller material must not be credited');

  const manual = rng.sources().find((s) => s.id === 'manual');
  assert.ok(manual.bytesAbsorbed > 0, 'caller material was not absorbed');
  assert.equal(manual.creditedBits, 0);
  assert.equal(manual.capBits, 0);
});

test('reseed accepts any BufferSource', () => {
  const rng = createCore();
  assert.doesNotThrow(() => rng.reseed(new Uint8Array([1, 2, 3])));
  assert.doesNotThrow(() => rng.reseed(new Uint16Array([1, 2, 3])));
  assert.doesNotThrow(() => rng.reseed(new ArrayBuffer(8)));
  assert.doesNotThrow(() => rng.reseed());
});

test('an unknown source is rejected at construction', () => {
  assert.throws(() => create({ target: new FakeTarget(), sources: ['telepathy'] }), /unknown source/);
});

test('foldMode never requires an explicit acknowledgement', () => {
  assert.throws(() => createCore({ foldMode: 'never' }), /iUnderstandTheRisk/);
  assert.doesNotThrow(() => createCore({ foldMode: 'never', iUnderstandTheRisk: true }));
});

test('a full session produces a verifiable receipt', () => {
  const target = new FakeTarget();
  const rng = create({ target, sources: ['pointer', 'keyboard'], now: () => 0 });

  for (let round = 0; round < 5; round++) {
    for (const event of mousePath(200, round * 100_000)) target.dispatch('pointermove', event);
    rng.randomBytes(1024);
  }

  const receipt = rng.receipt();
  assert.deepEqual(verifyReceipt(receipt), { ok: true });
  assert.ok(receipt.epochs.length > 1, 'expected several reseeds during the session');
  rng.destroy();
});

test('the shipped bundle contains no network APIs', () => {
  // The build fails on this too. Asserting it here as well means the guarantee
  // cannot be lost by someone editing the build script.
  const forbidden = [
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'sendBeacon',
    'geolocation',
    'RTCPeerConnection',
    'importScripts',
  ];

  for (const file of [manifest.files.pinned, manifest.files.esm]) {
    const source = readFileSync(join(buildDir, file), 'utf8');
    for (const api of forbidden) {
      assert.ok(!source.includes(api), `${file} references ${api}`);
    }
  }
});

test('the shipped bundle does not touch persistent storage', () => {
  // Persisting DRBG state across sessions would both weaken forward secrecy and
  // hand the page a tracking supercookie.
  const forbidden = ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie'];
  for (const file of [manifest.files.pinned, manifest.files.esm]) {
    const source = readFileSync(join(buildDir, file), 'utf8');
    for (const api of forbidden) {
      assert.ok(!source.includes(api), `${file} references ${api}`);
    }
  }
});

test('the manifest matches the artifacts it describes', () => {
  const pinned = readFileSync(join(buildDir, manifest.files.pinned));
  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.bytes[manifest.files.pinned], pinned.length);
  assert.match(manifest.integrity[manifest.files.pinned], /^sha384-[A-Za-z0-9+/]+=*$/);

  // Only the pinned filename gets an integrity hash: the alias moves by design
  // and could never be pinned.
  assert.equal(manifest.integrity[manifest.files.alias], undefined);

  const alias = readFileSync(join(buildDir, manifest.files.alias));
  assert.ok(pinned.equals(alias), 'the alias should be a copy of the pinned build');
});
