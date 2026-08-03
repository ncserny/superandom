/**
 * Touch entropy.
 *
 * Like pointer, but with extra analog axes that a mouse does not have: contact
 * radius, rotation angle and force are digitised from a real capacitive sensor,
 * so their low bits carry genuine noise rather than interpolated positions.
 */

import type { CollectorId } from '../types.js';
import { ListenerBag, Scratch, healthSample, isTrusted } from './base.js';
import type { Collector, CollectorContext } from './base.js';

const MIN_INTERVAL_MS = 16;
const MOVE_BITS = 2;
const START_BITS = 4;

interface TouchLike {
  clientX?: number;
  clientY?: number;
  radiusX?: number;
  radiusY?: number;
  rotationAngle?: number;
  force?: number;
  identifier?: number;
}

interface TouchEventLike {
  isTrusted?: boolean;
  timeStamp?: number;
  touches?: ArrayLike<TouchLike>;
  changedTouches?: ArrayLike<TouchLike>;
}

export function createTouchCollector(): Collector {
  const bag = new ListenerBag();
  const scratch = new Scratch();
  let context: CollectorContext | null = null;
  let lastSampleAt = Number.NEGATIVE_INFINITY;

  const id: CollectorId = 'touch';

  function absorbTouches(event: TouchEventLike, bits: number, at: number, interval: number): void {
    const list = event.changedTouches ?? event.touches;
    const count = list ? Math.min(list.length, 4) : 0;

    scratch.reset().f64(at).f64(interval).u8(count);
    for (let i = 0; i < count; i++) {
      const touch = list?.[i];
      if (!touch) continue;
      scratch
        .i32(touch.clientX ?? 0)
        .i32(touch.clientY ?? 0)
        .f64(touch.radiusX ?? 0)
        .f64(touch.radiusY ?? 0)
        .f64(touch.rotationAngle ?? 0)
        .f64(touch.force ?? 0)
        .u8(touch.identifier ?? 0);
    }

    context?.absorb(id, scratch.bytes(), bits, healthSample(interval), isTrusted(event), at);
  }

  function onMove(rawEvent: never): void {
    const event = rawEvent as TouchEventLike;
    const at = event.timeStamp ?? 0;
    const interval = at - lastSampleAt;
    if (interval < MIN_INTERVAL_MS) return;
    lastSampleAt = at;
    absorbTouches(event, MOVE_BITS, at, Number.isFinite(interval) ? interval : 0);
  }

  function onStartOrEnd(rawEvent: never): void {
    const event = rawEvent as TouchEventLike;
    const at = event.timeStamp ?? 0;
    const interval = at - lastSampleAt;
    lastSampleAt = at;
    absorbTouches(event, START_BITS, at, Number.isFinite(interval) ? interval : 0);
  }

  return {
    id,
    start(ctx) {
      context = ctx;
      bag.add(ctx.target, 'touchstart', onStartOrEnd);
      bag.add(ctx.target, 'touchmove', onMove);
      bag.add(ctx.target, 'touchend', onStartOrEnd);
      bag.add(ctx.target, 'touchcancel', onStartOrEnd);
    },
    stop() {
      bag.removeAll();
      context = null;
      lastSampleAt = Number.NEGATIVE_INFINITY;
    },
  };
}
