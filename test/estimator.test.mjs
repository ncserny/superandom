import test from 'node:test';
import assert from 'node:assert/strict';

import { Estimator, aptCutoff, SOURCE_LIMITS } from '../build/internal.mjs';

const NO_LIMIT = { rateCapBitsPerSecond: Number.POSITIVE_INFINITY, crossOriginIsolated: false };

/** Distinct sample values, so the health tests never trip during unrelated tests. */
let counter = 0;
const nextSample = () => counter++;

test('a single sample cannot exceed the per-sample cap', () => {
  const est = new Estimator(NO_LIMIT);
  // Ask for 1000 bits from a pointer move, which is capped at 4.
  const credited = est.propose('pointer', 0, 1000, nextSample());
  assert.equal(credited, SOURCE_LIMITS.pointer.maxPerSample);
});

test('a source cannot exceed its session cap', () => {
  const est = new Estimator(NO_LIMIT);
  const cap = SOURCE_LIMITS.keyboard.sessionCap;
  for (let i = 0; i < cap * 3; i++) est.propose('keyboard', i, 1, nextSample());

  const stats = est.snapshot(new Set(['keyboard']));
  const keyboard = stats.find((s) => s.id === 'keyboard');
  assert.equal(keyboard.creditedBits, cap);
  assert.equal(est.creditedBits(), cap);
});

test('the rate limiter holds under an event flood', () => {
  // 64 bits/second, and every event arrives at the same instant. The bucket
  // starts full, so exactly one second of budget is available and no more.
  const est = new Estimator({ rateCapBitsPerSecond: 64, crossOriginIsolated: false });
  for (let i = 0; i < 10000; i++) est.propose('pointer', 0, 4, nextSample());
  assert.equal(est.creditedBits(), 64);
});

test('the rate limiter refills over time', () => {
  const est = new Estimator({ rateCapBitsPerSecond: 64, crossOriginIsolated: false });
  for (let i = 0; i < 1000; i++) est.propose('pointer', 0, 4, nextSample());
  assert.equal(est.creditedBits(), 64);

  // Half a second later, half the budget is back.
  for (let i = 0; i < 1000; i++) est.propose('pointer', 500, 4, nextSample());
  assert.equal(est.creditedBits(), 96);
});

test('untrusted events are mixed but never credited', () => {
  const est = new Estimator(NO_LIMIT);
  for (let i = 0; i < 100; i++) {
    assert.equal(est.propose('pointer', i, 4, nextSample(), false), 0);
  }
  assert.equal(est.creditedBits(), 0);

  // The events are still counted, so stats() shows what happened.
  const pointer = est.snapshot(new Set()).find((s) => s.id === 'pointer');
  assert.equal(pointer.events, 100);
  assert.equal(pointer.creditedBits, 0);
});

test('the repetition count test trips on a stuck source', () => {
  const est = new Estimator(NO_LIMIT);
  // keyboard claims 1 bit per sample, so the RCT cutoff is 1 + ceil(20/1) = 21.
  for (let i = 0; i < 20; i++) est.propose('keyboard', i, 1, 42);
  assert.ok(est.snapshot(new Set()).find((s) => s.id === 'keyboard').healthy);

  est.propose('keyboard', 21, 1, 42);
  const keyboard = est.snapshot(new Set()).find((s) => s.id === 'keyboard');
  assert.equal(keyboard.healthy, false);

  // Once unhealthy, the source earns nothing more, even with fresh samples.
  const before = est.creditedBits();
  for (let i = 0; i < 50; i++) est.propose('keyboard', 100 + i, 1, nextSample());
  assert.equal(est.creditedBits(), before);
});

