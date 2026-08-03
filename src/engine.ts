/**
 * The engine: accumulator plus DRBG plus the platform fold.
 *
 * If you read one file in this package, read the fold in `randomBytes` below.
 * It is the entire safety argument.
 */

import { Accumulator } from './accumulator.js';
import { Estimator } from './estimator.js';
import { HmacDrbg } from './drbg.js';
import { hkdfExtract, sha256 } from './sha256.js';
import { concat, u32le, u64le, utf8, wipe } from './encoding.js';
import type { FoldMode, PlatformRandom, SourceId, SourceStats } from './types.js';

const EXTRACT_SALT = utf8('superandom/v1/extract');
const CONTEXT_DOMAIN = utf8('superandom/v1/context');
const PERSONALIZATION = utf8('superandom/v1/drbg');

/**
 * Output is generated a block at a time and served from a buffer.
 *
 * Without this, a 4-byte draw costs a full DRBG generate plus the mandated
 * post-generate Update, which is four HMAC invocations for four bytes. That is
 * roughly two orders of magnitude more work than necessary and makes the SDK too
 * slow to use as a Math.random() replacement in a render loop, which is exactly
 * the use it is meant for.
 *
 * The fold is applied to the whole block at refill time, so the guarantee is
 * unchanged: every byte handed out is still a DRBG byte XOR an independent
 * platform byte. Served bytes are zeroed behind the cursor so a later state
 * capture cannot recover them.
 */
const OUTPUT_BUFFER_BYTES = 1024;

/**
 * Web Crypto rejects a getRandomValues request for more than 65536 bytes, so
 * the mask for a large output has to be drawn in pieces.
 */
const MAX_PLATFORM_DRAW = 65536;

/** Reseed once this many newly credited bits have accumulated. */
const RESEED_CREDIT_BITS = 128;
/** Reseed after this much output, regardless of new entropy. */
const RESEED_OUTPUT_BYTES = 64 * 1024;
/** Reseed after this long, if there is anything new to fold in. */
const RESEED_INTERVAL_MS = 30_000;

/** The slice of HmacDrbg the engine depends on, so tests can substitute it. */
export interface DrbgLike {
  generate(length: number, additional?: Uint8Array): Uint8Array;
  reseed(entropy: Uint8Array, additional?: Uint8Array): void;
}

export interface EngineOptions {
  platform: PlatformRandom;
  foldMode: FoldMode;
  rateCapBitsPerSecond: number;
  readyBits: number;
  blockUntilReady: boolean;
  crossOriginIsolated: boolean;
  origin: string;
  wallClock: () => number;
  now: () => number;
  onReseed?: (info: ReseedInfo) => void;
  /**
   * Test seam, alongside the injected platform/now/wallClock. Substituting a
   * degenerate DRBG here is how safety.test.mjs proves that output survives a
   * completely broken generator.
   */
  drbgFactory?: (seed: Uint8Array, nonce: Uint8Array, personalization: Uint8Array) => DrbgLike;
}

export interface ReseedInfo {
  index: number;
  at: number;
  creditedBits: number;
  bytesSinceLast: number;
}

export class NotReadyError extends Error {
  constructor(have: number, need: number) {
    super(
      `superandom: only ${have.toFixed(1)} of ${need} credited bits collected. ` +
        'Await ready(), or disable blockUntilReady.',
    );
    this.name = 'NotReadyError';
  }
}

export class Engine {
  readonly accumulator = new Accumulator();
  readonly estimator: Estimator;

  private readonly platform: PlatformRandom;
  private readonly options: EngineOptions;
  private readonly contextTag: Uint8Array;
  private readonly drbg: DrbgLike;

  private reseedIndex = 1;
  private bytesGenerated = 0;
  private bytesSinceReseed = 0;
  private creditedAtLastReseed = 0;
  private lastReseedAt: number;
  private materialSinceReseed = false;

  private buffer: Uint8Array = new Uint8Array(0);
  private bufferOffset = 0;

  private readonly waiters: { need: number; resolve: () => void }[] = [];

