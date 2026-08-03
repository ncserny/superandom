/**
 * CPU and clock jitter.
 *
 * The idea behind jitter entropy is that the time taken to run a fixed workload
 * varies unpredictably with cache state, frequency scaling, interrupts and
 * scheduling. It works well natively. In a browser it is largely defeated:
 * performance.now() is clamped to 100 microseconds, or 5 microseconds in a
 * cross-origin isolated context, so most measurements of a short workload read
 * exactly zero.
 *
 * Hence the brutal credit of an eighth of a bit per measurement. Nobody should
 * ever "fix" a low reading here by raising the cap: the clamping is real and the
 * bits are genuinely not there.
 */

import { SOURCE_LIMITS } from '../types.js';
import type { CollectorId } from '../types.js';
import { Scratch, healthSample } from './base.js';
import type { Collector, CollectorContext } from './base.js';

const MEASUREMENT_BITS = 0.125;
const MEASUREMENTS_PER_BURST = 32;
const BURST_INTERVAL_MS = 2000;
const MAX_MEASUREMENTS = Math.ceil(SOURCE_LIMITS.clock.sessionCap / MEASUREMENT_BITS) * 4;

export function createClockCollector(): Collector {
  const scratch = new Scratch();
  let context: CollectorContext | null = null;
  let timer: unknown = null;
  let taken = 0;
  let stopped = false;

  const id: CollectorId = 'clock';

  function burst(): void {
    if (stopped || !context) return;
    if (context.isVisible && !context.isVisible()) {
      schedule();
      return;
    }

    for (let i = 0; i < MEASUREMENTS_PER_BURST && taken < MAX_MEASUREMENTS; i++) {
      const start = context.now();
      // A small fixed workload. The compiler must not be able to hoist it, so
      // the result feeds back into the accumulator.
      let acc = i;
      for (let k = 0; k < 200; k++) acc = (acc * 1103515245 + 12345) & 0x7fffffff;
      const end = context.now();

      const delta = end - start;
      // Drift between the monotonic clock and the wall clock is a second,
      // independent jitter signal.
      const drift = Date.now() - end;

      scratch.reset().f64(start).f64(delta).f64(drift).i32(acc);
      context.absorb(id, scratch.bytes(), MEASUREMENT_BITS, healthSample(delta), true, end);
      taken++;
    }

    if (taken < MAX_MEASUREMENTS) schedule();
    else timer = null;
  }

  function schedule(): void {
    if (stopped || !context?.setTimer) return;
    timer = context.setTimer(() => burst(), BURST_INTERVAL_MS);
  }

  return {
    id,
    start(ctx) {
      if (!ctx.setTimer) return;
      context = ctx;
      stopped = false;
      taken = 0;
      burst();
    },
    stop() {
      stopped = true;
      if (timer !== null && context?.clearTimer) context.clearTimer(timer);
      timer = null;
      context = null;
    },
  };
}
