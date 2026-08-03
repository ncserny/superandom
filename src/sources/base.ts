/**
 * Shared collector plumbing.
 *
 * Collectors never touch `window` directly. Everything they need arrives in a
 * CollectorContext, which is what lets the whole set run headlessly in Node
 * against a fake event target, with no DOM and no jsdom.
 */

import type { CollectorId, EventTargetLike, SourceId } from '../types.js';

export type AbsorbFn = (
  id: SourceId,
  bytes: Uint8Array,
  proposedBits: number,
  sample: number,
  trusted: boolean,
  at: number,
) => void;

/** The parts of the host environment a collector may use. All optional but `target`. */
export interface CollectorContext {
  target: EventTargetLike;
  /** Monotonic clock, normally performance.now(). */
  now: () => number;
  absorb: AbsorbFn;
  requestFrame?: ((callback: (time: number) => void) => number) | undefined;
  cancelFrame?: ((handle: number) => void) | undefined;
  setTimer?: ((fn: () => void, ms: number) => unknown) | undefined;
  clearTimer?: ((handle: unknown) => void) | undefined;
  documentRef?: DocumentLike | null | undefined;
  navigatorRef?: NavigatorLike | null | undefined;
  /** False while the page is hidden, so the polling collectors can idle. */
  isVisible?: (() => boolean) | undefined;
}

export interface DocumentLike {
  createElement(tag: string): unknown;
  visibilityState?: string;
}

export interface NavigatorLike {
  connection?: { addEventListener?: unknown; removeEventListener?: unknown } | undefined;
  getBattery?: () => Promise<unknown>;
}

export interface Collector {
  readonly id: CollectorId;
  start(context: CollectorContext): void;
  stop(): void;
}

/**
 * Tracks every listener a collector adds so stop() can remove exactly those.
 * sources.test.mjs asserts the add and remove counts match: a collector that
 * leaks listeners keeps a detached page alive.
 */
export class ListenerBag {
  private entries: {
    target: EventTargetLike;
    type: string;
    handler: (event: never) => void;
    options: { passive?: boolean; capture?: boolean };
  }[] = [];

  /**
   * Passive so we can never delay a scroll or a gesture, and capture so page
   * code calling stopPropagation() cannot starve the collectors.
   */
  add(
    target: EventTargetLike,
    type: string,
    handler: (event: never) => void,
    options: { passive?: boolean; capture?: boolean } = { passive: true, capture: true },
  ): void {
    target.addEventListener(type, handler, options);
    this.entries.push({ target, type, handler, options });
  }

  removeAll(): void {
    for (const entry of this.entries) {
      entry.target.removeEventListener(entry.type, entry.handler, {
        capture: entry.options.capture ?? false,
      });
    }
    this.entries = [];
  }

  get size(): number {
    return this.entries.length;
  }
}

/**
 * A reusable little-endian write buffer.
 *
 * Collectors run inside input handlers, so they must not allocate per event.
 * Reset it, write the fields, hand the subarray to absorb (which copies into the
 * accumulator's staging buffer), and nothing is retained.
 */
export class Scratch {
  private readonly buffer = new Uint8Array(192);
  private readonly view = new DataView(this.buffer.buffer);
  private at = 0;

  reset(): this {
    this.at = 0;
    return this;
  }

  u8(value: number): this {
    if (this.at + 1 <= this.buffer.length) this.buffer[this.at++] = value & 0xff;
    return this;
  }

  i32(value: number): this {
    if (this.at + 4 <= this.buffer.length) {
      this.view.setInt32(this.at, Math.trunc(value) | 0, true);
      this.at += 4;
    }
    return this;
  }

  /**
   * Full 64 bits of a double, mantissa included. For timing values the low
   * mantissa bits are the entire point: that is where the sub-millisecond
   * jitter lives.
   */
  f64(value: number): this {
    if (this.at + 8 <= this.buffer.length) {
      this.view.setFloat64(this.at, Number.isFinite(value) ? value : 0, true);
      this.at += 8;
    }
    return this;
  }

  bytes(): Uint8Array {
    return this.buffer.subarray(0, this.at);
  }
}

/** A stable integer for the health tests, derived from a float's low bits. */
export function healthSample(value: number): number {
  if (!Number.isFinite(value)) return 0;
  // Scale so sub-millisecond variation survives truncation to an integer.
  return Math.trunc(value * 1000) % 0x7fffffff;
}

export function isTrusted(event: { isTrusted?: boolean }): boolean {
  // Only an explicit false demotes an event. A fake target in a test has no
  // isTrusted at all, and treating that as untrusted would make the collectors
  // untestable.
  return event.isTrusted !== false;
}