  constructor(options: EngineOptions) {
    this.options = options;
    this.platform = options.platform;

    // No silent degradation. If the platform CSPRNG is missing we cannot make
    // the "never worse than getRandomValues" guarantee, so we refuse to start
    // rather than quietly hand out mouse-derived bytes and call them secure.
    if (typeof this.platform?.getRandomValues !== 'function') {
      throw new Error(
        'superandom: crypto.getRandomValues is unavailable. Refusing to start, because ' +
          'the security guarantee depends on it.',
      );
    }

    if (options.foldMode === 'never') {
      // The caller has already had to pass iUnderstandTheRisk to get here.
      // Keep the warning anyway: this is the one setting that can make output
      // worse than the platform CSPRNG.
      // eslint-disable-next-line no-console
      console?.warn?.(
        'superandom: foldMode "never" disables the platform CSPRNG fold. Output now ' +
          'depends entirely on the harvested pool and this library being correct.',
      );
    }

    this.estimator = new Estimator({
      rateCapBitsPerSecond: options.rateCapBitsPerSecond,
      crossOriginIsolated: options.crossOriginIsolated,
    });

    // Per-instance domain separator: origin, plus fresh platform bytes so two
    // tabs on the same page never share a context tag.
    this.contextTag = sha256(
      CONTEXT_DOMAIN,
      utf8(options.origin),
      this.platformBytes(16),
    ).subarray(0, 16);

    const seed = this.seedMaterial();
    const makeDrbg =
      options.drbgFactory ?? ((s, n, p) => new HmacDrbg(s, n, p) as DrbgLike);
    this.drbg = makeDrbg(seed, this.platformBytes(16), PERSONALIZATION);
    wipe(seed);

    this.lastReseedAt = options.now();
    options.onReseed?.({
      index: this.reseedIndex,
      at: options.wallClock(),
      creditedBits: 0,
      bytesSinceLast: 0,
    });
  }

