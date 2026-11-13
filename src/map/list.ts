'use strict';

import { resolve } from 'node:path';

import { listTests } from '../core/listTests.js';
import { Io, MapError, MapOptions } from './types.js';

/**
 * Shows which tests apextestlist selects, with the same logic as
 * `sf apextests list`, without the Salesforce CLI.
 */
export async function list(opts: MapOptions, io: Io): Promise<void> {
  if (opts.filterByMetadata && !opts.manifest) throw new MapError('--filter-by-metadata needs --manifest <file>');
  const warnings: string[] = [];
  let result;
  try {
    result = await listTests({
      format: 'sf',
      manifest: opts.manifest,
      ignoreMissingTests: opts.ignoreMissingTests,
      ignoreDirs: opts.ignore,
      filterByMetadata: opts.filterByMetadata,
      projectDir: opts.project ? resolve(opts.project) : undefined,
      warn: (message: string) => warnings.push(message),
    });
  } catch (error) {
    throw new MapError(`Cannot list tests: ${(error as Error).message}`, { cause: error });
  }

  if (opts.json) {
    io.out(`${JSON.stringify({ tests: result.tests, command: result.command, warnings }, null, 2)}\n`);
    return;
  }
  const lines = [`Tests (${result.tests.length}): ${result.tests.join(', ') || '-'}`];
  if (result.command) lines.push(`Deploy flags: ${result.command}`);
  if (warnings.length) lines.push(`Warnings (${warnings.length}):`, ...warnings.map((w) => `  ${w}`));
  io.out(`${lines.join('\n')}\n`);
}
