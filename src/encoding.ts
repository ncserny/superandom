/**
 * Byte and integer encoding helpers.
 *
 * Everything the accumulator absorbs is length-prefixed and tagged, so these
 * need to be exact. See accumulator.ts for why injectivity matters.
 */

export function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function u8(value: number): Uint8Array {
  return new Uint8Array([value & 0xff]);
}

export function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
}

export function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
}

/** Little-endian u64 from a JS number. Safe up to 2^53, which covers every timestamp. */
export function u64le(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(Math.trunc(value)), true);
  return out;
}

/**
 * The full 64 bits of a double, including the mantissa. Used for timing values
 * where the low mantissa bits are the entire point: `event.timeStamp` and
 * `performance.now()` carry sub-millisecond jitter down there.
 */
export function f64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value, true);
  return out;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const HEX = '0123456789abcdef';

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    out += HEX[b >>> 4];
    out += HEX[b & 0x0f];
  }
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('superandom: hex string has odd length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('superandom: invalid hex string');
    out[i] = byte;
  }
  return out;
}

/** Overwrite a buffer in place. Best effort: the engine can't stop the GC from having copied it. */
export function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}

/** Constant-time equality, so callers comparing digests don't leak timing. */
export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
