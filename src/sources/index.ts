/**
 * Collector registry.
 */

import type { CollectorId } from '../types.js';
import type { Collector } from './base.js';
import { createPointerCollector } from './pointer.js';
import { createKeyboardCollector } from './keyboard.js';
import { createTouchCollector } from './touch.js';
import { createScrollCollector } from './scroll.js';
import { createRafCollector } from './raf.js';
import { createClockCollector } from './clock.js';
import { createMotionCollector } from './motion.js';
import { createRenderCollector } from './render.js';
import { createAmbientCollector } from './ambient.js';

export * from './base.js';
export {
  createPointerCollector,
  createKeyboardCollector,
  createTouchCollector,
  createScrollCollector,
  createRafCollector,
  createClockCollector,
  createMotionCollector,
  createRenderCollector,
  createAmbientCollector,
};

const FACTORIES: Record<CollectorId, () => Collector> = {
  pointer: createPointerCollector,
  keyboard: createKeyboardCollector,
  touch: createTouchCollector,
  scroll: createScrollCollector,
  raf: createRafCollector,
  clock: createClockCollector,
  motion: createMotionCollector,
  render: createRenderCollector,
  ambient: createAmbientCollector,
};

export function createCollector(id: CollectorId): Collector {
  const factory = FACTORIES[id];
  if (!factory) throw new Error(`superandom: unknown source "${id}"`);
  return factory();
}
