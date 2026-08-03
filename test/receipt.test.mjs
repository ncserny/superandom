import test from 'node:test';
import assert from 'node:assert/strict';

import { ReceiptLog, verifyReceipt, RECEIPT_VERSION, createCore, toHex } from './.generated/internal.mjs';

function sampleLog() {
  const log = new ReceiptLog('session-1', 'https://example.test', 1_700_000_000_000);
  log.record({
    n: 1,
    at: 1_700_000_000_000,
    creditedBits: 0,
    outputBytesSinceLast: 0,
    contributors: [],
  });
  log.record({
    n: 2,
    at: 1_700_000_030_000,
    creditedBits: 148.5,
    outputBytesSinceLast: 4096,
    contributors: [
      { id: 'pointer', events: 312, creditedBits: 128, healthy: true },
      { id: 'keyboard', events: 40, creditedBits: 20.5, healthy: true },
    ],
  });
  return log;
}

test('a well-formed receipt verifies', () => {
  const receipt = sampleLog().toJSON();
  assert.equal(receipt.version, RECEIPT_VERSION);
  assert.equal(receipt.epochs.length, 2);
  assert.deepEqual(verifyReceipt(receipt), { ok: true });
});

test('the chain links each epoch to its predecessor', () => {
  const receipt = sampleLog().toJSON();
  assert.equal(receipt.epochs[1].prev, receipt.epochs[0].commit);
  assert.equal(receipt.head, receipt.epochs[1].commit);
});

test('mutating any field breaks verification at the right epoch', () => {
  const mutations = [
    ['creditedBits', (e) => { e.creditedBits = 9999; }],
    ['at', (e) => { e.at += 1; }],
    ['outputBytesSinceLast', (e) => { e.outputBytesSinceLast = 0; }],
    ['n', (e) => { e.n = 42; }],
    ['contributor events', (e) => { e.contributors[0].events = 1; }],
    ['contributor credit', (e) => { e.contributors[0].creditedBits = 256; }],
    ['contributor health', (e) => { e.contributors[0].healthy = false; }],
    ['contributor identity', (e) => { e.contributors[0].id = 'motion'; }],
    ['dropped contributor', (e) => { e.contributors.pop(); }],
  ];

  for (const [label, mutate] of mutations) {
    const receipt = sampleLog().toJSON();
    mutate(receipt.epochs[1]);
    const result = verifyReceipt(receipt);
    assert.equal(result.ok, false, `mutating ${label} went undetected`);
    assert.equal(result.brokenAt, receipt.epochs[1].n, `wrong epoch reported for ${label}`);
  }
});

test('tampering with an early epoch breaks the chain from there on', () => {
  const receipt = sampleLog().toJSON();
  receipt.epochs[0].creditedBits = 1000;
  const result = verifyReceipt(receipt);
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 1);
});

test('rewriting a commitment without the chain is detected', () => {
  // The obvious forgery: change a value and patch the commitment to match.
  // It fails because the next epoch still points at the old commitment.
  const receipt = sampleLog().toJSON();
  receipt.epochs[0].commit = 'a'.repeat(64);
  assert.equal(verifyReceipt(receipt).ok, false);
});

test('a tampered head is detected', () => {
  const receipt = sampleLog().toJSON();
  receipt.head = 'b'.repeat(64);
  const result = verifyReceipt(receipt);
  assert.equal(result.ok, false);
  assert.match(result.reason, /head/);
});

test('the genesis digest binds the session identity', () => {
  // Replaying another session's epochs under a different identity must not verify.
  const receipt = sampleLog().toJSON();
  receipt.origin = 'https://attacker.test';
  assert.equal(verifyReceipt(receipt).ok, false);

  const other = sampleLog().toJSON();
  other.id = 'session-2';
  assert.equal(verifyReceipt(other).ok, false);

  const shifted = sampleLog().toJSON();
  shifted.startedAt += 1;
  assert.equal(verifyReceipt(shifted).ok, false);
});

test('malformed receipts are rejected rather than crashing', () => {
  assert.equal(verifyReceipt(null).ok, false);
  assert.equal(verifyReceipt({}).ok, false);
  assert.equal(verifyReceipt({ version: RECEIPT_VERSION }).ok, false);
  assert.equal(verifyReceipt({ version: 'other', epochs: [] }).ok, false);
});

test('the receipt commits to no secret material', () => {
  // A receipt is meant to be publishable. If any seed, pool or output byte were
  // reachable from it, publishing one would be a disclosure.
  const rng = createCore();
  for (let i = 0; i < 400; i++) {
    rng.engine.absorb('pointer', new Uint8Array([i, i * 3, i * 7]), 4, i * 31 + i, true, i * 10);
  }
  rng.reseed();
  const output = rng.randomBytes(256);
  rng.reseed();

  const serialised = JSON.stringify(rng.receipt());

  // No slice of the produced output appears anywhere in the receipt.
  for (let i = 0; i + 8 <= output.length; i += 8) {
    assert.ok(
      !serialised.includes(toHex(output.subarray(i, i + 8))),
      'output bytes leaked into the receipt',
    );
  }
  // Nor does the accumulator's pool state.
  assert.ok(!serialised.includes(toHex(rng.engine.accumulator.fingerprint())));
  // Only hex commitments and counters, nothing that looks like key material.
  assert.match(serialised, /"commit":"[0-9a-f]{64}"/);
});

test('a live receipt records real reseeds and verifies', () => {
  const rng = createCore();
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 100; i++) {
      rng.engine.absorb('pointer', new Uint8Array([round, i]), 4, round * 1000 + i, true, i);
    }
    rng.reseed();
    rng.randomBytes(64);
  }

  const receipt = rng.receipt();
  assert.ok(receipt.epochs.length >= 5, `only ${receipt.epochs.length} epochs`);
  assert.deepEqual(verifyReceipt(receipt), { ok: true });

  // Later epochs name the sources that actually contributed.
  const last = receipt.epochs[receipt.epochs.length - 1];
  assert.ok(last.contributors.some((c) => c.id === 'pointer' && c.events > 0));
});

test('receipts can be disabled', () => {
  const rng = createCore({ receipt: false });
  assert.equal(rng.receipt(), null);
  assert.equal(rng.stats().receiptHead, null);
});
