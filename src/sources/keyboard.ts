/**
 * Keyboard entropy: inter-event timing, and nothing else.
 *
 * PRIVACY CONTRACT, load-bearing. This collector must never read `key`, `code`,
 * `keyCode`, `which`, `target.value` or any other property that could reveal
 * what was typed. Only the interval between events is absorbed. A randomness
 * library that harvests keystroke content is a keylogger, whatever it hashes the
 * result with.
 *
 * The absorb path here takes a single number for exactly this reason: there is
 * no parameter through which key identity could travel. sources.test.mjs
 * enforces it by making those properties throwing getters and asserting they are
 * never touched.
 *
 * On the credit: keystroke-timing studies put roughly 1.2 bits of information in
 * an inter-key interval, so we claim 1.
 */

import type { CollectorId } from '../types.js';
import { ListenerBag, Scratch, healthSample } from './base.js';
import type { Collector, CollectorContext } from './base.js';

const KEY_BITS = 1;

export function createKeyboardCollector(): Collector {
  const bag = new ListenerBag();
  const scratch = new Scratch();
  let context: CollectorContext | null = null;
  let lastAt: number | null = null;

  const id: CollectorId = 'keyboard';

  /**
   * @param event only `timeStamp` and `isTrusted` are ever read. Do not widen
   *              this signature.
   */
  function onKey(rawEvent: never): void {
    const event = rawEvent as { timeStamp?: number; isTrusted?: boolean };
    const at = event.timeStamp ?? context?.now() ?? 0;
    const interval = lastAt === null ? 0 : at - lastAt;
    lastAt = at;

    // The first event of a session has no interval to measure, so it earns
    // nothing. Absorbing it anyway costs nothing and keeps the stream aligned.
    const bits = interval > 0 ? KEY_BITS : 0;

    scratch.reset().f64(interval);
    context?.absorb(id, scratch.bytes(), bits, healthSample(interval), event.isTrusted !== false, at);
  }

  return {
    id,
    start(ctx) {
      context = ctx;
      bag.add(ctx.target, 'keydown', onKey);
      bag.add(ctx.target, 'keyup', onKey);
    },
    stop() {
      bag.removeAll();
      context = null;
      lastAt = null;
    },
  };
}
