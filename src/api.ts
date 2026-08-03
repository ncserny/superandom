/**
 * The public generator surface.
 *
 * Every function here draws from Engine.randomBytes(), so everything inherits
 * the platform fold. The only interesting work is turning uniform bytes into
 * uniform values of other shapes without introducing bias, which is where most
 * randomness libraries quietly go wrong.
 */

import type { Engine } from './engine.js';
import { toHex } from './encoding.js';

/** Bitcoin's base58: no 0, O, I or l, so a transcribed string is unambiguous. */
export const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const TWO_32 = 2 ** 32;
const TWO_53 = 2 ** 53;

export class Generators {
  private gaussianSpare: number | null = null;

  constructor(protected readonly engine: Engine) {}

  randomBytes(length: number): Uint8Array {
    return this.engine.randomBytes(length);
  }

  /**
   * A float in [0, 1) with the full 53 bits of mantissa.
   *
   * The common `readUint32() / 2**32` gives only 32 distinct values per unit
   * interval, which is visible in any simulation that leans on the low bits.
   */
  random(): number {
    const bytes = this.engine.randomBytes(8);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const hi = view.getUint32(0, false) >>> 5; // 27 bits
    const lo = view.getUint32(4, false) >>> 6; // 26 bits
    return (hi * 2 ** 26 + lo) / TWO_53;
  }

  /**
   * A uniform integer in [min, maxExclusive), by rejection sampling.
   *
   * The shortcut `value % range` is biased towards the low end whenever `range`
   * does not divide the source's cardinality. How bad that is depends entirely
   * on how many bits you draw, and it is worth being precise rather than
   * alarmist: over a full 32-bit draw with a small range the skew is on the
   * order of 2^-30 and nothing will ever observe it, whereas the very common
   * `randomBytes(1)[0] % range` is off by several percent and trivially
   * detectable. bias.test.mjs measures both.
   *
   * Rejection sampling removes the bias exactly, at every width, so there is no
   * threshold to reason about and no range where the shortcut quietly becomes
   * unacceptable. We draw the smallest number of bits covering the range and
   * redraw on overflow: expected iterations are under two, and the chance of
   * needing k or more falls off as 2^-k.
   */
  randomInt(min: number, maxExclusive: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(maxExclusive)) {
      throw new Error('superandom: randomInt bounds must be integers');
    }
    const range = maxExclusive - min;
    if (range <= 0) {
      throw new Error('superandom: randomInt requires maxExclusive > min');
    }
    if (range === 1) return min;

    // Beyond 2^32 the masking has to happen in BigInt to stay exact.
    if (range > TWO_32) {
      return min + Number(this.randomBigInt(BigInt(range)));
    }

