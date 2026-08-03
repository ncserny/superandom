/**
 * Proof that the uniformity tests have teeth.
 *
 * A chi-square test that passes tells you nothing unless you know it would have
 * failed on a biased input. So this file feeds the shortcuts that superandom
 * deliberately avoids through the exact same harness api.test.mjs uses, and
 * asserts they FAIL. If someone ever weakens the thresholds, these tests break
 * first and loudly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeGenerators, chiSquareUniform, tally, CHI2_CRITICAL_1E5 } from './_helpers.mjs';

test('modulo over a single byte is detectably biased, and rejection sampling is not', () => {
  // 256 is not divisible by 6, so four of the six residues get one extra
  // preimage. That is a 2.4% skew, small enough to look fine by eye and large
  // enough to be obvious over 600k draws.
  const rng = makeGenerators();
  const draws = 600_000;

  const naive = tally(6, () => rng.randomBytes(1)[0] % 6, draws);
  const naiveStat = chiSquareUniform(naive);

  const correct = tally(6, () => rng.randomInt(0, 6), draws);
  const correctStat = chiSquareUniform(correct);

  assert.ok(
    naiveStat > CHI2_CRITICAL_1E5[5],
    `byte modulo should fail but scored ${naiveStat.toFixed(2)}`,
  );
  assert.ok(
    correctStat < CHI2_CRITICAL_1E5[5],
    `rejection sampling should pass but scored ${correctStat.toFixed(2)}`,
  );

  // And the skew points the way the theory says: the low residues win.
  const low = naive[0] + naive[1] + naive[2] + naive[3];
  const high = naive[4] + naive[5];
  assert.ok(low / 4 > high / 2, 'expected the low residues to be over-represented');
});

test('modulo over a byte for a large range is grossly biased', () => {
  // 256 mod 200 leaves 56, so the first 56 values are twice as likely as the
  // rest. This is the version of the bug that ships in real code.
  const rng = makeGenerators();
  const naive = tally(200, () => rng.randomBytes(1)[0] % 200, 400_000);
  const stat = chiSquareUniform(naive);

  assert.ok(stat > CHI2_CRITICAL_1E5[199] * 10, `expected gross failure, got ${stat.toFixed(2)}`);
  assert.ok(naive[0] > naive[199] * 1.5, 'expected the first residues to dominate');
});

test('comparator shuffling does not produce uniform permutations', () => {
  // sort(() => random() - 0.5) is the most copied shuffle on the internet. The
  // result depends on the engine's sort algorithm and is never uniform.
  const rng = makeGenerators();
  const source = ['a', 'b', 'c', 'd'];
  const index = new Map();
  const permutations = [];
  permute(source, [], permutations);
  permutations.forEach((p, i) => index.set(p.join(''), i));

  const naive = tally(
    24,
    () => index.get(source.slice().sort(() => rng.random() - 0.5).join('')),
    240_000,
  );
  const naiveStat = chiSquareUniform(naive);

  const correct = tally(24, () => index.get(rng.shuffle(source).join('')), 240_000);
  const correctStat = chiSquareUniform(correct);

  assert.ok(
    naiveStat > CHI2_CRITICAL_1E5[23],
    `comparator shuffle should fail but scored ${naiveStat.toFixed(2)}`,
  );
  assert.ok(
    correctStat < CHI2_CRITICAL_1E5[23],
    `Fisher-Yates should pass but scored ${correctStat.toFixed(2)}`,
  );
});

test('the modulo bias depends on draw width, which is why width is the wrong thing to rely on', () => {
  // The same shortcut, same range, wider draw. 65536 mod 6 also leaves 4, but
  // now the skew is one part in 10922 rather than one part in 42, and two
  // million draws cannot see it.
  //
  // That is the real argument for rejection sampling. The shortcut is not
  // "wrong below some width and fine above it": it is always wrong, and whether
  // it happens to be observable depends on the range, the width and the sample
  // size, three things a caller should never have to reason about. Rejection
  // sampling is exactly uniform at every width, so the question never arises.
  const rng = makeGenerators();
  const draws = 2_000_000;

  const wide = tally(
    6,
    () => {
      const bytes = rng.randomBytes(2);
      return (((bytes[0] << 8) | bytes[1]) >>> 0) % 6;
    },
    draws,
  );
  const wideStat = chiSquareUniform(wide);

  // Undetectable here, despite being biased in principle.
  assert.ok(
    wideStat < CHI2_CRITICAL_1E5[5],
    `16-bit modulo is not expected to be detectable, but scored ${wideStat.toFixed(2)}`,
  );

  // The identical shortcut over a single byte, at a quarter of the sample size,
  // fails comfortably. Only the width changed.
  const narrow = tally(6, () => rng.randomBytes(1)[0] % 6, draws / 4);
  assert.ok(
    chiSquareUniform(narrow) > CHI2_CRITICAL_1E5[5],
    'byte modulo should still be detectable',
  );
});

function permute(remaining, prefix, out) {
  if (remaining.length === 0) {
    out.push(prefix);
    return;
  }
  for (let i = 0; i < remaining.length; i++) {
    permute([...remaining.slice(0, i), ...remaining.slice(i + 1)], [...prefix, remaining[i]], out);
  }
}
