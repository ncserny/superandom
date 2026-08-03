/**
 * SHA-256, HMAC-SHA-256 and HKDF-SHA-256.
 *
 * Why vendor a hash when the platform ships one? Because `crypto.subtle` is
 * Promise-only in browsers, and an async hash forces an async `random()`. An
 * async `random()` cannot be used in `shuffle()`, in a render loop, or inline in
 * an expression, so developers would keep `Math.random()` for the hot path and
 * reach for this only for ceremony. That defeats the entire point of the SDK.
 *
 * This costs ~1.5 KiB minified. Every function here is covered by known-answer
 * tests against FIPS 180-4, RFC 4231 and RFC 5869 in test/sha256.test.mjs.
 * Do not touch this file without adding vectors.
 *
 * This is a hash, not a secret-dependent branch anywhere: SHA-256 is naturally
 * constant-time on the inputs we feed it.
 */

export const SHA256_BLOCK_SIZE = 64;
export const SHA256_DIGEST_SIZE = 32;

// First 32 bits of the fractional parts of the cube roots of the first 64 primes.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

// First 32 bits of the fractional parts of the square roots of the first 8 primes.
const INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** Streaming SHA-256. Reuses its schedule buffer, so it allocates nothing per block. */
export class Sha256 {
  private readonly h = new Uint32Array(INIT);
  private readonly block = new Uint8Array(SHA256_BLOCK_SIZE);
  private readonly view = new DataView(this.block.buffer);
  private readonly w = new Uint32Array(64);
  private blockLen = 0;
  private totalLen = 0;
  private done = false;

  update(bytes: Uint8Array): this {
    if (this.done) throw new Error('superandom: Sha256 already finalised');
    this.totalLen += bytes.length;

    let offset = 0;
    // Top up a partial block first.
    if (this.blockLen > 0) {
      const need = Math.min(SHA256_BLOCK_SIZE - this.blockLen, bytes.length);
      this.block.set(bytes.subarray(0, need), this.blockLen);
      this.blockLen += need;
      offset = need;
      if (this.blockLen === SHA256_BLOCK_SIZE) {
        this.compress(this.view, 0);
        this.blockLen = 0;
      }
    }

    // Then consume whole blocks straight out of the input, no copying.
    if (bytes.length - offset >= SHA256_BLOCK_SIZE) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      while (bytes.length - offset >= SHA256_BLOCK_SIZE) {
        this.compress(view, offset);
        offset += SHA256_BLOCK_SIZE;
      }
    }

    // Stash the remainder.
    if (offset < bytes.length) {
      this.block.set(bytes.subarray(offset), this.blockLen);
      this.blockLen += bytes.length - offset;
    }
    return this;
  }

  digest(): Uint8Array {
    if (this.done) throw new Error('superandom: Sha256 already finalised');
    this.done = true;

    const bitLen = this.totalLen * 8;
    // Pad: 0x80, zeros, then the 64-bit big-endian bit length.
    this.block[this.blockLen++] = 0x80;
    if (this.blockLen > SHA256_BLOCK_SIZE - 8) {
      this.block.fill(0, this.blockLen);
      this.compress(this.view, 0);
      this.blockLen = 0;
    }
    this.block.fill(0, this.blockLen);
    // Split rather than use BigInt: totalLen is a JS number, and 2^53 bytes is
    // beyond anything this will ever hash, but the high word must still be right.
    this.view.setUint32(56, Math.floor(bitLen / 0x100000000), false);
    this.view.setUint32(60, bitLen >>> 0, false);
    this.compress(this.view, 0);

    const out = new Uint8Array(SHA256_DIGEST_SIZE);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, this.h[i] as number, false);
    return out;
  }

  private compress(view: DataView, offset: number): void {
    const { w, h } = this;

    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number;
      const b = w[i - 2] as number;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }

    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0] as number) + a;
    h[1] = (h[1] as number) + b;
    h[2] = (h[2] as number) + c;
    h[3] = (h[3] as number) + d;
    h[4] = (h[4] as number) + e;
    h[5] = (h[5] as number) + f;
    h[6] = (h[6] as number) + g;
    h[7] = (h[7] as number) + hh;
  }
}

/** One-shot SHA-256 over the concatenation of `parts`, without building the concatenation. */
export function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = new Sha256();
  for (const p of parts) h.update(p);
  return h.digest();
}

/** HMAC-SHA-256 (FIPS 198-1) over the concatenation of `parts`. */
export function hmacSha256(key: Uint8Array, ...parts: Uint8Array[]): Uint8Array {
  // Keys longer than the block size are hashed down; shorter ones are zero-padded.
  const k = new Uint8Array(SHA256_BLOCK_SIZE);
  k.set(key.length > SHA256_BLOCK_SIZE ? sha256(key) : key);

  const inner = new Uint8Array(SHA256_BLOCK_SIZE);
  const outer = new Uint8Array(SHA256_BLOCK_SIZE);
  for (let i = 0; i < SHA256_BLOCK_SIZE; i++) {
    const b = k[i] as number;
    inner[i] = b ^ 0x36;
    outer[i] = b ^ 0x5c;
  }

  const innerHash = new Sha256().update(inner);
  for (const p of parts) innerHash.update(p);

  const out = sha256(outer, innerHash.digest());
  k.fill(0);
  inner.fill(0);
  outer.fill(0);
  return out;
}

/**
 * HKDF-Extract (RFC 5869 §2.2). Condenses arbitrarily structured, biased input
 * into a uniform pseudorandom key.
 *
 * This is the SDK's randomness extractor. It replaces the von Neumann debiasing
 * that a naive entropy harvester would reach for. Von Neumann requires i.i.d.
 * input, and a mouse trajectory is the opposite of i.i.d.: it is smooth and
 * heavily autocorrelated. Running it here would discard ~75% of the throughput
 * while leaving the correlation structure intact. HMAC as a randomness extractor
 * handles arbitrarily structured input given sufficient min-entropy, and is a
 * vetted conditioning component under NIST SP 800-90B §3.1.5.
 */
export function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Uint8Array {
  return hmacSha256(salt, ikm);
}

/** HKDF-Expand (RFC 5869 §2.3). */
export function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  const maxLength = 255 * SHA256_DIGEST_SIZE;
  if (length < 0 || length > maxLength) {
    throw new Error(`superandom: hkdfExpand length must be 0..${maxLength}`);
  }

  const out = new Uint8Array(length);
  let previous: Uint8Array = new Uint8Array(0);
  let at = 0;
  for (let counter = 1; at < length; counter++) {
    previous = hmacSha256(prk, previous, info, new Uint8Array([counter]));
    const take = Math.min(previous.length, length - at);
    out.set(previous.subarray(0, take), at);
    at += take;
  }
  return out;
}
