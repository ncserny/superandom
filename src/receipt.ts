/**
 * Audit receipt: a tamper-evident log of the collection process.
 *
 * What this proves, stated plainly, because the temptation to overclaim here is
 * enormous: the receipt is a hash chain over *public metadata* about how
 * entropy was gathered. Reseed count, which sources contributed, how many events
 * each produced, whether their health tests were passing, and when. Altering any
 * of that after the fact breaks the chain and verifyReceipt says exactly where.
 *
 * What it does not prove: that the output was unpredictable. Nothing running in
 * a browser can prove that, and any library claiming otherwise is selling
 * something. There is also no external time anchor, so the timestamps are
 * self-asserted by the page that produced them.
 *
 * The commitment deliberately binds no secret. Not the pool digest, not the
 * seed, not the output. So a receipt is safe to publish, is verifiable offline
 * by anyone, and leaking one reveals nothing about the keys. receipt.test.mjs
 * asserts no seed byte ever appears in the serialised form.
 */

import { sha256 } from './sha256.js';
import { f64, toHex, u32le, u64le, u8, utf8, fromHex } from './encoding.js';
import { SOURCE_TAG, type SourceId } from './types.js';

const COMMIT_DOMAIN = utf8('superandom/commit/1');
const META_DOMAIN = utf8('superandom/meta/1');
const GENESIS_DOMAIN = utf8('superandom/genesis/1');

export const RECEIPT_VERSION = 'superandom-receipt-1';

export interface ReceiptContributor {
  id: SourceId;
  events: number;
  creditedBits: number;
  healthy: boolean;
}

export interface ReceiptEpoch {
  /** Reseed index this epoch describes. */
  n: number;
  /** Wall-clock time, as asserted by the page. */
  at: number;
  /** Commitment of the previous epoch, or the genesis digest for the first. */
  prev: string;
  commit: string;
  creditedBits: number;
  outputBytesSinceLast: number;
  contributors: ReceiptContributor[];
}

export interface Receipt {
  version: typeof RECEIPT_VERSION;
  id: string;
  origin: string;
  startedAt: number;
  epochs: ReceiptEpoch[];
  head: string;
}

export interface VerificationResult {
  ok: boolean;
  /** Index of the first epoch that failed, when ok is false. */
  brokenAt?: number;
  reason?: string;
}

function genesis(id: string, origin: string, startedAt: number): Uint8Array {
  return sha256(GENESIS_DOMAIN, utf8(id), utf8(origin), u64le(startedAt));
}

/**
 * Digest of an epoch's metadata, built by explicit field concatenation rather
 * than JSON so that verification never depends on key ordering or number
 * formatting.
 */
function metaDigest(epoch: Omit<ReceiptEpoch, 'commit' | 'prev'>): Uint8Array {
  const parts: Uint8Array[] = [
    META_DOMAIN,
    u32le(epoch.n),
    u64le(epoch.at),
    f64(epoch.creditedBits),
    u64le(epoch.outputBytesSinceLast),
    u32le(epoch.contributors.length),
  ];
  for (const contributor of epoch.contributors) {
    parts.push(
      u8(SOURCE_TAG[contributor.id] ?? 0),
      u32le(contributor.events),
      f64(contributor.creditedBits),
      u8(contributor.healthy ? 1 : 0),
    );
  }
  return sha256(...parts);
}

function commitment(prev: Uint8Array, epoch: Omit<ReceiptEpoch, 'commit' | 'prev'>): Uint8Array {
  return sha256(COMMIT_DOMAIN, prev, u32le(epoch.n), u64le(epoch.at), metaDigest(epoch));
}

export class ReceiptLog {
  private readonly epochs: ReceiptEpoch[] = [];
  private previous: Uint8Array;

  constructor(
    private readonly id: string,
    private readonly origin: string,
    private readonly startedAt: number,
  ) {
    this.previous = genesis(id, origin, startedAt);
  }

  record(entry: Omit<ReceiptEpoch, 'commit' | 'prev'>): void {
    const commit = commitment(this.previous, entry);
    this.epochs.push({
      ...entry,
      contributors: entry.contributors.map((c) => ({ ...c })),
      prev: toHex(this.previous),
      commit: toHex(commit),
    });
    this.previous = commit;
  }

  get head(): string {
    return toHex(this.previous);
  }

  get length(): number {
    return this.epochs.length;
  }

  toJSON(): Receipt {
    return {
      version: RECEIPT_VERSION,
      id: this.id,
      origin: this.origin,
      startedAt: this.startedAt,
      epochs: this.epochs.map((e) => ({ ...e, contributors: e.contributors.map((c) => ({ ...c })) })),
      head: this.head,
    };
  }
}

/**
 * Recompute the chain. Anyone can run this against a published receipt with no
 * access to the page that produced it.
 */
export function verifyReceipt(receipt: Receipt): VerificationResult {
  if (!receipt || receipt.version !== RECEIPT_VERSION) {
    return { ok: false, reason: 'unrecognised receipt version' };
  }
  if (!Array.isArray(receipt.epochs)) {
    return { ok: false, reason: 'receipt has no epochs' };
  }

  let previous = genesis(receipt.id, receipt.origin, receipt.startedAt);

  for (let i = 0; i < receipt.epochs.length; i++) {
    const epoch = receipt.epochs[i] as ReceiptEpoch;

    if (epoch.prev !== toHex(previous)) {
      return { ok: false, brokenAt: epoch.n, reason: `epoch ${i} does not follow its predecessor` };
    }

    const expected = commitment(previous, {
      n: epoch.n,
      at: epoch.at,
      creditedBits: epoch.creditedBits,
      outputBytesSinceLast: epoch.outputBytesSinceLast,
      contributors: epoch.contributors ?? [],
    });

    if (epoch.commit !== toHex(expected)) {
      return { ok: false, brokenAt: epoch.n, reason: `epoch ${i} commitment does not match` };
    }
    previous = expected;
  }

  if (receipt.head !== toHex(previous)) {
    return { ok: false, reason: 'head does not match the final epoch' };
  }
  return { ok: true };
}

/** Re-export so verifiers can round-trip hex without importing internals. */
export { toHex as receiptToHex, fromHex as receiptFromHex };
