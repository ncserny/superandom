/**
 * Entropy accumulator: an eight-pool Fortuna variant.
 *
 * Why pools rather than one running hash. The obvious design is
 * `state = H(state || event)`. It has a well-known failure: an attacker who
 * learns the state once and then observes low-rate input can brute-force each
 * small increment and stay synchronised forever. Fortuna's multi-pool structure
 * fixes that *without requiring the entropy estimate to be correct*, which is
 * the property that matters here, because estimating the entropy of a mouse is
 * guesswork. Pool i is only drained on reseeds where `reseedIndex mod 2^i == 0`,
 * so the slow pools keep accumulating unobserved material until they eventually
 * contain more than an attacker can search, no matter how badly calibrated the
 * estimator is.
 *
 * Eight pools rather than Fortuna's thirty-two: 32 is sized for a daemon running
 * for years. A page session performs tens of reseeds, not billions. Eight covers
 * 128 reseeds before pool 7 first drains, and keeps the state at 256 bytes.
 */

import { sha256, SHA256_DIGEST_SIZE } from './sha256.js';
import { u8, u32le, utf8 } from './encoding.js';
import { SOURCE_TAG, type SourceId } from './types.js';

export const POOL_COUNT = 8;

/**
 * Event handlers write framed records here and return. Hashing happens later,
 * off the input path. This is the single most important performance decision in
 * the SDK: SHA-256 inside a pointermove handler at 120 Hz would be visible.
 */
const STAGING_BYTES = 4096;

const HARVEST_DOMAIN = utf8('superandom/v1/harvest');

export class Accumulator {
  private readonly pools: Uint8Array[] = Array.from(
    { length: POOL_COUNT },
    () => new Uint8Array(SHA256_DIGEST_SIZE),
  );

  private readonly staging = new Uint8Array(STAGING_BYTES);
  private stagingLen = 0;

  /** Round-robin cursor. Consecutive samples land in different pools. */
  private cursor = 0;

  private absorbed = 0;
  private staged = 0;

  /**
   * Queue material for the pools. Cheap and allocation-free: it copies into the
   * staging buffer and returns.
   *
   * The framing is `tag || u32le(length) || bytes`, which makes the encoding
   * injective. Without the length prefix, absorbing ("ab", "c") and ("a", "bc")
   * would produce identical pool input, and an attacker who controls chunk
   * boundaries could force collisions between distinct event streams.
   */
  absorb(id: SourceId, bytes: Uint8Array): void {
    const tag = SOURCE_TAG[id];
    const frameLength = 5 + bytes.length;

    // A record too large to ever stage goes straight into a pool.
    if (frameLength > STAGING_BYTES) {
      this.mix(tag, bytes);
      return;
    }
    if (this.stagingLen + frameLength > STAGING_BYTES) this.flush();

    this.staging[this.stagingLen] = tag;
    this.staging.set(u32le(bytes.length), this.stagingLen + 1);
    this.staging.set(bytes, this.stagingLen + 5);
    this.stagingLen += frameLength;
    this.staged++;
  }

  /** Drain the staging buffer into the pools. Safe to call at any time. */
  flush(): void {
    let at = 0;
    while (at < this.stagingLen) {
      const tag = this.staging[at] as number;
      const length =
        (this.staging[at + 1] as number) |
        ((this.staging[at + 2] as number) << 8) |
        ((this.staging[at + 3] as number) << 16) |
        ((this.staging[at + 4] as number) << 24);
      this.mix(tag, this.staging.subarray(at + 5, at + 5 + length));
      at += 5 + length;
    }
    this.stagingLen = 0;
  }

  private mix(tag: number, bytes: Uint8Array): void {
    const pool = this.cursor;
    this.pools[pool] = sha256(
      this.pools[pool] as Uint8Array,
      u8(tag),
      u32le(bytes.length),
      bytes,
    );
    this.cursor = (this.cursor + 1) % POOL_COUNT;
    this.absorbed++;
  }

  /**
   * Produce seed material for reseed number `reseedIndex` (1-based) and reset
   * the pools it consumed.
   *
   * Pool i participates when `reseedIndex mod 2^i == 0`. Because divisibility by
   * 2^i implies divisibility by every smaller power, the qualifying pools are
   * always a prefix, so the loop can stop at the first miss.
   */
  harvest(reseedIndex: number): Uint8Array {
    if (!Number.isInteger(reseedIndex) || reseedIndex < 1) {
      throw new Error('superandom: reseedIndex must be a positive integer');
    }
    this.flush();

    const parts: Uint8Array[] = [HARVEST_DOMAIN, u32le(reseedIndex)];
    for (let i = 0; i < POOL_COUNT; i++) {
      if (reseedIndex % 2 ** i !== 0) break;
      parts.push(u8(i), this.pools[i] as Uint8Array);
      // Reset the drained pool. Its contribution is now in the DRBG seed, and
      // keeping it would let one sample influence many reseeds.
      this.pools[i] = new Uint8Array(SHA256_DIGEST_SIZE);
    }
    return sha256(...parts);
  }

  /** How many pools reseed number `reseedIndex` will drain. Exposed for tests and stats. */
  static poolsDrainedAt(reseedIndex: number): number {
    let count = 0;
    while (count < POOL_COUNT && reseedIndex % 2 ** count === 0) count++;
    return count;
  }

  /** Diagnostics only. Never feed this to a caller: it is pool state. */
  debugState(): { absorbed: number; staged: number; pending: number; cursor: number } {
    return {
      absorbed: this.absorbed,
      staged: this.staged,
      pending: this.stagingLen,
      cursor: this.cursor,
    };
  }

  /**
   * A commitment to current pool contents, for tests that need to prove two
   * absorb sequences differ. One-way, so it leaks nothing an attacker could use.
   */
  fingerprint(): Uint8Array {
    this.flush();
    return sha256(utf8('superandom/v1/fingerprint'), ...this.pools);
  }
}
