/**
 * The object handed to callers: generators, plus lifecycle and telemetry.
 */

import { Generators } from './api.js';
import { Engine } from './engine.js';
import type { ReseedInfo } from './engine.js';
import { ReceiptLog, type Receipt } from './receipt.js';
import { createCollector } from './sources/index.js';
import type { Collector, CollectorContext } from './sources/base.js';
import {
  ALL_COLLECTORS,
  DEFAULT_COLLECTORS,
  type CollectorId,
  type SourceId,
  type SourceStats,
  type Stats,
} from './types.js';

export interface RngInternals {
  engine: Engine;
  context: CollectorContext;
  requested: readonly CollectorId[];
  readyBits: number;
  receipt: ReceiptLog | null;
  requestMotionPermission: (() => Promise<boolean>) | null;
}

export class Rng extends Generators {
  private readonly collectors = new Map<CollectorId, Collector>();
  private readonly active = new Set<SourceId>();
  private readonly internals: RngInternals;
  private readonly subscribers = new Set<{ callback: (stats: Stats) => void; timer: unknown }>();
  private running = false;
  private readonly startedAt: number;

  constructor(internals: RngInternals) {
    super(internals.engine);
    this.internals = internals;
    this.startedAt = Date.now();

    for (const id of internals.requested) {
      if (!ALL_COLLECTORS.includes(id)) {
        throw new Error(`superandom: unknown source "${id}"`);
      }
      this.collectors.set(id, createCollector(id));
      internals.engine.estimator.setEnabled(id, true);
    }
  }

  /** Attach the collectors. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    for (const [id, collector] of this.collectors) {
      collector.start(this.internals.context);
      this.active.add(id);
    }
  }

  /** Detach every listener and timer. Idempotent. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const [id, collector] of this.collectors) {
      collector.stop();
      this.active.delete(id);
    }
  }

  /** Stop collecting and drop every subscriber. */
  destroy(): void {
    this.stop();
    for (const subscriber of this.subscribers) {
      if (subscriber.timer !== null) clearInterval(subscriber.timer as never);
    }
    this.subscribers.clear();
  }

  /**
   * Enable the motion sensors.
   *
   * MUST be called from a user gesture: iOS requires
   * DeviceMotionEvent.requestPermission() to originate from one, and will reject
   * the call otherwise. superandom never prompts on its own.
   */
  async requestMotion(): Promise<boolean> {
    const request = this.internals.requestMotionPermission;
    if (request) {
      const granted = await request();
      if (!granted) return false;
    }
    if (!this.collectors.has('motion')) {
      const collector = createCollector('motion');
      this.collectors.set('motion', collector);
      this.internals.engine.estimator.setEnabled('motion', true);
      if (this.running) {
        collector.start(this.internals.context);
        this.active.add('motion');
      }
    }
    return true;
  }

  /** Credited bits collected so far. */
  entropyBits(): number {
    return this.internals.engine.entropyBits();
  }

  /**
   * Resolves once `bits` credited bits exist.
   *
   * This is a provenance signal, not a security gate. Output is already folded
   * with the platform CSPRNG and is sound from the first millisecond.
   */
  ready(bits?: number): Promise<void> {
    return this.internals.engine.ready(bits);
  }

  isReady(): boolean {
    return this.internals.engine.isReady();
  }

  sources(): SourceStats[] {
    return this.internals.engine.sourceStats(this.active);
  }

  stats(): Stats {
    const engine = this.internals.engine;
    const counters = engine.counters;
    return {
      creditedBits: engine.entropyBits(),
      readyBits: this.internals.readyBits,
      ready: engine.isReady(),
      reseeds: counters.reseeds,
      bytesGenerated: counters.bytesGenerated,
      foldMode: engine.foldMode,
      startedAt: this.startedAt,
      running: this.running,
      receiptHead: this.internals.receipt?.head ?? null,
      sources: this.sources(),
    };
  }

  /** Poll stats on an interval. Returns an unsubscribe function. */
  subscribe(callback: (stats: Stats) => void, intervalMs = 250): () => void {
    const entry = {
      callback,
      timer: setInterval(() => callback(this.stats()), Math.max(16, intervalMs)) as unknown,
    };
    this.subscribers.add(entry);
    callback(this.stats());
    return () => {
      if (entry.timer !== null) clearInterval(entry.timer as never);
      this.subscribers.delete(entry);
    };
  }

  /** Force a reseed. Any `extra` is mixed into the pool but never credited. */
  reseed(extra?: BufferSource): void {
    let bytes: Uint8Array | undefined;
    if (extra) {
      bytes =
        extra instanceof Uint8Array
          ? extra
          : new Uint8Array(
              ArrayBuffer.isView(extra)
                ? extra.buffer.slice(extra.byteOffset, extra.byteOffset + extra.byteLength)
                : extra,
            );
    }
    this.internals.engine.reseed(bytes);
  }

  /**
   * The audit receipt, or null when receipts are disabled.
   * Safe to publish: it commits to no secret.
   */
  receipt(): Receipt | null {
    return this.internals.receipt?.toJSON() ?? null;
  }
}

/**
 * Wire the engine's reseed callback into the receipt log.
 *
 * The engine emits its first reseed from inside its own constructor, before the
 * caller holds a reference to it, so the lookup is deferred and tolerates a null
 * engine. That first epoch has no contributors by definition.
 */
export function makeReseedRecorder(
  receipt: ReceiptLog | null,
  lookupEngine: () => Engine | null,
): (info: ReseedInfo) => void {
  return (info) => {
    if (!receipt) return;
    const engine = lookupEngine();
    const contributors = engine
      ? engine
          .sourceStats(new Set<SourceId>())
          .filter((source) => source.events > 0)
          .map((source) => ({
            id: source.id,
            events: source.events,
            creditedBits: source.creditedBits,
            healthy: source.healthy,
          }))
      : [];

    receipt.record({
      n: info.index,
      at: info.at,
      creditedBits: info.creditedBits,
      outputBytesSinceLast: info.bytesSinceLast,
      contributors,
    });
  };
}

export { DEFAULT_COLLECTORS };
