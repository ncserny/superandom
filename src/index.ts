/**
 * superandom public entry point.
 *
 * Importing this module has no side effects: it installs no globals, attaches no
 * listeners, and issues no network requests. Nothing in this package ever does
 * the last one, at all, by design. Call create() to start collecting.
 */

import { Engine } from './engine.js';
import { Rng, makeReseedRecorder } from './rng.js';
import { ReceiptLog } from './receipt.js';
import type { CollectorContext } from './sources/base.js';
import {
  DEFAULT_COLLECTORS,
  type CollectorId,
  type PlatformRandom,
  type SuperandomOptions,
} from './types.js';

export const VERSION = '1.0.0';

export { Rng } from './rng.js';
export { NotReadyError } from './engine.js';
export { verifyReceipt, RECEIPT_VERSION } from './receipt.js';
export { BASE58 } from './api.js';
export {
  ALL_COLLECTORS,
  DEFAULT_COLLECTORS,
  SOURCE_LIMITS,
  type CollectorId,
  type FoldMode,
  type SourceId,
  type SourceStats,
  type Stats,
  type SuperandomOptions,
} from './types.js';
export type { Receipt, ReceiptEpoch, ReceiptContributor, VerificationResult } from './receipt.js';

interface MotionPermissionHost {
  DeviceMotionEvent?: { requestPermission?: () => Promise<string> };
}

function resolvePlatform(supplied?: PlatformRandom): PlatformRandom {
  if (supplied) return supplied;
  const host = globalThis as { crypto?: PlatformRandom };
  if (!host.crypto || typeof host.crypto.getRandomValues !== 'function') {
    throw new Error(
      'superandom: no crypto.getRandomValues in this environment. superandom refuses to ' +
        'run without it, because its security guarantee depends on it.',
    );
  }
  return host.crypto;
}

function resolveOrigin(): string {
  const host = globalThis as { location?: { origin?: string; href?: string } };
  return host.location?.origin ?? host.location?.href ?? 'unknown-origin';
}

function defaultNow(): number {
  const host = globalThis as { performance?: { now(): number } };
  return host.performance?.now() ?? Date.now();
}

/**
 * Build the collector context from whatever the host actually provides.
 * Everything except the event target is optional: a missing capability simply
 * disables the collector that needs it, rather than throwing.
 */
function resolveContext(
  engine: Engine,
  target: SuperandomOptions['target'],
  now: () => number,
): CollectorContext {
  const host = globalThis as {
    requestAnimationFrame?: (callback: (time: number) => void) => number;
    cancelAnimationFrame?: (handle: number) => void;
    setTimeout?: (fn: () => void, ms: number) => unknown;
    clearTimeout?: (handle: unknown) => void;
    document?: { createElement(tag: string): unknown; visibilityState?: string };
    navigator?: unknown;
    addEventListener?: unknown;
  };

  const resolvedTarget =
    target ?? (typeof host.addEventListener === 'function' ? (host as unknown) : null);
  if (!resolvedTarget) {
    throw new Error(
      'superandom: no event target available. Pass `target` explicitly when running ' +
        'outside a browser, or use createCore() for a collector-free engine.',
    );
  }

  return {
    target: resolvedTarget as CollectorContext['target'],
    now,
    absorb: (id, bytes, bits, sample, trusted, at) =>
      engine.absorb(id, bytes, bits, sample, trusted, at),
    requestFrame: host.requestAnimationFrame?.bind(host),
    cancelFrame: host.cancelAnimationFrame?.bind(host),
    setTimer: host.setTimeout?.bind(host),
    clearTimer: host.clearTimeout?.bind(host),
    documentRef: (host.document as CollectorContext['documentRef']) ?? null,
    navigatorRef: (host.navigator as CollectorContext['navigatorRef']) ?? null,
    isVisible: host.document ? () => host.document?.visibilityState !== 'hidden' : undefined,
  };
}

function resolveMotionPermission(): (() => Promise<boolean>) | null {
  const host = globalThis as MotionPermissionHost;
  const request = host.DeviceMotionEvent?.requestPermission;
  if (typeof request !== 'function') return null;
  return async () => {
    try {
      // Must be called from a user gesture. iOS rejects it otherwise.
      const result = await request.call(host.DeviceMotionEvent);
      return result === 'granted';
    } catch {
      return false;
    }
  };
}

function buildEngine(options: SuperandomOptions): {
  engine: Engine;
  receipt: ReceiptLog | null;
  readyBits: number;
} {
  const foldMode = options.foldMode ?? 'always';
  if (foldMode === 'never' && options.iUnderstandTheRisk !== true) {
    throw new Error(
      'superandom: foldMode "never" removes the platform CSPRNG fold, which is the only ' +
        'reason output cannot be worse than crypto.getRandomValues(). Pass ' +
        'iUnderstandTheRisk: true if you really mean it.',
    );
  }

  const readyBits = options.readyBits ?? 256;
  const platform = resolvePlatform(options.platform);
  const wallClock = options.wallClock ?? (() => Date.now());

  const receipt =
    options.receipt === false
      ? null
      : new ReceiptLog(sessionId(platform), resolveOrigin(), wallClock());

  let engineRef: Engine | null = null;
  const engine = new Engine({
    platform,
    foldMode,
    rateCapBitsPerSecond: options.rateCapBitsPerSecond ?? 64,
    readyBits,
    blockUntilReady: options.blockUntilReady ?? false,
    crossOriginIsolated:
      (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
    origin: resolveOrigin(),
    wallClock,
    now: options.now ?? defaultNow,
    onReseed: makeReseedRecorder(receipt, () => engineRef),
  });
  engineRef = engine;

  return { engine, receipt, readyBits };
}

/** A label for the receipt. Not a secret and not used for seeding. */
function sessionId(platform: PlatformRandom): string {
  const bytes = new Uint8Array(8);
  platform.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * Create a generator and start collecting.
 *
 * ```js
 * const rng = create();
 * rng.randomInt(1, 7);   // usable immediately: already platform-grade
 * await rng.ready(256);  // optional, if you want to wait for the human
 * ```
 */
export function create(options: SuperandomOptions = {}): Rng {
  const { engine, receipt, readyBits } = buildEngine(options);
  const now = options.now ?? defaultNow;
  const requested = (options.sources ?? DEFAULT_COLLECTORS) as readonly CollectorId[];

  const rng = new Rng({
    engine,
    context: resolveContext(engine, options.target, now),
    requested,
    readyBits,
    receipt,
    requestMotionPermission: resolveMotionPermission(),
  });
  rng.start();
  return rng;
}

/**
 * Create a generator with no DOM collectors at all.
 *
 * For Web Workers, Node, or anywhere without an event target. Output is still
 * folded with the platform CSPRNG, so it is exactly as good as
 * crypto.getRandomValues() plus whatever you feed in through reseed().
 */
export function createCore(options: SuperandomOptions = {}): Rng {
  const { engine, receipt, readyBits } = buildEngine(options);
  return new Rng({
    engine,
    context: {
      target: { addEventListener() {}, removeEventListener() {} },
      now: options.now ?? defaultNow,
      absorb: (id, bytes, bits, sample, trusted, at) =>
        engine.absorb(id, bytes, bits, sample, trusted, at),
    },
    requested: [],
    readyBits,
    receipt,
    requestMotionPermission: null,
  });
}
