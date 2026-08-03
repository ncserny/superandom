/**
 * Shared types and the source registry.
 */

export type SourceId =
  | 'platform'
  | 'pointer'
  | 'keyboard'
  | 'touch'
  | 'scroll'
  | 'raf'
  | 'clock'
  | 'motion'
  | 'render'
  | 'ambient'
  | 'manual';

/** Collectors that attach to the DOM. `platform` and `manual` are not among them. */
export type CollectorId = Exclude<SourceId, 'platform' | 'manual'>;

export const ALL_COLLECTORS: readonly CollectorId[] = [
  'pointer',
  'keyboard',
  'touch',
  'scroll',
  'raf',
  'clock',
  'motion',
  'render',
  'ambient',
];

/** On by default. `motion` is excluded: it needs a user gesture on iOS and must never auto-prompt. */
export const DEFAULT_COLLECTORS: readonly CollectorId[] = [
  'pointer',
  'keyboard',
  'touch',
  'scroll',
  'raf',
  'clock',
  'render',
  'ambient',
];

/**
 * Stable numeric tag per source, mixed into every absorb so that material from
 * two different sources can never collide in the pool encoding. These values are
 * part of the wire format of the pool: never renumber them.
 */
export const SOURCE_TAG: Record<SourceId, number> = {
  platform: 1,
  pointer: 2,
  keyboard: 3,
  touch: 4,
  scroll: 5,
  raf: 6,
  clock: 7,
  motion: 8,
  render: 9,
  ambient: 10,
  manual: 11,
};

export interface SourceLimits {
  /** Ceiling on bits credited for any single sample, however much a collector proposes. */
  maxPerSample: number;
  /** Ceiling on bits this source may contribute across the whole session. */
  sessionCap: number;
  /** Shown in stats() so the numbers can be argued with rather than taken on faith. */
  note: string;
}

/**
 * Per-source credit caps. Every number here is deliberately pessimistic: the
 * cost of over-crediting is a false `ready`, and the cost of under-crediting is
 * nothing at all, because output quality never depends on the estimate (see
 * engine.ts and the XOR fold).
 */
export const SOURCE_LIMITS: Record<SourceId, SourceLimits> = {
  platform: {
    maxPerSample: 256,
    sessionCap: Number.POSITIVE_INFINITY,
    note: 'crypto.getRandomValues, assumed uniform. The floor of the whole system.',
  },
  pointer: {
    maxPerSample: 4,
    sessionCap: 640,
    note: 'Paths are strongly autocorrelated. Entropy lives in delta low bits and sub-millisecond arrival timing, not position. Moves propose 2 bits, button events 4.',
  },
  keyboard: {
    maxPerSample: 1,
    sessionCap: 256,
    note: 'Inter-key interval only, never key identity. Keystroke timing studies put roughly 1.2 bits in an interval, so we take 1.',
  },
  touch: {
    maxPerSample: 4,
    sessionCap: 512,
    note: 'As pointer, plus contact geometry (radius, force) which carries real analog noise.',
  },
  scroll: {
    maxPerSample: 1,
    sessionCap: 128,
    note: 'Wheel deltas are heavily quantised, often to fixed steps. Nearly all the entropy is in timing.',
  },
  raf: {
    maxPerSample: 0.5,
    sessionCap: 64,
    note: 'Most of a frame delta is deterministic vsync. Only the residual jitter counts, and it is clamped.',
  },
  clock: {
    maxPerSample: 0.125,
    sessionCap: 32,
    note: 'performance.now() is clamped to 100us, or 5us when cross-origin isolated, so most measurements read exactly zero.',
  },
  motion: {
    maxPerSample: 2,
    sessionCap: 128,
    note: 'Genuine MEMS noise floor. Requires an explicit user gesture on iOS.',
  },
  render: {
    maxPerSample: 0.25,
    sessionCap: 32,
    note: 'Draw-call wall time only. Canvas pixels are never read: a canvas hash is a stable fingerprint, so it is zero entropy and a privacy hazard both.',
  },
  ambient: {
    maxPerSample: 1,
    sessionCap: 32,
    note: 'Timing of rare environment changes: connectivity, visibility, battery.',
  },
  manual: {
    maxPerSample: 0,
    sessionCap: 0,
    note: 'Caller-supplied material via reseed(). Mixed into the pool, never credited, because the SDK cannot audit where it came from.',
  },
};

export interface SourceStats {
  id: SourceId;
  enabled: boolean;
  active: boolean;
  /** False once a SP 800-90B health test has tripped. Credit drops to zero. */
  healthy: boolean;
  events: number;
  bytesAbsorbed: number;
  creditedBits: number;
  capBits: number;
  lastAt: number | null;
  note: string;
}

export interface Stats {
  /** The secret-entropy estimate. This is the only number that gates `ready`. */
  creditedBits: number;
  readyBits: number;
  ready: boolean;
  reseeds: number;
  bytesGenerated: number;
  foldMode: FoldMode;
  startedAt: number;
  running: boolean;
  receiptHead: string | null;
  sources: SourceStats[];
}

/**
 * How platform CSPRNG bytes are folded into output.
 *
 * `always` is the default and the reason this SDK can claim it is never worse
 * than crypto.getRandomValues(). Weakening it is a footgun, so `never` requires
 * an explicit acknowledgement flag.
 */
export type FoldMode = 'always' | 'reseed-only' | 'never';

export interface SuperandomOptions {
  /** Which DOM collectors to attach. Defaults to everything except `motion`. */
  sources?: readonly CollectorId[];
  /** Entropy threshold, in credited bits, at which `ready()` resolves. Default 256. */
  readyBits?: number;
  /**
   * When true, generator calls throw below `readyBits`. Default false.
   * This is a provenance control, not a security control: because of the fold,
   * output is already platform-grade from the first millisecond.
   */
  blockUntilReady?: boolean;
  foldMode?: FoldMode;
  /** Required to be `true` when foldMode is 'never'. */
  iUnderstandTheRisk?: boolean;
  /** Ceiling on credited bits per second, across all sources. Default 64. */
  rateCapBitsPerSecond?: number;
  /** Record an audit receipt. Default true. */
  receipt?: boolean;
  /** DOM root to listen on. Defaults to `window`. Injected in tests. */
  target?: EventTargetLike | null;
  /** Monotonic clock. Defaults to performance.now(). Injected in tests. */
  now?: () => number;
  /** Wall clock, for receipt timestamps. Defaults to Date.now(). Injected in tests. */
  wallClock?: () => number;
  /** Source of platform CSPRNG bytes. Defaults to globalThis.crypto. Injected in tests. */
  platform?: PlatformRandom;
}

export interface PlatformRandom {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

/** The slice of EventTarget the collectors need, so they can be driven headlessly. */
export interface EventTargetLike {
  addEventListener(
    type: string,
    listener: (event: never) => void,
    options?: { passive?: boolean; capture?: boolean } | boolean,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: never) => void,
    options?: { capture?: boolean } | boolean,
  ): void;
}
