/**
 * Ambient environment changes.
 *
 * Connectivity flips, tab visibility, window resizes. These are rare and their
 * values are coarse, so what is absorbed is essentially when they happened. Low
 * yield, but free: the listeners cost nothing while nothing is happening.
 */

import type { CollectorId } from '../types.js';
import { ListenerBag, Scratch, healthSample, isTrusted } from './base.js';
import type { Collector, CollectorContext } from './base.js';

const AMBIENT_BITS = 1;

const EVENTS = ['online', 'offline', 'visibilitychange', 'resize', 'pageshow', 'focus', 'blur'];

export function createAmbientCollector(): Collector {
  const bag = new ListenerBag();
  const scratch = new Scratch();
  let context: CollectorContext | null = null;
  let lastAt: number | null = null;
  let sequence = 0;

  const id: CollectorId = 'ambient';

  function onAmbient(rawEvent: never): void {
    const event = rawEvent as { type?: string; timeStamp?: number; isTrusted?: boolean };
    const at = event.timeStamp ?? context?.now() ?? 0;
    const interval = lastAt === null ? 0 : at - lastAt;
    lastAt = at;

    // The event type is a tiny, low-entropy label, so it goes in as a domain
    // separator rather than as claimed entropy.
    const typeIndex = EVENTS.indexOf(event.type ?? '');
    scratch
      .reset()
      .f64(at)
      .f64(interval)
      .u8(typeIndex < 0 ? 255 : typeIndex)
      .i32(sequence++);

    context?.absorb(
      id,
      scratch.bytes(),
      AMBIENT_BITS,
      healthSample(interval || at),
      isTrusted(event),
      at,
    );
  }

  return {
    id,
    start(ctx) {
      context = ctx;
      for (const type of EVENTS) bag.add(ctx.target, type, onAmbient);

      // Network Information is absent in Firefox and Safari. Feature-detect and
      // move on: a missing optional source is not an error.
      const connection = ctx.navigatorRef?.connection;
      if (connection && typeof connection.addEventListener === 'function') {
        bag.add(connection as never, 'change', onAmbient);
      }
    },
    stop() {
      bag.removeAll();
      context = null;
      lastAt = null;
    },
  };
}
