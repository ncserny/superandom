/**
 * The safety property: output is never worse than crypto.getRandomValues().
 *
 * This is the claim the whole package rests on, so it is tested by substituting
 * deliberately broken components and checking that output survives anyway.
 *
 * Read engine.ts randomBytes() alongside this file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Engine, NotReadyError, toHex } from '../build/internal.mjs';

/** A platform stub with a fully predictable, replayable stream. */
function fakePlatform(byteAt = (i) => (i * 37 + 11) & 0xff) {
  let cursor = 0;
  const calls = [];
  return {
    calls,
    reset() {
      cursor = 0;
      calls.length = 0;
    },
    getRandomValues(array) {
      calls.push({ kind: 'getRandomValues', length: array.length, at: cursor });
      for (let i = 0; i < array.length; i++) array[i] = byteAt(cursor++);
      return array;
    },
  };
}

/** What the platform stub would have produced for a draw of `length` at `offset`. */
function platformStreamAt(byteAt, offset, length) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = byteAt(offset + i);
  return out;
}

function options(overrides = {}) {
  return {
    platform: fakePlatform(),
    foldMode: 'always',
    rateCapBitsPerSecond: Number.POSITIVE_INFINITY,
    readyBits: 256,
    blockUntilReady: false,
    crossOriginIsolated: false,
    origin: 'https://example.test',
    wallClock: () => 1_700_000_000_000,
    now: () => 0,
    ...overrides,
  };
}

test('a completely broken DRBG cannot degrade output below the platform CSPRNG', () => {
  // The DRBG emits nothing but zeros. Because output is XOR-folded with a fresh
  // platform draw, the result must be exactly the platform stream: no worse than
  // calling crypto.getRandomValues() directly.
  const byteAt = (i) => (i * 37 + 11) & 0xff;
  const platform = fakePlatform(byteAt);

  const engine = new Engine(
    options({
      platform,
      drbgFactory: () => ({
        generate: (length) => new Uint8Array(length), // all zeros
        reseed: () => {},
      }),
    }),
  );

  // Everything drawn during construction; the mask is whatever comes next.
  const consumedAtConstruction = platform.calls.reduce((sum, c) => sum + c.length, 0);
  const out = engine.randomBytes(64);

  assert.equal(toHex(out), toHex(platformStreamAt(byteAt, consumedAtConstruction, 64)));
});

test('a completely broken platform CSPRNG cannot degrade output below the DRBG', () => {
  // The mirror case. The platform returns nothing but zeros, so the XOR mask is
  // the identity and output is exactly the DRBG stream.
  const zeros = {
    getRandomValues(array) {
      array.fill(0);
      return array;
    },
  };

  const folded = new Engine(options({ platform: zeros, foldMode: 'always' }));
  const unfolded = new Engine(
    options({ platform: zeros, foldMode: 'never', iUnderstandTheRisk: true }),
  );

  // Same zero platform and same fixed clocks means both engines seed identically.
  assert.equal(toHex(folded.randomBytes(64)), toHex(unfolded.randomBytes(64)));

  // And that stream is not itself zeros: the DRBG is doing real work.
  assert.notEqual(toHex(folded.randomBytes(32)), toHex(new Uint8Array(32)));
});

test('the platform mask is drawn after generate, so the two are independent', () => {
  // If the mask were drawn first and could influence the DRBG, the XOR argument
  // would not hold. Assert the ordering, not just the result.
  const order = [];
  const platform = {
    getRandomValues(array) {
      order.push('platform');
      array.fill(7);
      return array;
    },
  };

  const engine = new Engine(
    options({
      platform,
      drbgFactory: () => ({
        generate: (length) => {
          order.push('generate');
          return new Uint8Array(length);
        },
        reseed: () => {},
      }),
    }),
  );

  order.length = 0;
  engine.randomBytes(16);

  assert.deepEqual(order, ['generate', 'platform']);
});

test('platform entropy is drawn at construction, at every reseed and at every output', () => {
  const platform = fakePlatform();
  const engine = new Engine(options({ platform }));

  const afterConstruction = platform.calls.length;
  assert.ok(afterConstruction >= 2, 'construction must draw platform entropy');

  engine.randomBytes(16);
  assert.equal(platform.calls.length, afterConstruction + 1, 'output must draw a fresh mask');

  const beforeReseed = platform.calls.length;
  engine.reseed();
  assert.ok(platform.calls.length > beforeReseed, 'reseed must draw fresh platform entropy');
});

