# superandom

Randomness harvested from the human at the keyboard, folded with the platform CSPRNG, with a verifiable audit receipt. One script tag, no dependencies, and **zero network calls, ever**.

```html
<script src="https://nader.io/pkg/superandom/superandom-v1.js"></script>
<script>
  superandom.randomInt(1, 7);        // a fair die
  superandom.shuffle(deck);          // an unbiased shuffle
  superandom.randomUUID();
</script>
```

```js
import { create } from 'superandom';

const rng = create();
rng.randomInt(1, 7);      // usable immediately
await rng.ready(256);     // optional: wait for the human to contribute
```

## What this actually claims

Read this part before deciding whether you want it.

**superandom is not "more random" than `crypto.getRandomValues()`.** The platform CSPRNG is seeded from OS entropy and is cryptographically sound. Anyone telling you their mouse-wiggle library beats it is selling something.

What superandom adds is three specific things:

1. **An independent entropy source.** Physical input from the person using the page, mixed in alongside the OS.
2. **An auditable process.** A publishable, offline-verifiable receipt of what was collected and when.
3. **A defensive posture.** A backdoored, hooked or badly-seeded platform CSPRNG stops being fatal.

The design target is precise: **provably never worse than `getRandomValues()`, plausibly better, and honest about which is which.**

### The safety property

Every byte handed out is XOR-folded with an independent, freshly drawn platform mask:

```js
const out  = drbg.generate(n);        // 1. DRBG first
const mask = new Uint8Array(n);
crypto.getRandomValues(mask);         // 2. independent draw, taken after
for (let i = 0; i < n; i++) out[i] ^= mask[i];
```

For any `X` independent of a uniform `U`, `X ⊕ U` is uniform. `X` here is the entire DRBG output. So:

- If the entropy pool is empty, the estimator is wrong, the pool is adversary-controlled, **or this library has a bug**, output is still exactly as good as `crypto.getRandomValues()`.
- If the *platform* CSPRNG is the broken one, output is still as good as the DRBG.

Both have to fail before you lose anything. Platform entropy is also drawn at construction and at every reseed, so a visitor who never moves the mouse is not a degraded case.

`test/safety.test.mjs` substitutes each broken component in turn and asserts the call ordering that makes the XOR argument valid.

### Why there are no weather feeds, beacons or blockchains

This started out planning to mix in Bitcoin block hashes, drand, space weather and planetary positions. All of it was cut, and the reasoning generalises: **min-entropy is measured relative to what an adversary knows.** A value published to the world is not secret from anyone, so a public feed contributes exactly zero secret bits no matter how physically chaotic its origin.

- **Astronomical positions** are a deterministic function of the clock. The attacker has the same clock. Zero bits, by construction.
- **Weather APIs** serve model output, identical for every visitor, and asking for local conditions leaks the visitor's location to a third party.
- **Bitcoin blocks, drand, the NIST beacon** are genuinely unpredictable *before* publication and public *after*. They can anchor a timestamp. They cannot add secrecy.

Cutting them made the library strictly better rather than poorer: no CORS, no rate limits, no third-party dependency, no consent surface, works offline, and *nothing ever leaves the browser* becomes an unqualified guarantee.

That guarantee is enforced, not just promised. The build greps the minified bundle for `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `geolocation`, `RTCPeerConnection` and `importScripts`, and fails on a hit. A test does the same, so the check cannot be lost by editing the build script.

## Install

```
npm install superandom
```

Or pin the exact version with subresource integrity:

```html
<script
  src="https://nader.io/pkg/superandom/superandom-1.0.1.js"
  integrity="sha384-KHbMCgMbr9rYArINMOMDvBL1wU5njaZGuhFK99Sg/RHnSkXVxmks5btzVHsFoPgH"
  crossorigin="anonymous"></script>
