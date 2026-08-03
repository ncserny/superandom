/**
 * Build superandom.
 *
 *   node scripts/build.mjs [--site-dir=<path>]
 *
 * Emits, into build/:
 *   superandom-<version>.js      IIFE, minified, auto-initialising. The script-tag artifact.
 *   superandom-<version>.js.map  external sourcemap
 *   superandom-v<major>.js       moving alias of the above, for demos only (cannot be SRI-pinned)
 *   index.mjs                    ESM entry for bundlers and npm
 *   index.d.ts                   types, emitted by tsc
 *   manifest.json                versions, byte counts and SRI hashes
 *
 * plus test/.generated/internal.mjs, the unsupported internals the suite uses.
 *
 * Then verifies the shipped bundle makes no network calls and computes SRI
 * hashes. Pass --site-dir to also copy the browser artifacts somewhere they get
 * served, e.g. the nader.io Astro site:
 *
 *   node scripts/build.mjs --site-dir=/path/to/nader-io/assets/pkg/superandom
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(pkgDir, 'build');
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const version = pkg.version;
const major = version.split('.')[0];

const siteDirArg = process.argv.find((a) => a.startsWith('--site-dir='));
const siteDir = siteDirArg ? resolve(siteDirArg.slice('--site-dir='.length)) : null;

const banner = `/*! superandom v${version} | MIT | https://github.com/ncserny/superandom */`;

/**
 * The bundle promises it never talks to the network. That promise is worth
 * exactly as much as its enforcement, so we grep the *minified output* for
 * every API that could break it and fail the build on a hit. Minifiers cannot
 * rename these: they are property lookups on host objects.
 */
const FORBIDDEN_NETWORK_APIS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'sendBeacon',
  'geolocation',
  'RTCPeerConnection',
  'importScripts',
  'navigator.sendBeacon',
];

function assertNoNetwork(label, source) {
  const hits = FORBIDDEN_NETWORK_APIS.filter((api) => source.includes(api));
  if (hits.length > 0) {
    console.error(`\n  ${label} references network APIs: ${hits.join(', ')}`);
    console.error('  superandom guarantees zero network calls. Remove them, or retire the');
    console.error('  guarantee in README.md first. Do not weaken this check.\n');
    process.exit(1);
  }
  console.log(`  no-network check passed (${label})`);
}

function sri(bytes) {
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
}

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

console.log(`building superandom v${version}`);

// 1. IIFE for the script tag. Auto-initialises and installs the globals.
const iifeName = `superandom-${version}.js`;
await esbuild.build({
  entryPoints: [join(pkgDir, 'src', 'browser.ts')],
  outfile: join(buildDir, iifeName),
  bundle: true,
  format: 'iife',
  globalName: 'Superandom',
  target: ['es2020'],
  minify: true,
  sourcemap: 'external',
  legalComments: 'none',
  banner: { js: banner },
});

// 2. ESM for bundlers and npm. No auto-init, no globals, no side effects.
await esbuild.build({
  entryPoints: [join(pkgDir, 'src', 'index.ts')],
  outfile: join(buildDir, 'index.mjs'),
  bundle: true,
  format: 'esm',
  target: ['es2020'],
  minify: false,
  sourcemap: 'external',
  legalComments: 'none',
  banner: { js: banner },
});

// 3. Internal bundle, so tests exercise the built code rather than a second
//    compilation of the same source.
//
//    Deliberately emitted outside build/. Anything under build/ is listed in
//    package.json "files", and entries there cannot be excluded by .npmignore,
//    so leaving it in build/ would ship 67 KB of test-only re-exports to every
//    consumer.
const testBuildDir = join(pkgDir, 'test', '.generated');
mkdirSync(testBuildDir, { recursive: true });
await esbuild.build({
  entryPoints: [join(pkgDir, 'src', 'internal.ts')],
  outfile: join(testBuildDir, 'internal.mjs'),
  bundle: true,
  format: 'esm',
  target: ['es2020'],
  minify: false,
  legalComments: 'none',
});

// 4. Types.
execFileSync(process.execPath, [join(pkgDir, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(pkgDir, 'tsconfig.json')], {
  stdio: 'inherit',
  cwd: pkgDir,
});

const iifeBytes = readFileSync(join(buildDir, iifeName));
const esmBytes = readFileSync(join(buildDir, 'index.mjs'));

assertNoNetwork(iifeName, iifeBytes.toString('utf8'));
assertNoNetwork('index.mjs', esmBytes.toString('utf8'));

// 5. Moving major alias. Documented as demo-only: a moving target cannot be SRI-pinned.
const aliasName = `superandom-v${major}.js`;
copyFileSync(join(buildDir, iifeName), join(buildDir, aliasName));

const manifest = {
  name: 'superandom',
  version,
  // Deliberately no build timestamp: it would churn the committed artifact on
  // every rebuild and defeat reproducible-output comparison.
  files: {
    pinned: iifeName,
    alias: aliasName,
    esm: 'index.mjs',
    types: 'index.d.ts',
  },
  bytes: {
    [iifeName]: iifeBytes.length,
    [aliasName]: iifeBytes.length,
  },
  integrity: {
    [iifeName]: sri(iifeBytes),
  },
  note: 'Only the pinned filename may be used with subresource integrity. The alias moves by design.',
};
writeFileSync(join(buildDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`  ${iifeName}  ${(iifeBytes.length / 1024).toFixed(1)} KiB`);
console.log(`  ${manifest.integrity[iifeName]}`);

// 6. Optionally publish the browser artifacts wherever they get served. For
//    nader.io that is assets/pkg/superandom/, which Astro's publicDir maps to the
//    site root, so it lands on https://nader.io/pkg/superandom/x.js.
if (siteDir) {
  mkdirSync(siteDir, { recursive: true });
  for (const f of [iifeName, `${iifeName}.map`, aliasName, 'manifest.json']) {
    copyFileSync(join(buildDir, f), join(siteDir, f));
  }
  console.log(`  copied to ${siteDir}`);
}

console.log('done');
