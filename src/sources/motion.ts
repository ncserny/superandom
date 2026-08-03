/**
 * Accelerometer and gyroscope entropy.
 *
 * The best physical source available in a browser: a MEMS sensor has a genuine
 * analog noise floor, so the low mantissa bits of a reading are real thermal and
 * mechanical noise rather than interpolation.
 *
 * It is off by default, and never auto-prompts. iOS requires
 * DeviceMotionEvent.requestPermission() to be called from a user gesture, and a
 * randomness library that fires a permission dialog on page load would be
 * user-hostile and would fail anyway. The embedder calls requestMotion() from
 * their own click handler if they want it.
 */

import type { CollectorId } from '../types.js';
import { ListenerBag, Scratch, healthSample, isTrusted } from './base.js';
import type { Collector, CollectorContext } from './base.js';

const MOTION_BITS = 2;
/** Sensors fire far faster than they produce new information. */
const MIN_INTERVAL_MS = 100;

interface MotionEventLike {
  isTrusted?: boolean;
  timeStamp?: number;
  acceleration?: { x?: number | null; y?: number | null; z?: number | null } | null;
  accelerationIncludingGravity?: { x?: number | null; y?: number | null; z?: number | null } | null;
  rotationRate?: { alpha?: number | null; beta?: number | null; gamma?: number | null } | null;
  interval?: number;
  alpha?: number | null;
  beta?: number | null;
  gamma?: number | null;
}

export function createMotionCollector(): Collector {
  const bag = new ListenerBag();
  const scratch = new Scratch();
  let context: CollectorContext | null = null;
  let lastAt = Number.NEGATIVE_INFINITY;

  const id: CollectorId = 'motion';

  function onMotion(rawEvent: never): void {
    const event = rawEvent as MotionEventLike;
    const at = event.timeStamp ?? context?.now() ?? 0;
    const interval = at - lastAt;
    if (interval < MIN_INTERVAL_MS) return;
    lastAt = at;

    const acceleration = event.acceleration ?? event.accelerationIncludingGravity ?? null;
    const rotation = event.rotationRate ?? null;

    scratch
      .reset()
      .f64(at)
      .f64(Number.isFinite(interval) ? interval : 0)
      .f64(acceleration?.x ?? 0)
      .f64(acceleration?.y ?? 0)
      .f64(acceleration?.z ?? 0)
      .f64(rotation?.alpha ?? 0)
      .f64(rotation?.beta ?? 0)
      .f64(rotation?.gamma ?? 0)
      .f64(event.alpha ?? 0)
      .f64(event.beta ?? 0)
      .f64(event.gamma ?? 0);

    context?.absorb(
      id,
      scratch.bytes(),
      MOTION_BITS,
      healthSample(acceleration?.x ?? rotation?.alpha ?? interval),
      isTrusted(event),
      at,
    );
  }

  return {
    id,
    start(ctx) {
      context = ctx;
      bag.add(ctx.target, 'devicemotion', onMotion);
      bag.add(ctx.target, 'deviceorientation', onMotion);
    },
    stop() {
      bag.removeAll();
      context = null;
      lastAt = Number.NEGATIVE_INFINITY;
    },
  };
}
