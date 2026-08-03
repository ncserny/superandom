import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Accumulator,
  POOL_COUNT,
  SOURCE_TAG,
  sha256,
  toHex,
  u8,
  u32le,
  utf8,
} from '../build/internal.mjs';

const ZERO32 = new Uint8Array(32);

/** Recompute the fingerprint the accumulator should have, from the outside. */
function expectedFingerprint(pools) {
  const full = [];
  for (let i = 0; i < POOL_COUNT; i++) full.push(pools[i] ?? ZERO32);
  return toHex(sha256(utf8('superandom/v1/fingerprint'), ...full));
}

/** The pool update the implementation is supposed to perform. */
function mix(previous, id, bytes) {
  return sha256(previous, u8(SOURCE_TAG[id]), u32le(bytes.length), bytes);
}

test('a single absorb lands in pool 0 with the documented framing', () => {
  const acc = new Accumulator();
  const payload = new Uint8Array([1, 2, 3]);
  acc.absorb('pointer', payload);

  assert.equal(toHex(acc.fingerprint()), expectedFingerprint([mix(ZERO32, 'pointer', payload)]));
});

test('absorbs round-robin across the pools', () => {
  const acc = new Accumulator();
  const pools = [];
  for (let i = 0; i < POOL_COUNT; i++) {
    const payload = new Uint8Array([i, i + 100]);
    acc.absorb('pointer', payload);
    pools.push(mix(ZERO32, 'pointer', payload));
  }
  assert.equal(toHex(acc.fingerprint()), expectedFingerprint(pools));

  // The next absorb wraps back onto pool 0, chaining rather than replacing.
  const extra = new Uint8Array([255]);
  acc.absorb('pointer', extra);
  pools[0] = mix(pools[0], 'pointer', extra);
  assert.equal(toHex(acc.fingerprint()), expectedFingerprint(pools));
  assert.equal(acc.debugState().cursor, 1);
});

test('the frame encoding is injective across chunk boundaries', () => {
  // Absorbing (A, B) must never produce the same pool state as absorbing (A||B).
  // Without the length prefix an attacker who controls where events are split
  // could force two distinct streams to collide.
  const whole = new Accumulator();
  whole.absorb('pointer', new Uint8Array([1, 2, 3]));

  const split = new Accumulator();
  split.absorb('pointer', new Uint8Array([1]));
  split.absorb('pointer', new Uint8Array([2, 3]));

  assert.notEqual(toHex(whole.fingerprint()), toHex(split.fingerprint()));

  // Same bytes, same pool, different split: also distinct.
  const a = new Accumulator();
  const b = new Accumulator();
  for (let i = 0; i < POOL_COUNT; i++) a.absorb('platform', new Uint8Array(0));
  for (let i = 0; i < POOL_COUNT; i++) b.absorb('platform', new Uint8Array(0));
  a.absorb('pointer', new Uint8Array([7, 8]));
  b.absorb('pointer', new Uint8Array([7]));
  assert.notEqual(toHex(a.fingerprint()), toHex(b.fingerprint()));
});

test('the source tag separates otherwise identical material', () => {
  const payload = new Uint8Array([9, 9, 9]);
  const one = new Accumulator();
  const two = new Accumulator();
  one.absorb('pointer', payload);
  two.absorb('keyboard', payload);
  assert.notEqual(toHex(one.fingerprint()), toHex(two.fingerprint()));
});

test('staging is transparent: buffered and flushed states agree', () => {
  const buffered = new Accumulator();
  const flushed = new Accumulator();
  for (let i = 0; i < 40; i++) {
    const payload = new Uint8Array([i, i * 2, i * 3]);
    buffered.absorb('pointer', payload);
    flushed.absorb('pointer', payload);
    flushed.flush();
  }
  assert.equal(toHex(buffered.fingerprint()), toHex(flushed.fingerprint()));
});

test('oversized records bypass staging without changing the result', () => {
  // A record larger than the staging buffer is hashed straight into a pool.
  const big = new Uint8Array(5000);
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff;

  const acc = new Accumulator();
  acc.absorb('pointer', big);
  assert.equal(toHex(acc.fingerprint()), expectedFingerprint([mix(ZERO32, 'pointer', big)]));
  assert.equal(acc.debugState().pending, 0);
});

test('staging overflow flushes rather than dropping material', () => {
  const acc = new Accumulator();
  const chunk = new Uint8Array(600);
  chunk.fill(0xab);
  // 4 KiB of staging, 605 bytes per frame: the eighth absorb must force a flush.
  for (let i = 0; i < 10; i++) acc.absorb('pointer', chunk);
  assert.equal(acc.debugState().absorbed + countPending(acc), 10);
});

function countPending(acc) {
  const before = acc.debugState().absorbed;
  acc.flush();
  return acc.debugState().absorbed - before;
}

test('pools drain on the Fortuna schedule', () => {
  assert.equal(Accumulator.poolsDrainedAt(1), 1);
  assert.equal(Accumulator.poolsDrainedAt(2), 2);
  assert.equal(Accumulator.poolsDrainedAt(3), 1);
  assert.equal(Accumulator.poolsDrainedAt(4), 3);
  assert.equal(Accumulator.poolsDrainedAt(8), 4);
  assert.equal(Accumulator.poolsDrainedAt(16), 5);
  assert.equal(Accumulator.poolsDrainedAt(128), 8);
  // Never more than we have.
  assert.equal(Accumulator.poolsDrainedAt(256), POOL_COUNT);
});

test('harvest zeroes the pools it drains', () => {
  const acc = new Accumulator();
  acc.absorb('pointer', new Uint8Array([1, 2, 3]));
  acc.harvest(1); // drains pool 0 only

  // Pool 0 is now back to zero, so the state must match a fresh accumulator.
  assert.equal(toHex(acc.fingerprint()), toHex(new Accumulator().fingerprint()));
});

test('harvest leaves undrained pools intact', () => {
  const acc = new Accumulator();
  const first = new Uint8Array([1]);
  const second = new Uint8Array([2]);
  acc.absorb('pointer', first); // pool 0
  acc.absorb('pointer', second); // pool 1

  acc.harvest(1); // drains pool 0, leaves pool 1

  assert.equal(
    toHex(acc.fingerprint()),
    expectedFingerprint([ZERO32, mix(ZERO32, 'pointer', second)]),
  );
});

test('harvest output depends on the reseed index and the pool contents', () => {
  const a = new Accumulator();
  const b = new Accumulator();
  a.absorb('pointer', new Uint8Array([1]));
  b.absorb('pointer', new Uint8Array([1]));

  assert.equal(toHex(a.harvest(1)), toHex(b.harvest(1)));

  const c = new Accumulator();
  const d = new Accumulator();
  c.absorb('pointer', new Uint8Array([1]));
  d.absorb('pointer', new Uint8Array([2]));
  assert.notEqual(toHex(c.harvest(1)), toHex(d.harvest(1)));

  // Same empty state, different index: still distinct, so a reseed can never
  // reuse the previous seed material verbatim.
  assert.notEqual(toHex(new Accumulator().harvest(1)), toHex(new Accumulator().harvest(2)));
});

test('harvest rejects invalid reseed indices', () => {
  const acc = new Accumulator();
  assert.throws(() => acc.harvest(0), /positive integer/);
  assert.throws(() => acc.harvest(-1), /positive integer/);
  assert.throws(() => acc.harvest(1.5), /positive integer/);
});
