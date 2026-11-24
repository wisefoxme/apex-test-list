import { writeFile } from 'node:fs/promises';
import type { Hook } from '@oclif/core';
import type {
  PluginTestSelection,
  SfdxHardisEventHookOptions,
  SfdxHardisTestSelectionEvent,
} from 'sfdx-hardis/plugin-api';
import { listTests } from '../core/listTests.js';

export const PLUGIN_NAME = 'apextestlist';
export const DISABLE_ENV_VAR = 'APEX_TEST_LIST_DISABLE_HARDIS_HOOK';

// Same rule sfdx-hardis applies to the selection file: Apex class names only, no namespace or method
const APEX_CLASS_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Test levels this hook never overrides: skipping tests and running the whole org stay sfdx-hardis decisions
const KEPT_TEST_LEVELS = new Set(['NoTestRun', 'RunAllTestsInOrg']);

/**
 * Listens to the sfdx-hardis:test-selection event sent by hardis:project:deploy:smart.
 * Lists the Apex tests linked to the package.xml about to be deployed (from the @Tests / @TestSuites
 * annotations) and asks sfdx-hardis to run them with RunSpecifiedTests.
 * Writes nothing, so sfdx-hardis keeps its own selection, when no test is found.
 */
const hook = async function (
  this: Hook.Context,
  options: SfdxHardisEventHookOptions<SfdxHardisTestSelectionEvent>,
): Promise<void> {
  const { data } = options;
  if (process.env[DISABLE_ENV_VAR] === 'true' || KEPT_TEST_LEVELS.has(data.testLevel)) {
    return;
  }

  const warn = (message: string): void => this.warn(`[${PLUGIN_NAME}] ${message}`);

  try {
    const result = await listTests({
      format: 'csv',
      manifest: data.packageXmlFile,
      ignoreMissingTests: true,
      warn,
    });

    const invalidNames = result.tests.filter((name) => !APEX_CLASS_NAME.test(name));
    if (invalidNames.length > 0) {
      warn(`Skipping test names sfdx-hardis does not accept: ${invalidNames.join(', ')}`);
    }
    const tests = result.tests.filter((name) => APEX_CLASS_NAME.test(name));
    if (tests.length === 0) {
      return;
    }

    // Keep the test classes sfdx-hardis already selected (for example deploymentApexTestClasses)
    const selection: PluginTestSelection = {
      plugin: PLUGIN_NAME,
      testLevel: 'RunSpecifiedTests',
      testClasses: [...new Set([...data.testClasses, ...tests])],
    };
    await writeFile(data.selectionFile, JSON.stringify(selection));
    this.log(`[${PLUGIN_NAME}] RunSpecifiedTests: ${selection.testClasses?.join(', ')}`);
  } catch (error) {
    warn(`Test selection failed, keeping the sfdx-hardis selection: ${(error as Error).message}`);
  }
};

export default hook;
