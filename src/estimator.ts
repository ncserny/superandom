/**
 * Entropy accounting.
 *
 * This file decides how many bits the SDK claims to have collected. It is the
 * place where an entropy library is most tempted to lie to itself, so the rules
 * are deliberately blunt:
 *
 *   - Static, pessimistic per-source caps (see SOURCE_LIMITS in types.ts). Real
 *     SP 800-90B estimation runs ten estimators plus IID permutation tests over
 *     a large sample; that is far too heavy for a page, and doing it badly would
 *     be worse than not doing it.
 *   - Untrusted (synthetic) events are credited zero.
 *   - A global rate limit, so no event flood can inflate the estimate faster
 *     than a human could plausibly produce entropy.
 *   - The two SP 800-90B section 4.4 continuous health tests, which catch the
 *     failure modes that actually happen: a stuck sensor, a driver quantising
 *     everything to a constant, a headless browser replaying a fixed path.
 *
 * Getting these numbers wrong cannot compromise output. Output quality is
 * guaranteed by the XOR fold in engine.ts, not by anything here. An overestimate
 * only produces a premature `ready`, which is a provenance error, not a
 * cryptographic one.
 */

import { SOURCE_LIMITS, type SourceId, type SourceStats } from './types.js';

/** SP 800-90B uses alpha = 2^-20 for both continuous tests. */
const HEALTH_ALPHA = 2 ** -20;

/** Adaptive Proportion Test window for non-binary sources. */
const APT_WINDOW = 512;

interface SourceState {
  id: SourceId;
  enabled: boolean;
  events: number;
  bytes: number;
  credited: number;
  healthy: boolean;
  lastAt: number | null;

  // Repetition Count Test (SP 800-90B 4.4.1)
  rctCutoff: number;
  rctValue: number | null;
  rctRun: number;

  // Adaptive Proportion Test (SP 800-90B 4.4.2)
  aptCutoff: number;
  aptValue: number | null;
  aptCount: number;
  aptSeen: number;
}

export interface EstimatorOptions {
  /** Ceiling on credited bits per second across all sources. */
  rateCapBitsPerSecond: number;
  /**
   * performance.now() is clamped to 100us normally and 5us in a cross-origin
   * isolated context, which changes how much the timing sources can possibly
   * carry. Nobody should ever "fix" a low clock estimate by raising the cap.
   */
  crossOriginIsolated: boolean;
}

export class Estimator {
  private readonly states = new Map<SourceId, SourceState>();
  private readonly rateCap: number;
  private tokens: number;
  private lastRefill: number | null = null;
  private total = 0;

  constructor(private readonly options: EstimatorOptions) {
    this.rateCap = Math.max(0, options.rateCapBitsPerSecond);
    this.tokens = this.rateCap;

    for (const id of Object.keys(SOURCE_LIMITS) as SourceId[]) {
      const perSample = this.perSampleEntropy(id);
      this.states.set(id, {
        id,
        enabled: false,
        events: 0,
        bytes: 0,
        credited: 0,
        healthy: true,
        lastAt: null,
        // SP 800-90B 4.4.1: C = 1 + ceil(-log2(alpha) / H) = 1 + ceil(20 / H).
        rctCutoff: perSample > 0 ? 1 + Math.ceil(20 / perSample) : Number.POSITIVE_INFINITY,
        rctValue: null,
        rctRun: 0,
        aptCutoff: perSample > 0 ? aptCutoff(APT_WINDOW, perSample) : Number.POSITIVE_INFINITY,
        aptValue: null,
        aptCount: 0,
        aptSeen: 0,
      });
    }
  }

  /** The clock source is clamped harder without cross-origin isolation. */
  private perSampleEntropy(id: SourceId): number {
    const base = SOURCE_LIMITS[id].maxPerSample;
    if (id === 'clock' && this.options.crossOriginIsolated) return base * 2;
    return base;
  }

  sessionCap(id: SourceId): number {
    const base = SOURCE_LIMITS[id].sessionCap;
    if (id === 'clock' && this.options.crossOriginIsolated) return base * 2;
    return base;
  }

  setEnabled(id: SourceId, enabled: boolean): void {
    const state = this.states.get(id);
    if (state) state.enabled = enabled;
  }

