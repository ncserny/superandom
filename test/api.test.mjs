import test from 'node:test';
import assert from 'node:assert/strict';

import { BASE58 } from './.generated/internal.mjs';
import {
  makeGenerators,
  chiSquareUniform,
  tally,
  CHI2_CRITICAL_1E5,
} from './_helpers.mjs';

test('randomInt respects its bounds', () => {
  const rng = makeGenerators();
  for (let i = 0; i < 5000; i++) {
    const v = rng.randomInt(-5, 5);
    assert.ok(v >= -5 && v < 5, `${v} out of range`);
    assert.ok(Number.isInteger(v));
  }
  // A single-value range is legal and returns that value.
  assert.equal(rng.randomInt(7, 8), 7);
});

test('randomInt validates its arguments', () => {
  const rng = makeGenerators();
  assert.throws(() => rng.randomInt(5, 5), /maxExclusive > min/);
  assert.throws(() => rng.randomInt(5, 1), /maxExclusive > min/);
  assert.throws(() => rng.randomInt(1.5, 5), /must be integers/);
  assert.throws(() => rng.randomInt(1, 5.5), /must be integers/);
});

test('randomInt is uniform over a small non-power-of-two range', () => {
  const rng = makeGenerators();
  const counts = tally(6, () => rng.randomInt(0, 6), 600_000);
  const stat = chiSquareUniform(counts);
  assert.ok(stat < CHI2_CRITICAL_1E5[5], `chi-square ${stat.toFixed(2)} over 5 df`);
});

test('randomInt is uniform just past a byte boundary', () => {
  // 257 is one more than a byte can hold, which is exactly where masking and
  // width bugs hide.
  const rng = makeGenerators();
  const counts = tally(257, () => rng.randomInt(0, 257), 600_000);
  const stat = chiSquareUniform(counts);
  assert.ok(stat < CHI2_CRITICAL_1E5[256], `chi-square ${stat.toFixed(2)} over 256 df`);
});

test('randomInt is uniform at an exact power of two', () => {
  const rng = makeGenerators();
  const counts = tally(256, () => rng.randomInt(0, 256), 600_000);
  const stat = chiSquareUniform(counts);
  assert.ok(stat < CHI2_CRITICAL_1E5[255], `chi-square ${stat.toFixed(2)} over 255 df`);
});

test('randomInt handles ranges wider than 32 bits', () => {
  const rng = makeGenerators();
  const min = 0;
  const max = 2 ** 40;
  let seenHigh = false;
  for (let i = 0; i < 2000; i++) {
    const v = rng.randomInt(min, max);
    assert.ok(v >= min && v < max);
    assert.ok(Number.isSafeInteger(v));
    if (v > 2 ** 32) seenHigh = true;
  }
  // If the wide path silently truncated to 32 bits, this would never fire.
  assert.ok(seenHigh, 'never produced a value above 2^32');
});

test('randomBigInt is uniform and respects its bound', () => {
  const rng = makeGenerators();
  const bound = 1n << 128n;
  let sawLarge = false;
  for (let i = 0; i < 500; i++) {
    const v = rng.randomBigInt(bound);
    assert.ok(v >= 0n && v < bound);
    if (v > 1n << 120n) sawLarge = true;
  }
  assert.ok(sawLarge, 'never produced a value in the top of the range');

  const counts = tally(7, () => Number(rng.randomBigInt(7n)), 70_000);
  const stat = chiSquareUniform(counts);
  assert.ok(stat < 40, `chi-square ${stat.toFixed(2)} over 6 df`);
});

test('randomBigInt validates its bound', () => {
  const rng = makeGenerators();
  assert.throws(() => rng.randomBigInt(0n), /maxExclusive > 0/);
  assert.throws(() => rng.randomBigInt(-1n), /maxExclusive > 0/);
  assert.throws(() => rng.randomBigInt(10), /requires a bigint/);
  assert.equal(rng.randomBigInt(1n), 0n);
});

