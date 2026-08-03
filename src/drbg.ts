/**
 * HMAC_DRBG with SHA-256, per NIST SP 800-90A §10.1.2.
 *
 * Chosen over ChaCha20 for one reason: we already vendor SHA-256 and HMAC for
 * the accumulator, so this costs ~40 lines and introduces no second primitive.
 * ChaCha20 generates faster in bulk, but nothing here needs bulk throughput, and
 * a smaller trusted computing base matters more in a hand-rolled crypto core.
 *
 * Backtracking resistance comes free: §10.1.2.5 mandates an Update after every
 * generate, which rotates both K and V. Recovering a past output from the
 * current state means inverting HMAC-SHA-256.
 */

import { hmacSha256, SHA256_DIGEST_SIZE } from './sha256.js';
import { concat } from './encoding.js';

/** SP 800-90A Table 2: max bytes per generate request for HMAC_DRBG is 2^19 bits. */
const MAX_BYTES_PER_REQUEST = 65536;

/** SP 800-90A Table 2 puts this at 2^48. We will never come close in a page session. */
const RESEED_INTERVAL = 0x1000000000000;

const EMPTY = new Uint8Array(0);

export class HmacDrbg {
  private k: Uint8Array = new Uint8Array(SHA256_DIGEST_SIZE); // starts as 0x00 * 32
  private v: Uint8Array = new Uint8Array(SHA256_DIGEST_SIZE).fill(0x01);
  private reseedCounter = 1;

  /**
   * @param entropy         seed material, must carry at least 256 bits of entropy
   * @param nonce           instantiation nonce
   * @param personalization optional domain separator
   */
  constructor(entropy: Uint8Array, nonce: Uint8Array = EMPTY, personalization: Uint8Array = EMPTY) {
    if (entropy.length < 32) {
      throw new Error('superandom: DRBG needs at least 32 bytes of seed material');
    }
    this.update(concat(entropy, nonce, personalization));
    this.reseedCounter = 1;
  }

  /**
   * SP 800-90A §10.1.2.2. Both branches run when providedData is non-empty; the
   * second is skipped when it is empty, which is what makes an empty-input Update
   * a pure state rotation rather than a no-op.
   */
  private update(providedData: Uint8Array): void {
    this.k = hmacSha256(this.k, this.v, new Uint8Array([0x00]), providedData);
    this.v = hmacSha256(this.k, this.v);
    if (providedData.length === 0) return;
    this.k = hmacSha256(this.k, this.v, new Uint8Array([0x01]), providedData);
    this.v = hmacSha256(this.k, this.v);
  }

  /** SP 800-90A §10.1.2.4. */
  reseed(entropy: Uint8Array, additional: Uint8Array = EMPTY): void {
    if (entropy.length < 32) {
      throw new Error('superandom: DRBG reseed needs at least 32 bytes of seed material');
    }
    this.update(concat(entropy, additional));
    this.reseedCounter = 1;
  }

  /**
   * SP 800-90A §10.1.2.5. Requests larger than the spec's per-request ceiling are
   * split across several internal generates rather than rejected, so callers can
   * ask for any length without special-casing.
   */
  generate(length: number, additional: Uint8Array = EMPTY): Uint8Array {
    if (!Number.isInteger(length) || length < 0) {
      throw new Error('superandom: generate length must be a non-negative integer');
    }
    if (this.reseedCounter > RESEED_INTERVAL) {
      throw new Error('superandom: DRBG reseed required');
    }

    const out = new Uint8Array(length);
    let done = 0;
    let extra = additional;
    while (done < length) {
      const chunk = Math.min(MAX_BYTES_PER_REQUEST, length - done);
      out.set(this.generateOnce(chunk, extra), done);
      done += chunk;
      // Additional input is consumed by the first internal request only, matching
      // the semantics of a single spec-level call.
      extra = EMPTY;
    }
    return out;
  }

  private generateOnce(length: number, additional: Uint8Array): Uint8Array {
    if (additional.length > 0) this.update(additional);

    const out = new Uint8Array(length);
    let at = 0;
    while (at < length) {
      this.v = hmacSha256(this.k, this.v);
      const take = Math.min(this.v.length, length - at);
      out.set(this.v.subarray(0, take), at);
      at += take;
    }

    // The mandated post-generate Update. This is the forward-secrecy ratchet:
    // drop it and every past output becomes recoverable from a captured state.
    this.update(additional);
    this.reseedCounter++;
    return out;
  }

  /** Reseed count since instantiation. Exposed for stats, never for seeding. */
  get requests(): number {
    return this.reseedCounter;
  }
}
