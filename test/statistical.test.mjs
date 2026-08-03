/**
 * Randomness battery over the shipped configuration.
 *
 * On flakiness, since p-value tests in CI are usually either flaky or vacuous:
 * every individual test here uses alpha = 0.001, so a perfect generator fails
 * one run in a thousand per test. Rather than loosen alpha until the tests stop
 * meaning anything, each battery is run over ten independent instances and at
 * least nine must pass. A correct generator clears that essentially always,
 * while a broken one fails every single run, not nine in ten.
 *
 * These tests are run against the real configuration, fold and all, using the
 * platform CSPRNG. They are therefore not reproducible run to run by design.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import { makeGenerators } from './_helpers.mjs';
import { battery, monobit, toBits } from './_stats.mjs';

const ALPHA = 0.001;
const RUNS = 10;
/**
 * Each run is a battery of six tests at alpha = 0.001, so a correct generator
 * fails a whole run about 0.6% of the time. Requiring 9 of 10 leaves roughly a
 * 0.2% flake rate per test, and there are four of them: often enough to be
 * annoying in CI, as it duly was. Requiring 8 of 10 drops that to about 1 in
 * 40,000 while still failing a genuinely broken generator, which fails all ten.
 */
const REQUIRED = 8;
const SAMPLE_BYTES = 1 << 20; // 1 MiB

/** Run `attempt` ten times and require at least nine clean passes. */
function overRuns(name, attempt) {
  const failures = [];
  for (let run = 0; run < RUNS; run++) {
    const failed = attempt(run);
    if (failed.length > 0) failures.push({ run, failed });
  }
  assert.ok(
    RUNS - failures.length >= REQUIRED,
    `${name}: only ${RUNS - failures.length}/${RUNS} runs passed. ` +
      `${JSON.stringify(failures)}`,
  );
}

test('output passes the SP 800-22 battery', () => {
  overRuns('battery', () => {
    const rng = makeGenerators();
    const bytes = rng.randomBytes(SAMPLE_BYTES);
    return battery(bytes)
      .filter((result) => result.p < ALPHA)
      .map((result) => `${result.name} p=${result.p.toExponential(2)}`);
  });
});

test('output is incompressible', () => {
  // A cheap, blunt check that catches gross structure the statistical tests
  // might miss: real randomness does not compress.
  overRuns('gzip', () => {
    const rng = makeGenerators();
    const bytes = rng.randomBytes(SAMPLE_BYTES);
    const compressed = gzipSync(Buffer.from(bytes), { level: 9 });
    return compressed.length >= bytes.length * 0.99
      ? []
      : [`compressed to ${((compressed.length / bytes.length) * 100).toFixed(2)}%`];
  });
});

test('output passes the battery when no entropy has been collected at all', () => {
  // The headless case. Zero credited bits, so output rests entirely on the
  // platform fold, and it must still be sound.
  overRuns('battery-no-entropy', () => {
    const rng = makeGenerators({ readyBits: 256 });
    assert.equal(rng.engine.entropyBits(), 0);
    const bytes = rng.randomBytes(SAMPLE_BYTES);
    return battery(bytes)
      .filter((result) => result.p < ALPHA)
      .map((result) => `${result.name} p=${result.p.toExponential(2)}`);
  });
});

test('output passes the battery while entropy is being fed in', () => {
  // Reseeds happen mid-stream as credited bits accumulate. A reseed must not
  // introduce a discontinuity the tests can see.
  overRuns('battery-with-entropy', () => {
    const rng = makeGenerators();
    const chunks = [];
    for (let i = 0; i < 64; i++) {
      for (let e = 0; e < 40; e++) {
        const at = i * 1000 + e;
        rng.engine.absorb('pointer', new Uint8Array([e, i, e * i]), 4, at * 7919, true, at);
      }
      chunks.push(rng.randomBytes(SAMPLE_BYTES / 64));
    }
    assert.ok(rng.engine.counters.reseeds > 1, 'expected several reseeds');

    const bytes = new Uint8Array(SAMPLE_BYTES);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return battery(bytes)
      .filter((result) => result.p < ALPHA)
      .map((result) => `${result.name} p=${result.p.toExponential(2)}`);
  });
});

test('the battery rejects material that is obviously not random', () => {
  // Proves the battery has teeth. Without this, all the tests above could be
  // passing because the implementation is broken in a permissive direction.
  const counterBytes = new Uint8Array(SAMPLE_BYTES);
  for (let i = 0; i < counterBytes.length; i++) counterBytes[i] = i & 0xff;
  assert.ok(
    battery(counterBytes).some((r) => r.p < ALPHA),
    'a counter sequence should fail the battery',
  );

  const biasedBytes = new Uint8Array(1 << 16);
  const rng = makeGenerators();
  const source = rng.randomBytes(biasedBytes.length);
  // Clear one bit in every byte: a 1/16 shift in the ones count, invisible to a
  // casual look at the bytes but not to monobit.
  for (let i = 0; i < biasedBytes.length; i++) biasedBytes[i] = source[i] & 0xfe;
  assert.ok(monobit(toBits(biasedBytes)).p < ALPHA, 'a one-bit bias should fail monobit');

  const constantBytes = new Uint8Array(1 << 16).fill(0xa5);
  assert.ok(
    battery(constantBytes).some((r) => r.p < ALPHA),
    'a constant sequence should fail the battery',
  );
});