    const bits = Math.ceil(Math.log2(range));
    const shift = 32 - bits;
    for (;;) {
      const bytes = this.engine.randomBytes(4);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      // Take the top `bits` bits. Unsigned shift keeps this in [0, 2^bits).
      const candidate = view.getUint32(0, false) >>> shift;
      if (candidate < range) return min + candidate;
    }
  }

  /** A uniform BigInt in [0, maxExclusive), by the same rejection scheme. */
  randomBigInt(maxExclusive: bigint): bigint {
    if (typeof maxExclusive !== 'bigint') {
      throw new Error('superandom: randomBigInt requires a bigint bound');
    }
    if (maxExclusive <= 0n) {
      throw new Error('superandom: randomBigInt requires maxExclusive > 0');
    }
    if (maxExclusive === 1n) return 0n;

    const bits = (maxExclusive - 1n).toString(2).length;
    const byteLength = Math.ceil(bits / 8);
    const discard = BigInt(byteLength * 8 - bits);

    for (;;) {
      const bytes = this.engine.randomBytes(byteLength);
      const candidate = BigInt(`0x${toHex(bytes)}`) >> discard;
      if (candidate < maxExclusive) return candidate;
    }
  }

  /**
   * An RFC 9562 version 4 UUID.
   *
   * Deliberately not delegating to crypto.randomUUID(): that requires a secure
   * context, and this SDK is meant to keep working on a plain-HTTP intranet.
   */
  randomUUID(): string {
    const bytes = this.engine.randomBytes(16);
    bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40; // version 4
    bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // variant 10
    const hex = toHex(bytes);
    return (
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
      `${hex.slice(16, 20)}-${hex.slice(20)}`
    );
  }

  /** A string of `length` characters drawn uniformly from `alphabet`. */
  randomString(length: number, alphabet: string = BASE58): string {
    if (!Number.isInteger(length) || length < 0) {
      throw new Error('superandom: randomString length must be a non-negative integer');
    }
    const chars = [...alphabet];
    if (chars.length < 2) {
      throw new Error('superandom: randomString needs an alphabet of at least 2 characters');
    }
    let out = '';
    for (let i = 0; i < length; i++) out += chars[this.randomInt(0, chars.length)];
    return out;
  }

  choice<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('superandom: choice needs a non-empty array');
    return items[this.randomInt(0, items.length)] as T;
  }

  /** `k` distinct elements, chosen uniformly, order randomised. */
  sample<T>(items: readonly T[], k: number): T[] {
    if (!Number.isInteger(k) || k < 0) {
      throw new Error('superandom: sample size must be a non-negative integer');
    }
    if (k > items.length) {
      throw new Error(`superandom: cannot sample ${k} from ${items.length} items`);
    }
    // Partial Fisher-Yates: shuffle only the first k positions.
    const pool = items.slice();
    for (let i = 0; i < k; i++) {
      const j = this.randomInt(i, pool.length);
      const tmp = pool[i] as T;
      pool[i] = pool[j] as T;
      pool[j] = tmp;
    }
    pool.length = k;
    return pool;
  }

  /** Fisher-Yates over a copy. */
  shuffle<T>(items: readonly T[]): T[] {
    return this.shuffleInPlace(items.slice());
  }

  /**
   * Fisher-Yates in place.
   *
   * The swap index must be uniform over [0, i], which is exactly what
   * randomInt gives. Using a biased index here, or the widely copied
   * `sort(() => random() - 0.5)`, produces a visibly non-uniform permutation
   * distribution. api.test.mjs checks all 24 permutations of a 4-element array.
   */
  shuffleInPlace<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.randomInt(0, i + 1);
      const tmp = items[i] as T;
      items[i] = items[j] as T;
      items[j] = tmp;
    }
    return items;
  }

  /** One item, with probability proportional to its weight. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    if (items.length === 0) throw new Error('superandom: weighted needs a non-empty array');
    if (items.length !== weights.length) {
      throw new Error('superandom: weighted needs one weight per item');
    }

    let total = 0;
    for (const w of weights) {
      if (!Number.isFinite(w) || w < 0) {
        throw new Error('superandom: weights must be finite and non-negative');
      }
      total += w;
    }
    if (total <= 0) throw new Error('superandom: weights must sum to more than zero');

    let threshold = this.random() * total;
    for (let i = 0; i < items.length; i++) {
      threshold -= weights[i] as number;
      if (threshold < 0) return items[i] as T;
    }
    // Only reachable through floating-point drift at the very top of the range.
    return items[items.length - 1] as T;
  }

  /** Normal deviate via the Marsaglia polar method, which yields two at a time. */
  gaussian(mean = 0, stdDev = 1): number {
    if (this.gaussianSpare !== null) {
      const spare = this.gaussianSpare;
      this.gaussianSpare = null;
      return mean + stdDev * spare;
    }
    let u: number;
    let v: number;
    let s: number;
    do {
      u = this.random() * 2 - 1;
      v = this.random() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);

    const factor = Math.sqrt((-2 * Math.log(s)) / s);
    this.gaussianSpare = v * factor;
    return mean + stdDev * u * factor;
  }

  exponential(lambda = 1): number {
    if (!(lambda > 0)) throw new Error('superandom: exponential needs lambda > 0');
    // random() is [0, 1), so 1 - random() is (0, 1] and log() never sees zero.
    return -Math.log(1 - this.random()) / lambda;
  }
}
