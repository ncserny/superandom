/**
 * Shared test scaffolding. Named with a leading underscore so it does not match
 * the `*.test.mjs` glob and get run as a suite.
 */

import { Engine, Generators } from '../build/internal.mjs';

export function makeEngine(overrides = {}) {
  return new Engine({
    platform: globalThis.crypto,
    foldMode: 'always',
    rateCapBitsPerSecond: Number.POSITIVE_INFINITY,
    readyBits: 256,
    blockUntilReady: false,
    crossOriginIsolated: false,
    origin: 'https://example.test',
    wallClock: () => Date.now(),
    now: () => 0,
    ...overrides,
  });
}

export function makeGenerators(overrides = {}) {
  return new Generators(makeEngine(overrides));
}

/** Chi-square statistic for observed counts against a uniform expectation. */
export function chiSquareUniform(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  const expected = total / counts.length;
  let stat = 0;
  for (const c of counts) stat += ((c - expected) ** 2) / expected;
  return stat;
}

/**
 * Upper-tail critical values at p = 1e-5, by degrees of freedom.
 *
 * These are far out in the tail on purpose. A correct generator should
 * essentially never cross them, so the suite does not flake, while genuine bias
 * produces statistics orders of magnitude larger and is still caught. Values are
 * from the chi-square distribution, rounded up.
 */
export const CHI2_CRITICAL_1E5 = {
  5: 31,
  23: 63,
  199: 291,
  255: 360,
  256: 361,
};

export function tally(size, draw, iterations) {
  const counts = new Array(size).fill(0);
  for (let i = 0; i < iterations; i++) counts[draw()]++;
  return counts;
}
