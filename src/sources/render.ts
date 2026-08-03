/**
 * GPU render timing.
 *
 * TIMING ONLY. This collector measures how long a fixed draw takes. It never
 * reads pixels back.
 *
 * That restriction is deliberate and permanent. A canvas or WebGL pixel hash is
 * the classic browser fingerprint: it is stable across reloads for a given
 * machine, which makes it worth exactly zero bits of entropy, while being a
 * precise tracking identifier. Harvesting it would be a privacy harm in exchange
 * for nothing. Draw duration, by contrast, varies with GPU scheduling and
 * contention and carries a little real noise.
 */

import { SOURCE_LIMITS } from '../types.js';
import type { CollectorId } from '../types.js';
import { Scratch, healthSample } from './base.js';
import type { Collector, CollectorContext } from './base.js';

const RENDER_BITS = 0.25;
const INTERVAL_MS = 3000;
const MAX_MEASUREMENTS = Math.ceil(SOURCE_LIMITS.render.sessionCap / RENDER_BITS) * 2;

interface CanvasLike {
  width: number;
  height: number;
  getContext(type: string): unknown;
}

interface Context2dLike {
  fillStyle: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  arc?: unknown;
  beginPath?: () => void;
}

export function createRenderCollector(): Collector {
  const scratch = new Scratch();
  let context: CollectorContext | null = null;
  let canvas: CanvasLike | null = null;
  let ctx2d: Context2dLike | null = null;
  let timer: unknown = null;
  let taken = 0;
  let stopped = false;

  const id: CollectorId = 'render';

  function measure(): void {
    if (stopped || !context || !ctx2d) return;
    if (context.isVisible && !context.isVisible()) {
      schedule();
      return;
    }

    const start = context.now();
    for (let i = 0; i < 32; i++) {
      ctx2d.fillStyle = `rgb(${i * 7 % 256},${i * 13 % 256},${i * 29 % 256})`;
      ctx2d.fillRect(i % 32, (i * 3) % 32, 8, 8);
    }
    const elapsed = context.now() - start;

    scratch.reset().f64(start).f64(elapsed);
    context.absorb(id, scratch.bytes(), RENDER_BITS, healthSample(elapsed), true, start + elapsed);
    taken++;

    if (taken < MAX_MEASUREMENTS) schedule();
    else timer = null;
  }

  function schedule(): void {
    if (stopped || !context?.setTimer) return;
    timer = context.setTimer(() => measure(), INTERVAL_MS);
  }

  return {
    id,
    start(ctx) {
      if (!ctx.setTimer || !ctx.documentRef) return;
      try {
        const element = ctx.documentRef.createElement('canvas') as CanvasLike | null;
        if (!element) return;
        element.width = 32;
        element.height = 32;
        const twoD = element.getContext('2d') as Context2dLike | null;
        if (!twoD || typeof twoD.fillRect !== 'function') return;
        canvas = element;
        ctx2d = twoD;
      } catch {
        return;
      }
      context = ctx;
      stopped = false;
      taken = 0;
      schedule();
    },
    stop() {
      stopped = true;
      if (timer !== null && context?.clearTimer) context.clearTimer(timer);
      timer = null;
      context = null;
      canvas = null;
      ctx2d = null;
    },
  };
}
