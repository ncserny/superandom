/**
 * Pointer entropy: mouse, pen and any other pointing device.
 *
 * This is the source most people mean when they say "randomness from mouse
 * movement", and it is worth being clear about where the entropy actually is.
 * It is not in the coordinates. A pointer path is a smooth, heavily
 * autocorrelated trajectory, and the next position is largely predictable from
 * the last two. What is genuinely unpredictable is the low bits of the movement
 * deltas and, more than anything, the sub-millisecond arrival timing of the
 * events. So we absorb the whole event but only claim two bits from it.
 */

import { SOURCE_LIMITS } from '../types.js';
import type { CollectorId } from '../types.js';
import { ListenerBag, Scratch, healthSample, isTrusted } from './base.js';
import type { Collector, CollectorContext } from './base.js';

/** One sample per frame at most. Beyond that, samples are near-duplicates anyway. */
const MIN_INTERVAL_MS = 16;

const MOVE_BITS = 2;
const BUTTON_BITS = SOURCE_LIMITS.pointer.maxPerSample; // 4
const PEN_BONUS_BITS = 1;

interface PointerEventLike {
  isTrusted?: boolean;
  timeStamp?: number;
  clientX?: number;
  clientY?: number;
  movementX?: number;
  movementY?: number;
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
  twist?: number;
  pointerType?: string;
  pointerId?: number;
  buttons?: number;
  getCoalescedEvents?: () => PointerEventLike[];
}

export function createPointerCollector(): Collector {
  const bag = new ListenerBag();
  const scratch = new Scratch();
  let lastSampleAt = Number.NEGATIVE_INFINITY;
  let lastTimeStamp = 0;

  const id: CollectorId = 'pointer';

  function pack(event: PointerEventLike, at: number, coalescedCount: number): Uint8Array {
    const timeStamp = event.timeStamp ?? at;
    scratch
      .reset()
      .f64(timeStamp)
      .f64(timeStamp - lastTimeStamp)
      .i32(event.clientX ?? 0)
      .i32(event.clientY ?? 0)
      .i32(event.movementX ?? 0)
      .i32(event.movementY ?? 0)
      .u8(coalescedCount)
      .u8(event.buttons ?? 0)
      .u8(event.pointerId ?? 0);

    // Pen and touch pointers expose real analog axes. A mouse reports pressure
    // as a constant 0 or 0.5, which would be pure noise-free padding.
    if (event.pointerType && event.pointerType !== 'mouse') {
      scratch
        .f64(event.pressure ?? 0)
        .f64(event.tiltX ?? 0)
        .f64(event.tiltY ?? 0)
        .f64(event.twist ?? 0);
    }
    lastTimeStamp = timeStamp;
    return scratch.bytes();
  }

  function onMove(rawEvent: never): void {
    const event = rawEvent as PointerEventLike;
    const clock = event.timeStamp ?? 0;
    const sinceLast = clock - lastSampleAt;
    if (sinceLast < MIN_INTERVAL_MS) return;
    lastSampleAt = clock;

    // getCoalescedEvents allocates an array, so it is only called at the
    // throttle boundary, and we absorb the first, the last and the count rather
    // than the whole batch.
    let coalescedCount = 1;
    let sampled = event;
    if (typeof event.getCoalescedEvents === 'function') {
      try {
        const batch = event.getCoalescedEvents();
        if (batch && batch.length > 0) {
          coalescedCount = Math.min(batch.length, 255);
          sampled = batch[batch.length - 1] ?? event;
        }
      } catch {
        // Some engines throw for synthetic events. Not worth caring about.
      }
    }

    const isPen = Boolean(event.pointerType && event.pointerType !== 'mouse');
    const bits = MOVE_BITS + (isPen ? PEN_BONUS_BITS : 0);
    const bytes = pack(sampled, clock, coalescedCount);

    // The health sample is the inter-event interval, the most volatile quantity
    // available. A replayed or synthesised path shows up here as a constant.
    const sample = Number.isFinite(sinceLast) ? sinceLast : clock;
    context?.absorb(id, bytes, bits, healthSample(sample), isTrusted(event), clock);
  }

  function onButton(rawEvent: never): void {
    const event = rawEvent as PointerEventLike;
    const clock = event.timeStamp ?? 0;
    // Button events are rarer and their timing is far less predictable than a
    // move, so they are worth more and are not throttled.
    const bytes = pack(event, clock, 1);
    context?.absorb(id, bytes, BUTTON_BITS, healthSample(clock), isTrusted(event), clock);
  }

  let context: CollectorContext | null = null;

  return {
    id,
    start(ctx) {
      context = ctx;
      bag.add(ctx.target, 'pointermove', onMove);
      bag.add(ctx.target, 'pointerdown', onButton);
      bag.add(ctx.target, 'pointerup', onButton);
      bag.add(ctx.target, 'pointercancel', onButton);
    },
    stop() {
      bag.removeAll();
      context = null;
      lastSampleAt = Number.NEGATIVE_INFINITY;
    },
  };
}