```

Only the exact-version filename can be pinned. `superandom-v1.js` moves by design, so treat it as demo-only.

## Configuration

Every option is a `data-` attribute on the script tag, or a key passed to `create()`.

| Attribute | Default | Meaning |
|---|---|---|
| `data-auto` | `true` | Auto-initialise from this script tag |
| `data-global` | `superandom` | Global to install the instance on |
| `data-sources` | all but `motion` | Comma-separated collectors |
| `data-motion` | `off` | `ask` allows `requestMotion()`; nothing ever auto-prompts |
| `data-ready-bits` | `256` | Threshold at which `ready()` resolves |
| `data-block-until-ready` | `false` | Throw below the threshold instead of generating |
| `data-fold` | `always` | `always`, `reseed-only`, `never` |
| `data-rate-cap` | `64` | Ceiling on credited bits per second |
| `data-receipt` | `true` | Record an audit receipt |

## API

```ts
random(): number                                  // [0,1), full 53-bit mantissa
randomBytes(n): Uint8Array
randomInt(min, maxExclusive): number              // unbiased, rejection sampling
randomBigInt(maxExclusive): bigint
randomUUID(): string                              // RFC 9562 v4, works on plain HTTP
randomString(len, alphabet?): string              // base58 by default
choice(items) / sample(items, k) / weighted(items, weights)
shuffle(items) / shuffleInPlace(items)            // Fisher-Yates
gaussian(mean?, stdDev?) / exponential(lambda?)