test('random() covers the unit interval with full mantissa resolution', () => {
  const rng = makeGenerators();
  let min = 1;
  let max = 0;
  const fractionalBits = new Set();
  for (let i = 0; i < 100_000; i++) {
    const v = rng.random();
    assert.ok(v >= 0 && v < 1, `${v} out of range`);
    min = Math.min(min, v);
    max = Math.max(max, v);
    // If only 32 bits were used, v * 2^53 would always be a multiple of 2^21.
    fractionalBits.add((v * 2 ** 53) % 2 ** 21 === 0);
  }
  assert.ok(min < 0.001 && max > 0.999, `range ${min} to ${max}`);
  assert.ok(fractionalBits.has(false), 'output looks limited to 32 bits of mantissa');
});

test('random() is uniform across buckets', () => {
  const rng = makeGenerators();
  const counts = tally(200, () => Math.floor(rng.random() * 200), 400_000);
  const stat = chiSquareUniform(counts);
  assert.ok(stat < CHI2_CRITICAL_1E5[199], `chi-square ${stat.toFixed(2)} over 199 df`);
});

test('shuffle produces every permutation equally often', () => {
  // The real test of a shuffle. A biased swap index, or the widely copied
  // sort(() => random() - 0.5), fails this badly.
  const rng = makeGenerators();
  const source = ['a', 'b', 'c', 'd'];
  const index = new Map();
  const permutations = [];
  permute(source, [], permutations);
  permutations.forEach((p, i) => index.set(p.join(''), i));

  const counts = tally(24, () => index.get(rng.shuffle(source).join('')), 240_000);
  const stat = chiSquareUniform(counts);
  assert.ok(stat < CHI2_CRITICAL_1E5[23], `chi-square ${stat.toFixed(2)} over 23 df`);
});

test('shuffle returns a copy and shuffleInPlace does not', () => {
  const rng = makeGenerators();
  const original = [1, 2, 3, 4, 5];
  const copy = original.slice();

  const shuffled = rng.shuffle(original);
  assert.deepEqual(original, copy, 'shuffle must not mutate its input');
  assert.deepEqual(shuffled.slice().sort((a, b) => a - b), copy);

  const target = original.slice();
  const returned = rng.shuffleInPlace(target);
  assert.equal(returned, target, 'shuffleInPlace must return the same array');
});

test('shuffle handles degenerate inputs', () => {
  const rng = makeGenerators();
  assert.deepEqual(rng.shuffle([]), []);
  assert.deepEqual(rng.shuffle([9]), [9]);
});

test('sample draws distinct elements uniformly', () => {
  const rng = makeGenerators();
  const source = [0, 1, 2, 3, 4, 5, 6, 7];

  const counts = new Array(8).fill(0);
  for (let i = 0; i < 80_000; i++) {
    const picked = rng.sample(source, 3);
    assert.equal(picked.length, 3);
    assert.equal(new Set(picked).size, 3, 'sample returned a duplicate');
    for (const p of picked) counts[p]++;
  }
  // Each element should appear in 3/8 of the draws.
  const stat = chiSquareUniform(counts);
  assert.ok(stat < 35, `chi-square ${stat.toFixed(2)} over 7 df`);

  assert.deepEqual(rng.sample(source, 0), []);
  assert.equal(rng.sample(source, 8).length, 8);
  assert.throws(() => rng.sample(source, 9), /cannot sample/);
  assert.throws(() => rng.sample(source, -1), /non-negative integer/);
});

test('choice is uniform and rejects empty input', () => {
  const rng = makeGenerators();
  const items = ['w', 'x', 'y', 'z'];
  const counts = tally(4, () => items.indexOf(rng.choice(items)), 200_000);
  const stat = chiSquareUniform(counts);
  assert.ok(stat < 30, `chi-square ${stat.toFixed(2)} over 3 df`);
  assert.throws(() => rng.choice([]), /non-empty/);
});