test('foldMode "never" is the only setting that skips the mask', () => {
  const platform = fakePlatform();
  const engine = new Engine(
    options({ platform, foldMode: 'never', iUnderstandTheRisk: true }),
  );
  const before = platform.calls.length;
  engine.randomBytes(32);
  assert.equal(platform.calls.length, before, 'no mask should be drawn');
});

test('construction refuses to proceed without crypto.getRandomValues', () => {
  // Silently falling back to mouse-derived bytes and calling them secure would be
  // far worse than failing loudly.
  assert.throws(
    () => new Engine(options({ platform: {} })),
    /getRandomValues is unavailable/,
  );
  assert.throws(
    () => new Engine(options({ platform: { getRandomValues: 'not a function' } })),
    /getRandomValues is unavailable/,
  );
});

test('harvested entropy changes the stream', () => {
  // Same platform stub, same clocks: the only difference is human input. If the
  // pool were being ignored, these would match.
  const byteAt = (i) => (i * 37 + 11) & 0xff;

  const withEntropy = new Engine(options({ platform: fakePlatform(byteAt) }));
  const withoutEntropy = new Engine(options({ platform: fakePlatform(byteAt) }));

  for (let i = 0; i < 200; i++) {
    withEntropy.absorb('pointer', new Uint8Array([i, i * 3, i * 7]), 2, i, true, i);
  }
  withEntropy.reseed();
  withoutEntropy.reseed();

  assert.notEqual(toHex(withEntropy.randomBytes(64)), toHex(withoutEntropy.randomBytes(64)));
});

test('output is uncorrelated across instances despite identical clocks', () => {
  // Two engines constructed identically, but with a real platform CSPRNG, must
  // not produce the same stream. This is what the context tag and the fresh
  // platform draws are for.
  const a = new Engine(options({ platform: globalThis.crypto }));
  const b = new Engine(options({ platform: globalThis.crypto }));
  assert.notEqual(toHex(a.randomBytes(64)), toHex(b.randomBytes(64)));
});

test('blockUntilReady gates output on credited bits, and only then', () => {
  const engine = new Engine(
    options({ blockUntilReady: true, readyBits: 64, platform: globalThis.crypto }),
  );

  assert.throws(() => engine.randomBytes(8), NotReadyError);

  // Feed enough credited entropy to cross the threshold.
  for (let i = 0; i < 100; i++) {
    engine.absorb('pointer', new Uint8Array([i, i * 5]), 4, i * 1000 + i, true, i * 1000);
  }
  assert.ok(engine.entropyBits() >= 64, `only ${engine.entropyBits()} bits`);
  assert.equal(engine.randomBytes(8).length, 8);
});

test('ready() resolves once the threshold is crossed', async () => {
  const engine = new Engine(options({ readyBits: 32, platform: globalThis.crypto }));

  let resolved = false;
  const pending = engine.ready().then(() => {
    resolved = true;
  });

  await Promise.resolve();
  assert.equal(resolved, false, 'must not resolve before any entropy arrives');

  for (let i = 0; i < 50; i++) {
    engine.absorb('pointer', new Uint8Array([i]), 4, i * 1000 + i, true, i * 1000);
  }
  await pending;
  assert.equal(resolved, true);

  // Already satisfied, so a later call resolves immediately.
  await engine.ready(1);
});

test('untrusted events never move the readiness gate', () => {
  const engine = new Engine(options({ readyBits: 64, platform: globalThis.crypto }));
  for (let i = 0; i < 5000; i++) {
    engine.absorb('pointer', new Uint8Array([i & 0xff]), 4, i, false, i);
  }
  assert.equal(engine.entropyBits(), 0);
  assert.equal(engine.isReady(), false);
});

test('randomBytes validates its length', () => {
  const engine = new Engine(options({ platform: globalThis.crypto }));
  assert.equal(engine.randomBytes(0).length, 0);
  assert.throws(() => engine.randomBytes(-1));
  assert.throws(() => engine.randomBytes(2.5));
});

test('output stays platform-grade with no collectors and no entropy at all', () => {
  // The headless-browser case: zero credited bits for the whole session. Output
  // must still be sound, because it is folded with the platform CSPRNG.
  const engine = new Engine(options({ platform: globalThis.crypto }));
  assert.equal(engine.entropyBits(), 0);

  const bytes = engine.randomBytes(1 << 16);
  const counts = new Array(256).fill(0);
  for (const b of bytes) counts[b]++;
  const expected = bytes.length / 256;
  let chiSquare = 0;
  for (const c of counts) chiSquare += ((c - expected) ** 2) / expected;
  assert.ok(chiSquare < 331, `chi-square ${chiSquare.toFixed(1)} over 255 df`);
});
