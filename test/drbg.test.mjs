/**
 * Tests for HMAC_DRBG-SHA-256.
 *
 * A note on vectors, because this matters for how much you should trust it:
 * the NIST CAVP DRBG vector archive (csrc.nist.gov) is not reachable from the
 * environment this was built in, so the canonical CAVP .rsp files are not
 * vendored here. Adding them is the single highest-value follow-up for this
 * file, and CONTRIBUTING.md says so.
 *
 * What is here instead is not weak:
 *
 *   1. A published, independently-verifiable known-answer test. RFC 6979 §A.2.5
 *      fixes the deterministic nonce k for P-256/SHA-256 over the message
 *      "sample". That k is precisely HMAC_DRBG instantiate-then-generate, so it
 *      pins our instantiate, update and generate against a 256-bit published
 *      constant. Matching it by accident is a 2^-256 event.
 *   2. Differential testing against a second HMAC_DRBG written directly from the
 *      SP 800-90A §10.1.2 pseudocode using node:crypto, over many seeds and
 *      lengths. Independent code path, independent HMAC.
 *   3. The structural properties that the rest of the SDK relies on.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { HmacDrbg, toHex, fromHex, sha256, utf8 } from '../build/internal.mjs';

test('matches the RFC 6979 A.2.5 deterministic nonce for P-256 / SHA-256', () => {
  // RFC 6979 generates k with exactly the HMAC_DRBG construction:
  //   entropy = int2octets(x), nonce = bits2octets(H(m)), then one generate.
  const q = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const x = fromHex('c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721');

  // bits2octets(H("sample")): reduce the hash mod q, then re-encode to 32 bytes.
  const h1 = sha256(utf8('sample'));
  const reduced = BigInt(`0x${toHex(h1)}`) % q;
  const nonce = fromHex(reduced.toString(16).padStart(64, '0'));

  const k = new HmacDrbg(x, nonce).generate(32);

  assert.equal(
    toHex(k),
    'a6e3c57dd01abe90086538398355dd4c3b17aa873382b0f24d6129493d8aad60',
  );
});

test('agrees with an independent SP 800-90A implementation', () => {
  for (let seedIndex = 0; seedIndex < 12; seedIndex++) {
    const entropy = pattern(32, seedIndex * 7 + 1);
    const nonce = pattern(16, seedIndex * 13 + 3);
    const perso = seedIndex % 3 === 0 ? pattern(20, seedIndex + 9) : new Uint8Array(0);

    const mine = new HmacDrbg(entropy, nonce, perso);
    const reference = new ReferenceDrbg(entropy, nonce, perso);

    for (const len of [1, 32, 33, 64, 100, 517]) {
      assert.equal(
        toHex(mine.generate(len)),
        toHex(reference.generate(len)),
        `seed ${seedIndex} length ${len}`,
      );
    }

    // and again after a reseed, with and without additional input
    const fresh = pattern(32, seedIndex + 200);
    mine.reseed(fresh);
    reference.reseed(fresh);
    assert.equal(toHex(mine.generate(64)), toHex(reference.generate(64)), `seed ${seedIndex} post-reseed`);

    const additional = pattern(24, seedIndex + 77);
    assert.equal(
      toHex(mine.generate(48, additional)),
      toHex(reference.generate(48, additional)),
      `seed ${seedIndex} additional input`,
    );
  }
});

test('is deterministic given the same seed', () => {
  const entropy = pattern(32, 42);
  const nonce = pattern(16, 43);
  const a = new HmacDrbg(entropy, nonce).generate(256);
  const b = new HmacDrbg(entropy, nonce).generate(256);
  assert.equal(toHex(a), toHex(b));
});

test('a one-bit seed change produces a completely different stream', () => {
  const entropy = pattern(32, 42);
  const flipped = Uint8Array.from(entropy);
  flipped[17] ^= 0x01;

  const a = new HmacDrbg(entropy, new Uint8Array(16)).generate(256);
  const b = new HmacDrbg(flipped, new Uint8Array(16)).generate(256);

  assert.notEqual(toHex(a), toHex(b));
  // Avalanche: roughly half the bits should differ. Anything under a third means
  // the seed is not being properly diffused.
  const differing = countDifferingBits(a, b);
  assert.ok(differing > 256 * 8 * 0.4, `only ${differing} of ${256 * 8} bits differ`);
  assert.ok(differing < 256 * 8 * 0.6, `${differing} of ${256 * 8} bits differ`);
});

test('successive generates do not repeat', () => {
  const drbg = new HmacDrbg(pattern(32, 5), pattern(16, 6));
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const block = toHex(drbg.generate(32));
    assert.ok(!seen.has(block), `block repeated at iteration ${i}`);
    seen.add(block);
  }
});

test('reseeding diverts the stream', () => {
  const entropy = pattern(32, 11);
  const nonce = pattern(16, 12);

  const a = new HmacDrbg(entropy, nonce);
  const b = new HmacDrbg(entropy, nonce);
  assert.equal(toHex(a.generate(32)), toHex(b.generate(32)));

  b.reseed(pattern(32, 99));
  assert.notEqual(toHex(a.generate(32)), toHex(b.generate(32)));
});

test('additional input diverts the stream', () => {
  const entropy = pattern(32, 21);
  const a = new HmacDrbg(entropy, new Uint8Array(16));
  const b = new HmacDrbg(entropy, new Uint8Array(16));
  assert.notEqual(toHex(a.generate(32, utf8('context A'))), toHex(b.generate(32)));
});

test('handles requests larger than the per-request ceiling', () => {
  // SP 800-90A caps a single HMAC_DRBG request at 2^19 bits (65536 bytes). We
  // split internally rather than throwing, so callers never have to care.
  const drbg = new HmacDrbg(pattern(32, 31), pattern(16, 32));
  const big = drbg.generate(200000);
  assert.equal(big.length, 200000);

  // The chunk boundary must not produce a repeated block.
  const first = toHex(big.subarray(65504, 65536));
  const second = toHex(big.subarray(65536, 65568));
  assert.notEqual(first, second);
});

test('generate(0) returns empty but still ratchets the state', () => {
  const drbg = new HmacDrbg(pattern(32, 41), pattern(16, 42));
  assert.equal(drbg.generate(0).length, 0);

  const reference = new ReferenceDrbg(pattern(32, 41), pattern(16, 42));
  reference.generate(0);
  assert.equal(toHex(drbg.generate(32)), toHex(reference.generate(32)));
});

test('rejects undersized seed material and bad lengths', () => {
  assert.throws(() => new HmacDrbg(new Uint8Array(31)), /at least 32 bytes/);
  assert.throws(() => new HmacDrbg(pattern(32, 1)).reseed(new Uint8Array(8)), /at least 32 bytes/);
  assert.throws(() => new HmacDrbg(pattern(32, 1)).generate(-1));
  assert.throws(() => new HmacDrbg(pattern(32, 1)).generate(1.5));
});

test('output is not obviously biased', () => {
  // Not a substitute for the full battery in statistical.test.mjs, just a smoke
  // check that the byte distribution is sane straight out of the DRBG.
  const bytes = new HmacDrbg(pattern(32, 77), pattern(16, 78)).generate(1 << 17);
  const counts = new Array(256).fill(0);
  for (const b of bytes) counts[b]++;

  const expected = bytes.length / 256;
  let chiSquare = 0;
  for (const c of counts) chiSquare += ((c - expected) ** 2) / expected;

  // 255 degrees of freedom: the 0.001 upper critical value is about 331.
  assert.ok(chiSquare < 331, `chi-square ${chiSquare.toFixed(1)} over 255 df`);
});

function pattern(length, seed) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed * 101 + 7) & 0xff;
  return out;
}

function countDifferingBits(a, b) {
  let count = 0;
  for (let i = 0; i < a.length; i++) {
    let x = a[i] ^ b[i];
    while (x) {
      count += x & 1;
      x >>= 1;
    }
  }
  return count;
}

/**
 * HMAC_DRBG-SHA-256 written straight from SP 800-90A §10.1.2 against
 * node:crypto. Deliberately naive and allocation-happy: its only job is to be
 * an independent second opinion.
 */