test('weighted respects its weights', () => {
  const rng = makeGenerators();
  const items = ['rare', 'common'];
  const weights = [1, 9];
  let rare = 0;
  const iterations = 200_000;
  for (let i = 0; i < iterations; i++) if (rng.weighted(items, weights) === 'rare') rare++;

  const observed = rare / iterations;
  assert.ok(Math.abs(observed - 0.1) < 0.005, `rare came up ${(observed * 100).toFixed(2)}%`);

  // A zero weight must never be selected.
  for (let i = 0; i < 5000; i++) {
    assert.equal(rng.weighted(['never', 'always'], [0, 1]), 'always');
  }
});

test('weighted validates its input', () => {
  const rng = makeGenerators();
  assert.throws(() => rng.weighted([], []), /non-empty/);
  assert.throws(() => rng.weighted(['a'], [1, 2]), /one weight per item/);
  assert.throws(() => rng.weighted(['a'], [0]), /sum to more than zero/);
  assert.throws(() => rng.weighted(['a'], [-1]), /finite and non-negative/);
  assert.throws(() => rng.weighted(['a'], [Number.NaN]), /finite and non-negative/);
});

test('randomUUID is well formed and collision free', () => {
  const rng = makeGenerators();
  const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const seen = new Set();
  for (let i = 0; i < 100_000; i++) {
    const uuid = rng.randomUUID();
    assert.match(uuid, pattern);
    seen.add(uuid);
  }
  assert.equal(seen.size, 100_000, 'UUID collision');
});

test('randomString uses the requested alphabet uniformly', () => {
  const rng = makeGenerators();
  assert.equal(rng.randomString(0), '');
  assert.equal(rng.randomString(40).length, 40);

  for (const ch of rng.randomString(2000)) {
    assert.ok(BASE58.includes(ch), `${ch} is not in the default alphabet`);
  }
  // base58 deliberately omits the characters that get confused when transcribed.
  for (const ch of '0OIl') assert.ok(!BASE58.includes(ch));

  const alphabet = 'abcdef';
  const counts = tally(
    alphabet.length,
    () => alphabet.indexOf(rng.randomString(1, alphabet)),
    120_000,
  );
  const stat = chiSquareUniform(counts);
  assert.ok(stat < CHI2_CRITICAL_1E5[5], `chi-square ${stat.toFixed(2)} over 5 df`);

  assert.throws(() => rng.randomString(5, 'a'), /at least 2 characters/);
  assert.throws(() => rng.randomString(-1), /non-negative integer/);
});

test('gaussian has the requested mean and spread', () => {
  const rng = makeGenerators();
  const n = 200_000;
  let sum = 0;
  let sumSquares = 0;
  for (let i = 0; i < n; i++) {
    const v = rng.gaussian(5, 2);
    sum += v;
    sumSquares += v * v;
  }
  const mean = sum / n;
  const variance = sumSquares / n - mean * mean;

  // Standard error of the mean is 2/sqrt(200000) ~ 0.0045, so 0.05 is ~11 sigma.
  assert.ok(Math.abs(mean - 5) < 0.05, `mean ${mean.toFixed(4)}`);
  assert.ok(Math.abs(Math.sqrt(variance) - 2) < 0.05, `sd ${Math.sqrt(variance).toFixed(4)}`);
});

test('exponential has the requested rate', () => {
  const rng = makeGenerators();
  const n = 200_000;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = rng.exponential(4);
    assert.ok(v >= 0 && Number.isFinite(v));
    sum += v;
  }
  assert.ok(Math.abs(sum / n - 0.25) < 0.005, `mean ${(sum / n).toFixed(5)}`);
  assert.throws(() => rng.exponential(0), /lambda > 0/);
  assert.throws(() => rng.exponential(-1), /lambda > 0/);
});

function permute(remaining, prefix, out) {
  if (remaining.length === 0) {
    out.push(prefix);
    return;
  }
  for (let i = 0; i < remaining.length; i++) {
    permute(
      [...remaining.slice(0, i), ...remaining.slice(i + 1)],
      [...prefix, remaining[i]],
      out,
    );
  }
}