  private platformBytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    this.platform.getRandomValues(out);
    return out;
  }

  /**
   * Condense pool state and fresh platform entropy into 32 uniform bytes.
   *
   * The platform draw is unconditional and comes first. That is what makes a
   * degenerate pool harmless: with no human input at all, the DRBG is still
   * seeded from 256 bits of OS entropy.
   */
  private seedMaterial(): Uint8Array {
    const poolDigest = this.accumulator.harvest(this.reseedIndex);
    const platform = this.platformBytes(32);
    const ikm = concat(
      platform,
      poolDigest,
      u32le(this.reseedIndex),
      u64le(this.options.wallClock()),
      this.contextTag,
    );
    const seed = hkdfExtract(EXTRACT_SALT, ikm);
    wipe(platform);
    wipe(ikm);
    return seed;
  }

  /** Feed material to the pools and offer it to the estimator. */
  absorb(
    id: SourceId,
    bytes: Uint8Array,
    proposedBits: number,
    sample: number,
    trusted = true,
    at: number = this.options.now(),
  ): number {
    this.accumulator.absorb(id, bytes);
    this.estimator.noteBytes(id, bytes.length);
    const credited = this.estimator.propose(id, at, proposedBits, sample, trusted);
    if (bytes.length > 0) this.materialSinceReseed = true;
    if (credited > 0) this.settleWaiters();
    return credited;
  }

  /**
   * THE SAFETY PROPERTY.
   *
   * Output is XOR-folded with an independent, freshly drawn platform mask. For
   * any X independent of a uniform U, X xor U is uniform. X here is the whole
   * DRBG output, so:
   *
   *   - If the pool is empty, adversary-controlled, the estimator is wrong, or
   *     the vendored SHA-256 has a bug, output is still exactly as good as
   *     crypto.getRandomValues().
   *   - If the platform CSPRNG is the broken one (a bad VM seed at boot, a
   *     hooking extension, a Dual_EC-style backdoor), output is still as good as
   *     the DRBG.
   *
   * Both have to fail before anything is lost.
   *
   * The mask is drawn AFTER generate() and is never fed back into the pool. That
   * ordering is the independence requirement, and safety.test.mjs asserts the
   * call order rather than just the result.
   */
  randomBytes(length: number): Uint8Array {
    if (!Number.isInteger(length) || length < 0) {
      throw new Error('superandom: randomBytes length must be a non-negative integer');
    }
    if (this.options.blockUntilReady && !this.isReady()) {
      throw new NotReadyError(this.estimator.creditedBits(), this.options.readyBits);
    }
    if (length === 0) return new Uint8Array(0);

    this.maybeReseed();

    let out: Uint8Array;
    if (length >= OUTPUT_BUFFER_BYTES) {
      // Large requests go straight through rather than dribbling through a
      // smaller buffer.
      out = this.drbg.generate(length);
      this.fold(out);
    } else {
      out = new Uint8Array(length);
      let done = 0;
      while (done < length) {
        if (this.bufferOffset >= this.buffer.length) this.refill();
        const take = Math.min(length - done, this.buffer.length - this.bufferOffset);
        out.set(this.buffer.subarray(this.bufferOffset, this.bufferOffset + take), done);
        // Zero behind the cursor: bytes already handed out must not linger.
        this.buffer.fill(0, this.bufferOffset, this.bufferOffset + take);
        this.bufferOffset += take;
        done += take;
      }
    }

    this.bytesGenerated += length;
    this.bytesSinceReseed += length;
    return out;
  }

  private refill(): void {
    const block = this.drbg.generate(OUTPUT_BUFFER_BYTES);
    this.fold(block);
    this.buffer = block;
    this.bufferOffset = 0;
  }

  /**
   * XOR in an independent, freshly drawn platform mask. Drawn after generate(),
   * never fed back into the pool. See the class comment on randomBytes.
   */
  private fold(bytes: Uint8Array): void {
    if (this.options.foldMode !== 'always') return;

    // getRandomValues rejects any view longer than 65536 bytes, so the mask has
    // to be drawn in chunks. Each chunk is an independent draw, which is exactly
    // what the XOR argument wants anyway.
    for (let at = 0; at < bytes.length; at += MAX_PLATFORM_DRAW) {
      const end = Math.min(at + MAX_PLATFORM_DRAW, bytes.length);
      const mask = new Uint8Array(end - at);
      this.platform.getRandomValues(mask);
      for (let i = 0; i < mask.length; i++) {
        bytes[at + i] = (bytes[at + i] as number) ^ (mask[i] as number);
      }
      wipe(mask);
    }
  }

  private maybeReseed(): void {
    const credited = this.estimator.creditedBits();
    const newBits = credited - this.creditedAtLastReseed;
    const elapsed = this.options.now() - this.lastReseedAt;

    const due =
      newBits >= RESEED_CREDIT_BITS ||
      this.bytesSinceReseed >= RESEED_OUTPUT_BYTES ||
      (elapsed >= RESEED_INTERVAL_MS && this.materialSinceReseed);

    if (due) this.reseed();
  }

  /** @param extra optional caller-supplied material. Mixed, never credited. */
  reseed(extra?: Uint8Array): void {
    if (extra && extra.length > 0) {
      this.accumulator.absorb('manual', extra);
      this.estimator.noteBytes('manual', extra.length);
    }

    this.reseedIndex++;
    const seed = this.seedMaterial();
    this.drbg.reseed(seed);
    wipe(seed);

    // Drop buffered output: it predates the new state, and callers reasonably
    // expect a reseed to take effect on the very next draw.
    wipe(this.buffer);
    this.buffer = new Uint8Array(0);
    this.bufferOffset = 0;

    const credited = this.estimator.creditedBits();
    this.options.onReseed?.({
      index: this.reseedIndex,
      at: this.options.wallClock(),
      creditedBits: credited,
      bytesSinceLast: this.bytesSinceReseed,
    });

    this.creditedAtLastReseed = credited;
    this.bytesSinceReseed = 0;
    this.lastReseedAt = this.options.now();
    this.materialSinceReseed = false;
  }

  isReady(): boolean {
    return this.estimator.creditedBits() >= this.options.readyBits;
  }

  entropyBits(): number {
    return Math.round(this.estimator.creditedBits() * 1000) / 1000;
  }

  /**
   * Resolves once `bits` credited bits exist. Purely a provenance signal: the
   * output is already platform-grade before it resolves.
   */
  ready(bits: number = this.options.readyBits): Promise<void> {
    if (this.estimator.creditedBits() >= bits) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiters.push({ need: bits, resolve });
    });
  }

  private settleWaiters(): void {
    if (this.waiters.length === 0) return;
    const have = this.estimator.creditedBits();
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const waiter = this.waiters[i] as { need: number; resolve: () => void };
      if (have >= waiter.need) {
        this.waiters.splice(i, 1);
        waiter.resolve();
      }
    }
  }

  sourceStats(active: ReadonlySet<SourceId>): SourceStats[] {
    return this.estimator.snapshot(active);
  }

  get counters(): { reseeds: number; bytesGenerated: number } {
    return { reseeds: this.reseedIndex, bytesGenerated: this.bytesGenerated };
  }
}