ready(bits?): Promise<void>
entropyBits(): number
stats(): Stats
sources(): SourceStats[]
subscribe(cb, intervalMs?): () => void
start() / stop() / destroy()
reseed(extra?: BufferSource)
requestMotion(): Promise<boolean>                 // must be called from a user gesture
receipt(): Receipt | null
```

`randomInt` uses rejection sampling rather than `%`. The shortcut is biased whenever the range does not divide the source's cardinality, and how bad that is depends on the draw width: over a full 32-bit draw the skew is around 2⁻³⁰ and unobservable, while the very common `randomBytes(1)[0] % range` is off by several percent. `test/bias.test.mjs` measures both and asserts the shortcuts fail the same chi-square harness the real implementation passes, so those thresholds are known to have teeth.

## Entropy accounting

Credit is deliberately pessimistic. Getting these numbers wrong cannot compromise output, because output quality rests on the fold, not the estimate. An overestimate produces a premature `ready`, which is a provenance error, not a cryptographic one.

| Source | Credit/sample | Session cap | Why |
|---|---|---|---|
| `pointer` | 2 (4 for buttons, +1 for pen) | 640 | Paths are strongly autocorrelated. The entropy is in delta low bits and sub-millisecond arrival timing, not position. |
| `keyboard` | 1 | 256 | Interval only. Keystroke-timing studies put roughly 1.2 bits in an interval. |
| `touch` | 2, or 4 on contact | 512 | As pointer, plus real contact geometry. |
| `scroll` | 1 | 128 | Wheel deltas are heavily quantised; the entropy is the timing. |
| `raf` | 0.5 | 64 | Most of a frame delta is deterministic vsync. |
| `clock` | 0.125 | 32 | `performance.now()` is clamped to 100µs (5µs cross-origin isolated), so most readings are zero. |
| `motion` | 2 | 128 | Genuine MEMS noise floor. |
| `render` | 0.25 | 32 | Draw duration only. |
| `ambient` | 1 | 32 | Timing of rare environment changes. |
| `manual` | **0** | **0** | Caller-supplied via `reseed()`. Mixed, never credited: the library cannot audit where it came from. |

Three guards matter more than the numbers:

- **`event.isTrusted === false` earns zero.** Otherwise any extension dispatching events could fake a full pool.
- **A global rate limit**, 64 credited bits/second by default, so no flood can outrun what a human could plausibly produce.
- **The two SP 800-90B §4.4 continuous health tests.** A source that trips one drops to zero credit and is flagged `unhealthy` in `stats()`. This is what catches a stuck sensor, a replayed path or a bot: a pointer arriving on an exact 20ms cadence is not a human, and is treated accordingly.

## Privacy

- Keystroke **content** is never read. The collector absorbs the interval between events and nothing else, and its test makes `key`, `code`, `keyCode`, `which` and `target` throwing getters to prove it.
- Canvas pixels are never read. A canvas hash is a stable fingerprint: zero entropy, and a precise tracking identifier. Refused on both counts.
- No user-agent, screen, font or plugin enumeration. Those are fingerprints, not entropy.
- Nothing is written to `localStorage`, `sessionStorage`, `indexedDB` or cookies. Persisting DRBG state across sessions would weaken forward secrecy *and* create a tracking supercookie.
- No network requests. See above.

## The receipt

```js
const receipt = rng.receipt();
verifyReceipt(receipt);   // { ok: true }
```

A hash chain over **public metadata**: reseed count, which sources contributed, how many events each produced, whether their health tests were passing, and when. Altering any of it breaks the chain, and `verifyReceipt` reports exactly which epoch failed.

It commits to no secret. Not the pool, not the seed, not the output. So it is safe to publish and verifiable offline by anyone.

What it does **not** prove: that the output was unpredictable. Nothing running in a browser can prove that. There is also no external time anchor, so timestamps are self-asserted by the page. A commit-and-reveal mode for lottery-style use is **not implemented**.

## How it works

1. **Collectors** absorb events into a staging buffer and return. Hashing never happens inside an input handler; it is flushed on idle. Listeners are passive (so they cannot delay scrolling) and in the capture phase (so page code calling `stopPropagation()` cannot starve them).
2. **An eight-pool Fortuna accumulator** takes the material, length-prefixed and source-tagged so the encoding is injective. A single running hash would let an attacker who learns the state brute-force each small increment and stay synchronised; the pool schedule defeats that *without needing the entropy estimate to be correct*, which matters because estimating the entropy of a mouse is guesswork.
3. **HKDF-Extract** conditions the pool digest plus fresh platform bytes into a seed. HMAC as a randomness extractor handles arbitrarily structured input; von Neumann debiasing would be wrong here, since it assumes i.i.d. bits and a mouse path is the opposite of i.i.d.
4. **HMAC-DRBG-SHA-256** (SP 800-90A §10.1.2) generates. Its mandated post-generate update is a free forward-secrecy ratchet.
5. **The fold** XORs in an independent platform mask. See above.

SHA-256 is vendored rather than using `crypto.subtle` because subtle is Promise-only, and an async `random()` cannot be used in a `shuffle()`, a render loop, or inline in an expression, so people would just keep `Math.random()` for the hot path.

## Testing

```
npm test        # builds, then tests the built artifact
npm run typecheck
```

140 tests. The primitives are pinned by known-answer vectors: FIPS 180-4 for SHA-256, RFC 4231 for HMAC, RFC 5869 for HKDF, and the RFC 6979 §A.2.5 deterministic nonce for the DRBG, which exercises instantiate, update and generate against a published 256-bit constant. The DRBG is additionally differential-tested against a second implementation written from the SP 800-90A pseudocode.

Output goes through an SP 800-22 battery (monobit, block frequency, runs, longest-run), a byte chi-square, serial correlation and a compression check. Each runs at α = 0.001 over ten independent instances, requiring nine passes: loosening α until tests stop flaking would also stop them meaning anything, and a genuinely broken generator fails all ten, not one.

## Status

**This is unaudited cryptographic code.** It has known-answer tests, a statistical battery and a safety argument, none of which is a security audit. The fold means the realistic worst case is that you get exactly `crypto.getRandomValues()`, which is the point of the design, but do not treat "unaudited" as a formality.

The NIST CAVP DRBG vector archive was unreachable from the environment this was built in, so those `.rsp` files are not vendored yet. That is the highest-value contribution available.

## License

MIT. See [LICENSE](LICENSE).
