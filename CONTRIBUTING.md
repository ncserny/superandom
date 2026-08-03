# Contributing

```
npm install
npm test          # builds, then tests the built artifact
npm run typecheck
```

Tests import from `build/`, not `src/`. That is deliberate: for a security library you want to test what actually ships, minifier output included.

## Rules that are not up for negotiation

These exist because each one is load-bearing for a claim in the README. If you want to change one, the README claim has to change in the same pull request.

**No runtime dependencies. Ever.** Two devDependencies (esbuild, typescript) and nothing else. A supply-chain compromise in a randomness library is about the worst place to have one.

**No network calls.** The build greps the minified bundle for `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `geolocation`, `RTCPeerConnection` and `importScripts` and fails on a hit. `test/integration.test.mjs` asserts the same, so the guarantee survives someone editing the build script. If you genuinely need to retire this, retire it in the README first.

**No storage.** No `localStorage`, `sessionStorage`, `indexedDB` or cookies. Persisting DRBG state would weaken forward secrecy and hand the page a tracking supercookie. Also enforced by a test.

**Never touch the crypto core without known-answer vectors.** `src/sha256.ts` and `src/drbg.ts` are covered by FIPS 180-4, RFC 4231, RFC 5869 and RFC 6979 vectors. Vendored crypto without KATs is malpractice. Do not adjust a vector to make a test pass.

**Never weaken the fold.** `Engine.randomBytes` XOR-folding output with an independent platform mask is the entire reason this library can claim it is never worse than `crypto.getRandomValues()`. The mask must be drawn *after* `generate()` and must never be fed back into the pool. `test/safety.test.mjs` asserts the call ordering, not just the result.

**Never raise an entropy cap to make a number look better.** The caps in `src/types.ts` are pessimistic on purpose. If a source seems to be under-crediting, the usual reason is that the bits genuinely are not there: `performance.now()` really is clamped to 100µs, and a mouse path really is autocorrelated. Raising a cap does not create entropy, it just makes `ready()` lie.

**The keyboard collector reads timing only.** Never `key`, `code`, `keyCode`, `which`, `charCode` or `target`. Its absorb path takes a single number so there is no parameter through which key identity could travel. The test enforces this with throwing getters.

**The render collector never reads pixels.** A canvas hash is a stable fingerprint: worth zero entropy, and a precise tracking identifier. Timing only.

**No public feeds as credited entropy.** Beacons, block hashes, weather and ephemerides were all considered and cut. A value published to the world is not secret from an adversary, so it contributes zero secret bits. If one ever returns it must come in through a separate path with no credit parameter, and the no-network guarantee has to be explicitly retired rather than quietly broken.

## Style

Match the surrounding code. Comments explain *why*, especially where a choice looks odd: the pool count, the credit numbers, the sync hash, the buffer size. Those all have reasons, and the reasons are the valuable part.

## Wanted

- **NIST CAVP DRBG vectors.** The archive at csrc.nist.gov was unreachable from the environment this was built in, so `drbgtestvectors` is not vendored. This is the highest-value contribution available.
- More SP 800-22 tests: spectral, approximate entropy, cumulative sums.
- Real-browser measurement of the credit caps. They are argued from the literature, not measured on hardware, and better numbers would be welcome.
- A security review, by anyone qualified.

## Security issues

Do not open a public issue. Email nader@cserny.com.
