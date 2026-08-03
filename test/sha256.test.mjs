/**
 * Known-answer tests for the vendored hash core.
 *
 * Vendoring crypto without KATs is malpractice, so this file is the price of
 * admission for sha256.ts. Vectors are from FIPS 180-4 (Appendix B), RFC 4231
 * and RFC 5869. Never adjust a vector to make a test pass.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

import { sha256, hmacSha256, hkdfExtract, hkdfExpand, Sha256 } from '../build/internal.mjs';
import { toHex, fromHex, utf8, equal } from '../build/internal.mjs';

const hex = (bytes) => toHex(bytes);

test('SHA-256 matches FIPS 180-4 vectors', () => {
  assert.equal(
    hex(sha256(utf8(''))),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(
    hex(sha256(utf8('abc'))),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(
    hex(sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
  assert.equal(
    hex(
      sha256(
        utf8(
          'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmno' +
            'ijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
        ),
      ),
    ),
    'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
  );
});

test('SHA-256 handles the one-million-a case', () => {
  const h = new Sha256();
  const chunk = utf8('a'.repeat(1000));
  for (let i = 0; i < 1000; i++) h.update(chunk);
  assert.equal(
    hex(h.digest()),
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
  );
});

test('streaming SHA-256 agrees with one-shot at every chunk boundary', () => {
  // Block-size boundaries are where padding and buffering bugs live, so walk
  // across 0..200 bytes and split each input at every possible point.
  for (const len of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 200]) {
    const input = new Uint8Array(len);
    for (let i = 0; i < len; i++) input[i] = (i * 7 + 13) & 0xff;

    const expected = hex(sha256(input));
    assert.equal(hex(createHash('sha256').update(input).digest()), expected, `len ${len}`);

    for (let split = 0; split <= len; split++) {
      const streamed = new Sha256()
        .update(input.subarray(0, split))
        .update(input.subarray(split))
        .digest();
      assert.equal(hex(streamed), expected, `len ${len} split ${split}`);
    }
  }
});

test('SHA-256 agrees with node:crypto on random inputs', () => {
  // Differential test against an independent implementation, across lengths that
  // straddle the block boundary and beyond.
  for (let len = 0; len < 600; len += 7) {
    const input = new Uint8Array(len);
    for (let i = 0; i < len; i++) input[i] = (i * 31 + len * 17) & 0xff;
    assert.equal(hex(sha256(input)), createHash('sha256').update(input).digest('hex'));
  }
});

test('variadic SHA-256 equals hashing the concatenation', () => {
  const a = utf8('the quick brown fox ');
  const b = utf8('jumps over ');
  const c = utf8('the lazy dog');
  const joined = new Uint8Array(a.length + b.length + c.length);
  joined.set(a, 0);
  joined.set(b, a.length);
  joined.set(c, a.length + b.length);
  assert.equal(hex(sha256(a, b, c)), hex(sha256(joined)));
});

test('HMAC-SHA-256 matches RFC 4231 vectors', () => {
  // Test Case 1
  assert.equal(
    hex(hmacSha256(new Uint8Array(20).fill(0x0b), utf8('Hi There'))),
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
  );
  // Test Case 2: key shorter than the block size
  assert.equal(
    hex(hmacSha256(utf8('Jefe'), utf8('what do ya want for nothing?'))),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
  );
  // Test Case 3
  assert.equal(
    hex(hmacSha256(new Uint8Array(20).fill(0xaa), new Uint8Array(50).fill(0xdd))),
    '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe',
  );
  // Test Case 6: key longer than the block size, so it gets hashed down first
  assert.equal(
    hex(
      hmacSha256(
        new Uint8Array(131).fill(0xaa),
        utf8('Test Using Larger Than Block-Size Key - Hash Key First'),
      ),
    ),
    '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
  );
  // Test Case 7
  assert.equal(
    hex(
      hmacSha256(
        new Uint8Array(131).fill(0xaa),
        utf8(
          'This is a test using a larger than block-size key and a larger than ' +
            'block-size data. The key needs to be hashed before being used by the ' +
            'HMAC algorithm.',
        ),
      ),
    ),
    '9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2',
  );
});

test('HMAC-SHA-256 agrees with node:crypto across key and message lengths', () => {
  for (const keyLen of [0, 1, 32, 63, 64, 65, 100, 200]) {
    for (const msgLen of [0, 1, 55, 64, 200]) {
      const key = new Uint8Array(keyLen);
      for (let i = 0; i < keyLen; i++) key[i] = (i * 11 + 5) & 0xff;
      const msg = new Uint8Array(msgLen);
      for (let i = 0; i < msgLen; i++) msg[i] = (i * 23 + 7) & 0xff;

      assert.equal(
        hex(hmacSha256(key, msg)),
        createHmac('sha256', Buffer.from(key)).update(Buffer.from(msg)).digest('hex'),
        `key ${keyLen} msg ${msgLen}`,
      );
    }
  }
});

test('variadic HMAC equals HMAC over the concatenation', () => {
  const key = new Uint8Array(32).fill(0x5a);
  const a = utf8('alpha');
  const b = utf8('beta');
  const joined = new Uint8Array([...a, ...b]);
  assert.equal(hex(hmacSha256(key, a, b)), hex(hmacSha256(key, joined)));
});

test('HKDF matches RFC 5869 Test Case 1', () => {
  const ikm = new Uint8Array(22).fill(0x0b);
  const salt = fromHex('000102030405060708090a0b0c');
  const info = fromHex('f0f1f2f3f4f5f6f7f8f9');

  const prk = hkdfExtract(salt, ikm);
  assert.equal(hex(prk), '077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5');

  assert.equal(
    hex(hkdfExpand(prk, info, 42)),
    '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
  );
});

test('HKDF matches RFC 5869 Test Case 3, with empty salt and info', () => {
  const ikm = new Uint8Array(22).fill(0x0b);
  const prk = hkdfExtract(new Uint8Array(0), ikm);
  assert.equal(hex(prk), '19ef24a32c717b167f33a91d6f648bdf96596776afdb6377ac434c1c293ccb04');

  assert.equal(
    hex(hkdfExpand(prk, new Uint8Array(0), 42)),
    '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
  );
});

test('HKDF-Expand agrees with node:crypto at many lengths', () => {
  const prk = hkdfExtract(utf8('salt'), utf8('input keying material'));
  const info = utf8('superandom test');
  for (const len of [1, 31, 32, 33, 64, 100, 255 * 32]) {
    const mine = hkdfExpand(prk, info, len);
    assert.equal(mine.length, len);
    // node's hkdfSync does Extract+Expand together, so drive it with a fixed PRK
    // by extracting with an empty salt over our PRK is not equivalent. Compare
    // instead against a direct re-derivation of the RFC 5869 T-chain.
    const expected = expandReference(prk, info, len);
    assert.ok(equal(mine, expected), `length ${len}`);
  }
});

test('HKDF-Expand rejects out-of-range lengths', () => {
  const prk = hkdfExtract(utf8('salt'), utf8('ikm'));
  assert.throws(() => hkdfExpand(prk, new Uint8Array(0), 255 * 32 + 1));
  assert.throws(() => hkdfExpand(prk, new Uint8Array(0), -1));
});

test('finalised Sha256 refuses reuse', () => {
  const h = new Sha256();
  h.update(utf8('x'));
  h.digest();
  assert.throws(() => h.digest());
  assert.throws(() => h.update(utf8('y')));
});

/** RFC 5869 §2.3 T-chain, written independently using node:crypto. */
function expandReference(prk, info, length) {
  const out = Buffer.alloc(length);
  let t = Buffer.alloc(0);
  let at = 0;
  for (let counter = 1; at < length; counter++) {
    t = createHmac('sha256', Buffer.from(prk))
      .update(t)
      .update(Buffer.from(info))
      .update(Buffer.from([counter]))
      .digest();
    const take = Math.min(t.length, length - at);
    t.copy(out, at, 0, take);
    at += take;
  }
  return new Uint8Array(out);
}
