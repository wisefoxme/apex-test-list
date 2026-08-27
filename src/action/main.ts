'use strict';

import * as core from '@actions/core';
import { listTests } from '../core/listTests.js';

function multilineInput(name: string): string[] {
  return core
    .getMultilineInput(name)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function run(): Promise<void> {
  try {
    const format = core.getInput('format') || 'sf';
    const manifestInput = core.getInput('manifest');
    const ignoreMissingTests = core.getBooleanInput('ignore-missing-tests');
    const ignoreDirs = multilineInput('ignore-package-directory');
    const noWarnings = core.getBooleanInput('no-warnings');
    const filterByMetadata = core.getBooleanInput('filter-by-metadata');
    const failOnEmpty = core.getBooleanInput('fail-on-empty');
    const warnings: string[] = [];

    const result = await listTests({
      format,
      manifest: manifestInput === '' ? undefined : manifestInput,
      ignoreMissingTests,
      ignoreDirs,
      noWarnings,
      filterByMetadata,
      warn: (msg) => warnings.push(msg),
    });

    core.setOutput('tests', result.tests.join('\n'));
    core.setOutput('test-count', result.tests.length);
    core.setOutput('command', result.command);
    core.setOutput('warnings', warnings.join('\n'));

    warnings.forEach((warning) => core.warning(warning));

    if (result.tests.length > 0) {
      core.info(result.command);
    }

    if (failOnEmpty && result.tests.length === 0) {
      core.setFailed('No test methods found.');
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}
