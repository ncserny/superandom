/**
 * Frame-timing jitter.
 *
 * Most of the gap between two animation frames is deterministic vsync: 16.667ms
 * at 60Hz. The entropy is only in the residual, the few hundred microseconds of
 * scheduling noise around it, and browsers clamp the timestamp anyway. So this
 * claims half a bit per frame and stops entirely once it has reached its
 * session cap, rather than running a callback for the life of the page.
 */

import { SOURCE_LIMITS } from '../types.js';
import type { CollectorId } from '../types.js';
import { Scratch, healthSample } from './base.js';
import type { Collector, CollectorContext } from './base.js';

const FRAME_BITS = 0.5;
const NOMINAL_FRAME_MS = 1000 / 60;
/** Enough frames to reach the session cap at half a bit each, plus slack. */
const MAX_FRAMES = Math.ceil(SOURCE_LIMITS.raf.sessionCap / FRAME_BITS) * 2;

export function createRafCollector(): Collector {
  const scratch = new Scratch();
  let context: CollectorContext | null = null;
  let handle: number | null = null;
  let previous: number | null = null;
  let frames = 0;
  let stopped = false;

  const id: CollectorId = 'raf';

  function onFrame(time: number): void {
    if (stopped || !context) return;

    if (previous !== null) {
      const delta = time - previous;
      // The residual after removing the nominal frame interval. Whole dropped
      // frames are removed too, so a stall does not masquerade as entropy.
      const residual = delta - Math.round(delta / NOMINAL_FRAME_MS) * NOMINAL_FRAME_MS;
      scratch.reset().f64(time).f64(delta).f64(residual);
      context.absorb(id, scratch.bytes(), FRAME_BITS, healthSample(residual), true, time);
      frames++;
    }
    previous = time;

    if (frames >= MAX_FRAMES) {
      handle = null;
      return;
    }
    schedule();
  }

  function schedule(): void {
    if (stopped || !context?.requestFrame) return;
    // Nothing useful arrives while the page is hidden, and browsers throttle
    // frames to a crawl there anyway.
    if (context.isVisible && !context.isVisible()) {
      handle = null;
      const timer = context.setTimer;
      if (timer) timer(() => schedule(), 500);
      return;
    }
    handle = context.requestFrame(onFrame);
  }

  return {
    id,
    start(ctx) {
      if (!ctx.requestFrame) return;
      context = ctx;
      stopped = false;
      frames = 0;
      previous = null;
      schedule();
    },
    stop() {
      stopped = true;
      if (handle !== null && context?.cancelFrame) context.cancelFrame(handle);
      handle = null;
      context = null;
    },
  };
}
