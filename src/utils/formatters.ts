'use strict';
import { ApextestsListResult } from '../utils/types.js';

const TESTS_FLAG = '--tests ';

export async function formatList(
  format: string,
  tests: string[],
  manifestHasApex = false,
): Promise<ApextestsListResult> {
  switch (format) {
    case 'sf':
      return Promise.resolve({
        tests,
        command: TESTS_FLAG + tests.join(` ${TESTS_FLAG}`),
        manifestHasApex,
      });
    case 'sfdx':
      return Promise.resolve({
        tests,
        command: TESTS_FLAG + tests.join(' '),
        manifestHasApex,
      });
    case 'csv':
      return Promise.resolve({
        tests,
        command: tests.join(','),
        manifestHasApex,
      });
    default:
      throw new Error('Invalid format.');
  }
}