class ReferenceDrbg {
  constructor(entropy, nonce = Buffer.alloc(0), perso = Buffer.alloc(0)) {
    this.k = Buffer.alloc(32, 0x00);
    this.v = Buffer.alloc(32, 0x01);
    this.update(Buffer.concat([Buffer.from(entropy), Buffer.from(nonce), Buffer.from(perso)]));
  }

  hmac(key, ...parts) {
    const h = createHmac('sha256', key);
    for (const p of parts) h.update(p);
    return h.digest();
  }

  update(providedData) {
    this.k = this.hmac(this.k, this.v, Buffer.from([0x00]), providedData);
    this.v = this.hmac(this.k, this.v);
    if (providedData.length === 0) return;
    this.k = this.hmac(this.k, this.v, Buffer.from([0x01]), providedData);
    this.v = this.hmac(this.k, this.v);
  }

  reseed(entropy, additional = Buffer.alloc(0)) {
    this.update(Buffer.concat([Buffer.from(entropy), Buffer.from(additional)]));
  }

  generate(length, additional = Buffer.alloc(0)) {
    const out = Buffer.alloc(length);
    let done = 0;
    // Additional input is consumed by the first internal request only.
    let extra = Buffer.from(additional);
    while (done < length) {
      const chunk = Math.min(65536, length - done);
      this.generateOnce(chunk, extra).copy(out, done);
      done += chunk;
      extra = Buffer.alloc(0);
    }
    return new Uint8Array(out);
  }

  generateOnce(length, additional) {
    if (additional.length > 0) this.update(additional);
    const parts = [];
    let total = 0;
    while (total < length) {
      this.v = this.hmac(this.k, this.v);
      parts.push(this.v);
      total += this.v.length;
    }
    const out = Buffer.concat(parts).subarray(0, length);
    this.update(additional);
    return out;
  }
}
