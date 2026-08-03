/**
 * Script-tag entry point.
 *
 * Bundled as an IIFE under the global `Superandom`, this reads the `data-*`
 * attributes off its own <script> element and starts collecting, so a page can
 * use it without writing any setup code:
 *
 *   <script src="https://nader.io/rng/superandom-1.0.0.js"></script>
 *   <script>superandom.randomInt(1, 7)</script>
 */

import { create, VERSION } from './index.js';
import type { CollectorId, FoldMode, SuperandomOptions } from './types.js';
import { ALL_COLLECTORS } from './types.js';
import type { Rng } from './rng.js';

export * from './index.js';

interface ScriptLike {
  getAttribute(name: string): string | null;
  src?: string;
}

/** `document.currentScript` is valid here: the IIFE runs synchronously during parse. */
function locateScript(): ScriptLike | null {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) return null;

  const current = doc.currentScript as ScriptLike | null;
  if (current) return current;

  // Fallback for deferred or module-rewritten loads, where currentScript is null.
  const candidates = doc.querySelectorAll?.('script[src*="superandom"]');
  if (candidates && candidates.length > 0) {
    return candidates[candidates.length - 1] as unknown as ScriptLike;
  }
  return null;
}

function readBoolean(script: ScriptLike, name: string, fallback: boolean): boolean {
  const raw = script.getAttribute(name);
  if (raw === null) return fallback;
  return raw !== 'false' && raw !== 'off' && raw !== '0';
}

function readNumber(script: ScriptLike, name: string, fallback: number): number {
  const raw = script.getAttribute(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function readSources(script: ScriptLike): readonly CollectorId[] | undefined {
  const raw = script.getAttribute('data-sources');
  if (raw === null) return undefined;

  const requested = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean) as CollectorId[];

  const unknown = requested.filter((id) => !ALL_COLLECTORS.includes(id));
  if (unknown.length > 0) {
    // Warn rather than throw: a typo in an attribute should not take a page down.
    console?.warn?.(
      `superandom: ignoring unknown source(s) in data-sources: ${unknown.join(', ')}`,
    );
  }
  return requested.filter((id) => ALL_COLLECTORS.includes(id));
}

export function optionsFromScript(script: ScriptLike): SuperandomOptions {
  const options: SuperandomOptions = {};

  const sources = readSources(script);
  if (sources) options.sources = sources;

  // Motion needs a user gesture on iOS, so the attribute only ever grants
  // permission to ask. Nothing prompts without an explicit requestMotion() call.
  if (script.getAttribute('data-motion') === 'ask' && sources) {
    options.sources = sources.includes('motion') ? sources : [...sources, 'motion'];
  }

  const fold = script.getAttribute('data-fold');
  if (fold === 'always' || fold === 'reseed-only' || fold === 'never') {
    options.foldMode = fold as FoldMode;
  }

  options.readyBits = readNumber(script, 'data-ready-bits', 256);
  options.rateCapBitsPerSecond = readNumber(script, 'data-rate-cap', 64);
  options.blockUntilReady = readBoolean(script, 'data-block-until-ready', false);
  options.receipt = readBoolean(script, 'data-receipt', true);

  return options;
}

function autoInit(): Rng | null {
  const script = locateScript();
  if (!script) return null;
  if (!readBoolean(script, 'data-auto', true)) return null;

  try {
    const instance = create(optionsFromScript(script));
    const name = script.getAttribute('data-global') || 'superandom';
    (globalThis as Record<string, unknown>)[name] = instance;
    return instance;
  } catch (error) {
    // A failure here must not break the host page. The namespace is still
    // installed, so the page can call create() itself and see the real error.
    console?.error?.('superandom: auto-initialisation failed.', error);
    return null;
  }
}

export const auto: Rng | null = autoInit();
export { VERSION };