  /**
   * Offer a sample. Returns the number of bits actually credited, which is
   * frequently less than proposed and is often zero.
   *
   * @param sample a representative integer for the health tests. Collectors pass
   *               the most volatile quantity they have, typically a timing delta.
   * @param trusted `event.isTrusted`. Synthetic events are mixed but never
   *                credited: otherwise a hostile embedder, or any extension that
   *                dispatches events, could fake a full entropy pool.
   */
  propose(
    id: SourceId,
    at: number,
    proposedBits: number,
    sample: number,
    trusted = true,
  ): number {
    const state = this.states.get(id);
    if (!state) return 0;

    state.events++;
    state.lastAt = at;

    if (Number.isFinite(sample)) this.runHealthTests(state, Math.trunc(sample));

    if (!trusted || !state.healthy) return 0;

    const perSample = this.perSampleEntropy(id);
    const cap = this.sessionCap(id);

    let bits = Math.min(proposedBits, perSample);
    bits = Math.min(bits, cap - state.credited);
    if (bits <= 0) return 0;

    bits = this.takeFromBucket(bits, at);
    if (bits <= 0) return 0;

    state.credited += bits;
    this.total += bits;
    return bits;
  }

  /** Record absorbed volume for stats. Does not credit anything. */
  noteBytes(id: SourceId, count: number): void {
    const state = this.states.get(id);
    if (state) state.bytes += count;
  }

  /**
   * Token bucket over wall time. Capacity equals one second of budget, so a
   * burst after a quiet period is allowed, but a sustained flood is not.
   */
  private takeFromBucket(bits: number, at: number): number {
    if (this.rateCap === Number.POSITIVE_INFINITY) return bits;

    if (this.lastRefill === null) {
      this.lastRefill = at;
    } else if (at > this.lastRefill) {
      const elapsedSeconds = (at - this.lastRefill) / 1000;
      this.tokens = Math.min(this.rateCap, this.tokens + elapsedSeconds * this.rateCap);
      this.lastRefill = at;
    }

    const granted = Math.min(bits, this.tokens);
    this.tokens -= granted;
    return granted;
  }

  /**
   * SP 800-90B section 4.4. Neither test proves a source is good; both catch a
   * source that has plainly failed, which is what we need. A tripped test drops
   * the source to zero credit permanently and flags it in stats().
   */
  private runHealthTests(state: SourceState, sample: number): void {
    if (!state.healthy) return;

    // 4.4.1 Repetition Count: the same value arriving over and over.
    if (state.rctValue === sample) {
      state.rctRun++;
      if (state.rctRun >= state.rctCutoff) {
        state.healthy = false;
        return;
      }
    } else {
      state.rctValue = sample;
      state.rctRun = 1;
    }

    // 4.4.2 Adaptive Proportion: one value dominating a window, without
    // necessarily being consecutive.
    if (state.aptValue === null || state.aptSeen >= APT_WINDOW) {
      state.aptValue = sample;
      state.aptCount = 1;
      state.aptSeen = 1;
      return;
    }
    state.aptSeen++;
    if (sample === state.aptValue) {
      state.aptCount++;
      if (state.aptCount > state.aptCutoff) state.healthy = false;
    }
  }

  creditedBits(): number {
    return this.total;
  }

  snapshot(activeIds: ReadonlySet<SourceId>): SourceStats[] {
    const out: SourceStats[] = [];
    for (const state of this.states.values()) {
      out.push({
        id: state.id,
        enabled: state.enabled,
        active: activeIds.has(state.id),
        healthy: state.healthy,
        events: state.events,
        bytesAbsorbed: state.bytes,
        creditedBits: round(state.credited),
        capBits: this.sessionCap(state.id),
        lastAt: state.lastAt,
        note: SOURCE_LIMITS[state.id].note,
      });
    }
    return out;
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Smallest C such that P(Binomial(w - 1, 2^-h) >= C) <= alpha.
 *
 * SP 800-90B publishes a table of these; we compute them so the numbers can be
 * checked rather than trusted, and so a changed cap does not silently keep an
 * unrelated cutoff.
 */
export function aptCutoff(w: number, h: number, alpha: number = HEALTH_ALPHA): number {
  const n = w - 1;
  const p = 2 ** -h;
  if (p >= 1) return n;

  const logP = Math.log(p);
  const logQ = Math.log1p(-p);
  const logBinom = (k: number) => lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);

  // Walk down from the tail, accumulating P(X >= k). The first k whose inclusion
  // pushes the tail past alpha means the safe cutoff is k + 1.
  let cumulative = 0;
  for (let k = n; k >= 0; k--) {
    cumulative += Math.exp(logBinom(k) + k * logP + (n - k) * logQ);
    if (cumulative > alpha) return Math.min(k + 1, n);
  }
  return 1;
}

/** Lanczos approximation, g = 7, n = 9. Plenty for binomial coefficients here. */
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

function lgamma(x: number): number {
  if (x < 0.5) {
    // Reflection formula, so the approximation is only ever used for x >= 0.5.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  }
  const z = x - 1;
  let sum = LANCZOS[0] as number;
  for (let i = 1; i < LANCZOS.length; i++) sum += (LANCZOS[i] as number) / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}
