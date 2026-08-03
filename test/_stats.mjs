/**
 * Statistical machinery for the randomness battery.
 *
 * Test-only. These are textbook numerical routines (erfc via the Chebyshev fit
 * from Numerical Recipes, the regularised incomplete gamma via the usual
 * series/continued-fraction split) and the NIST SP 800-22 tests built on them.
 */

const ERFC_COEFFICIENTS = [
  -1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2, -9.561514786808631e-3,
  -9.46595344482036e-4, 3.66839497852761e-4, 4.2523324806907e-5, -2.0278578112534e-5,
  -1.624290004647e-6, 1.30365583558e-6, 1.5626441722e-8, -8.5238095915e-8, 6.529054439e-9,
  5.059343495e-9, -9.91364156e-10, -2.27365122e-10, 9.6467911e-11, 2.394038e-12,
  -6.886027e-12, 8.94487e-13, 3.13092e-13, -1.12708e-13, 3.81e-16, 7.106e-15,
];

export function erfc(x) {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;
  let d = 0;
  let dd = 0;
  for (let j = ERFC_COEFFICIENTS.length - 1; j > 0; j--) {
    const tmp = d;
    d = ty * d - dd + ERFC_COEFFICIENTS[j];
    dd = tmp;
  }
  const ans = t * Math.exp(-z * z + 0.5 * (ERFC_COEFFICIENTS[0] + ty * d) - dd);
  return x >= 0 ? ans : 2 - ans;
}

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

function lgamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  const z = x - 1;
  let sum = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i++) sum += LANCZOS[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** Regularised lower incomplete gamma P(a, x), by series expansion. */
function igamLower(a, x) {
  let term = 1 / a;
  let sum = term;
  for (let n = 1; n < 1000; n++) {
    term *= x / (a + n);
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
}

/** Regularised upper incomplete gamma Q(a, x), by continued fraction. */
function igamUpperCF(a, x) {
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}

/** Q(a, x): the chi-square upper-tail p-value is igamc(df/2, stat/2). */
export function igamc(a, x) {
  if (x <= 0) return 1;
  if (a <= 0) return 0;
  return x < a + 1 ? 1 - igamLower(a, x) : igamUpperCF(a, x);
}

export function chiSquarePValue(statistic, degreesOfFreedom) {
  return igamc(degreesOfFreedom / 2, statistic / 2);
}

/** Expand bytes to a bit array, most significant bit first. */
export function toBits(bytes) {
  const bits = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) {
    for (let b = 0; b < 8; b++) bits[i * 8 + b] = (bytes[i] >>> (7 - b)) & 1;
  }
  return bits;
}

/** SP 800-22 2.1 Frequency (Monobit). */
export function monobit(bits) {
  let sum = 0;
  for (const bit of bits) sum += bit === 1 ? 1 : -1;
  const sObs = Math.abs(sum) / Math.sqrt(bits.length);
  return { name: 'monobit', p: erfc(sObs / Math.SQRT2) };
}

/** SP 800-22 2.2 Frequency within a Block. */
export function blockFrequency(bits, blockSize = 128) {
  const blocks = Math.floor(bits.length / blockSize);
  let sum = 0;
  for (let i = 0; i < blocks; i++) {
    let ones = 0;
    for (let j = 0; j < blockSize; j++) ones += bits[i * blockSize + j];
    const pi = ones / blockSize;
    sum += (pi - 0.5) ** 2;
  }
  const statistic = 4 * blockSize * sum;
  return { name: 'blockFrequency', p: chiSquarePValue(statistic, blocks) };
}

/** SP 800-22 2.3 Runs. */
export function runs(bits) {
  const n = bits.length;
  let ones = 0;
  for (const bit of bits) ones += bit;
  const pi = ones / n;

  // The test is only meaningful once the sequence has passed monobit.
  if (Math.abs(pi - 0.5) >= 2 / Math.sqrt(n)) return { name: 'runs', p: 0 };

  let observed = 1;
  for (let i = 1; i < n; i++) if (bits[i] !== bits[i - 1]) observed++;

  const numerator = Math.abs(observed - 2 * n * pi * (1 - pi));
  const denominator = 2 * Math.sqrt(2 * n) * pi * (1 - pi);
  return { name: 'runs', p: erfc(numerator / denominator) };
}

/**
 * SP 800-22 2.4 Longest Run of Ones in a Block, with M = 128.
 * Category bounds and probabilities are the ones the standard tabulates for M = 128.
 */
export function longestRun(bits) {
  const M = 128;
  const blocks = Math.floor(bits.length / M);
  const probabilities = [0.1174, 0.243, 0.2493, 0.1752, 0.1027, 0.1124];
  const counts = new Array(6).fill(0);

  for (let i = 0; i < blocks; i++) {
    let longest = 0;
    let current = 0;
    for (let j = 0; j < M; j++) {
      if (bits[i * M + j] === 1) {
        current++;
        if (current > longest) longest = current;
      } else {
        current = 0;
      }
    }
    const category = Math.min(Math.max(longest, 4), 9) - 4;
    counts[category]++;
  }

  let statistic = 0;
  for (let i = 0; i < 6; i++) {
    const expected = blocks * probabilities[i];
    statistic += ((counts[i] - expected) ** 2) / expected;
  }
  return { name: 'longestRun', p: chiSquarePValue(statistic, 5) };
}

/** Chi-square over the 256 possible byte values. */
export function byteDistribution(bytes) {
  const counts = new Array(256).fill(0);
  for (const b of bytes) counts[b]++;
  const expected = bytes.length / 256;
  let statistic = 0;
  for (const c of counts) statistic += ((c - expected) ** 2) / expected;
  return { name: 'byteDistribution', p: chiSquarePValue(statistic, 255) };
}

/**
 * Lag-1 serial correlation over the byte stream. Reported as a two-sided
 * p-value, since r is asymptotically normal with sd 1/sqrt(n).
 */
export function serialCorrelation(bytes) {
  const n = bytes.length - 1;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  let sumYY = 0;
  for (let i = 0; i < n; i++) {
    const x = bytes[i];
    const y = bytes[i + 1];
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
    sumYY += y * y;
  }
  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY));
  const r = denominator === 0 ? 0 : numerator / denominator;
  const z = Math.abs(r) * Math.sqrt(n);
  return { name: 'serialCorrelation', p: erfc(z / Math.SQRT2), r };
}

/** Run the whole battery over a byte buffer. */
export function battery(bytes) {
  const bits = toBits(bytes);
  return [
    monobit(bits),
    blockFrequency(bits),
    runs(bits),
    longestRun(bits),
    byteDistribution(bytes),
    serialCorrelation(bytes),
  ];
}