test('the adaptive proportion test trips on a dominant value', () => {
  const est = new Estimator(NO_LIMIT);
  // Nine samples in ten are the same value, with a noise sample every tenth to
  // keep the longest run at 9 and well under the RCT cutoff of 21. So this can
  // only be caught by the proportion test, not the repetition test.
  //
  // keyboard claims 1 bit per sample, meaning no value should appear much above
  // half the time. Ninety percent is far past the cutoff.
  for (let i = 0; i < 512; i++) {
    est.propose('keyboard', i, 1, i % 10 === 9 ? 100000 + i : 7);
  }
  const keyboard = est.snapshot(new Set()).find((s) => s.id === 'keyboard');
  assert.equal(keyboard.healthy, false);
});

test('the adaptive proportion test tolerates the rate its claim allows', () => {
  const est = new Estimator(NO_LIMIT);
  // The mirror of the test above: at a 1-bit claim, a value showing up half the
  // time is exactly what is expected and must not be flagged.
  for (let i = 0; i < 512; i++) {
    est.propose('keyboard', i, 1, i % 2 === 0 ? 7 : 100000 + i);
  }
  const keyboard = est.snapshot(new Set()).find((s) => s.id === 'keyboard');
  assert.equal(keyboard.healthy, true);
});

test('a healthy varied source stays healthy', () => {
  const est = new Estimator(NO_LIMIT);
  for (let i = 0; i < 5000; i++) est.propose('pointer', i, 2, nextSample());
  const pointer = est.snapshot(new Set()).find((s) => s.id === 'pointer');
  assert.equal(pointer.healthy, true);
});

test('manual material is mixed but structurally uncreditable', () => {
  const est = new Estimator(NO_LIMIT);
  // Caller-supplied bytes have no provenance the SDK can audit, so the cap is 0.
  assert.equal(SOURCE_LIMITS.manual.sessionCap, 0);
  assert.equal(est.propose('manual', 0, 256, nextSample()), 0);
  assert.equal(est.creditedBits(), 0);
});

test('cross-origin isolation raises only the clock caps', () => {
  const plain = new Estimator({ rateCapBitsPerSecond: Infinity, crossOriginIsolated: false });
  const isolated = new Estimator({ rateCapBitsPerSecond: Infinity, crossOriginIsolated: true });

  // performance.now() is clamped to 100us normally, 5us when isolated, so the
  // clock source can carry more there. Nothing else changes.
  assert.equal(isolated.sessionCap('clock'), plain.sessionCap('clock') * 2);
  assert.equal(isolated.sessionCap('pointer'), plain.sessionCap('pointer'));
  assert.equal(isolated.sessionCap('keyboard'), plain.sessionCap('keyboard'));
});

test('every source has a pessimistic, documented cap', () => {
  for (const [id, limits] of Object.entries(SOURCE_LIMITS)) {
    assert.ok(limits.note.length > 20, `${id} needs a real explanation of its cap`);
    if (id === 'platform') continue;
    // Nothing derived from a human or a sensor may claim more than 4 bits
    // per sample. If a future change wants more, it needs a new argument.
    assert.ok(limits.maxPerSample <= 4, `${id} claims ${limits.maxPerSample} bits per sample`);
  }
});

test('aptCutoff is sane and monotonic', () => {
  const w = 512;
  // Lower claimed entropy means a value may legitimately repeat more often, so
  // the cutoff must not decrease as h decreases.
  let previous = 0;
  for (const h of [4, 3, 2, 1, 0.5, 0.25, 0.125]) {
    const c = aptCutoff(w, h);
    assert.ok(c >= 1 && c <= w - 1, `cutoff ${c} out of range for h=${h}`);
    assert.ok(c >= previous, `cutoff fell from ${previous} to ${c} at h=${h}`);
    previous = c;
  }

  // For a fair coin over 511 trials the mean is 255.5 with sd about 11.3, and
  // alpha is 2^-20, so the cutoff should sit roughly five sd above the mean.
  const coin = aptCutoff(512, 1);
  assert.ok(coin > 290 && coin < 330, `unexpected cutoff ${coin} for h=1`);
});
