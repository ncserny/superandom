/**
 * Scroll and wheel entropy.
 *
 * Wheel deltas are heavily quantised. A notched mouse wheel reports the same
 * fixed step every time, and trackpads quantise to device units, so the delta
 * values themselves carry very little. Nearly all of the entropy here is in
 * when the events arrive, which is why the claim is one bit and the throttle is
 * loose.
 */

import type { CollectorId } from '../types.js';
import { ListenerBag, Scratch, healthSample, isTrusted } from './base.js';
import type { Collector, CollectorContext } from './base.js';

const MIN_INTERVAL_MS = 50;
const SCROLL_BITS = 1;

interface ScrollEventLike {
  isTrusted?: boolean;
  timeStamp?: number;
  deltaX?: number;
  deltaY?: number;
  deltaZ?: number;
  deltaMode?: number;
  target?: { scrollTop?: number; scrollLeft?: number } | null;
}

export function createScrollCollector(): Collector {
  const bag = new ListenerBag();
  const scratch = new Scratch();
  let context: CollectorContext | null = null;
  let lastAt = Number.NEGATIVE_INFINITY;

  const id: CollectorId = 'scroll';

  function onScroll(rawEvent: never): void {
    const event = rawEvent as ScrollEventLike;
    const at = event.timeStamp ?? context?.now() ?? 0;
    const interval = at - lastAt;
    if (interval < MIN_INTERVAL_MS) return;
    lastAt = at;

    scratch
      .reset()
      .f64(at)
      .f64(Number.isFinite(interval) ? interval : 0)
      .f64(event.deltaX ?? 0)
      .f64(event.deltaY ?? 0)
      .f64(event.deltaZ ?? 0)
      .u8(event.deltaMode ?? 0)
      .i32(event.target?.scrollTop ?? 0)
      .i32(event.target?.scrollLeft ?? 0);

    context?.absorb(
      id,
      scratch.bytes(),
      SCROLL_BITS,
      healthSample(Number.isFinite(interval) ? interval : at),
      isTrusted(event),
      at,
    );
  }

  return {
    id,
    start(ctx) {
      context = ctx;
      bag.add(ctx.target, 'scroll', onScroll);
      bag.add(ctx.target, 'wheel', onScroll);
    },
    stop() {
      bag.removeAll();
      context = null;
      lastAt = Number.NEGATIVE_INFINITY;
    },
  };
}
