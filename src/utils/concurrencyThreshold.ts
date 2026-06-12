'use strict';

import { availableParallelism } from 'node:os';

export function getConcurrencyThreshold(): number {
  /* v8 ignore next */
  const AVAILABLE_PARALLELISM: number = availableParallelism ? availableParallelism() : Infinity;

  return Math.min(AVAILABLE_PARALLELISM, 6);
}
