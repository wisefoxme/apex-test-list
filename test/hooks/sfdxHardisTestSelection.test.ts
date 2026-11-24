import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hook } from '@oclif/core';
import type { SfdxHardisEventHookOptions, SfdxHardisTestSelectionEvent } from 'sfdx-hardis/plugin-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { listTests } = vi.hoisted(() => ({ listTests: vi.fn() }));
vi.mock('../../src/core/listTests.js', () => ({ listTests }));

import hook, { DISABLE_ENV_VAR, PLUGIN_NAME } from '../../src/hooks/sfdxHardisTestSelection.js';

describe('sfdx-hardis:test-selection hook', () => {
  let dir: string;
  let selectionFile: string;
  let context: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

  const run = (data: Partial<SfdxHardisTestSelectionEvent['data']> = {}): Promise<void> =>
    hook.call(
      context as unknown as Hook.Context,
      {
        event: 'sfdx-hardis:test-selection',
        data: {
          checkOnly: true,
          packageXmlFile: '/project/manifest/package.xml',
          delta: true,
          testLevel: 'RunLocalTests',
          testClasses: [],
          selectionFile,
          ...data,
        },
      } as unknown as SfdxHardisEventHookOptions<SfdxHardisTestSelectionEvent>,
    );

  const readSelection = async (): Promise<unknown> => JSON.parse(await readFile(selectionFile, 'utf8'));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'apextestlist-hook-'));
    selectionFile = join(dir, 'plugin-test-selection.json');
    context = { log: vi.fn(), warn: vi.fn() };
    listTests.mockReset();
    delete process.env[DISABLE_ENV_VAR];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    delete process.env[DISABLE_ENV_VAR];
  });

  it('writes RunSpecifiedTests with the tests of the package.xml', async () => {
    listTests.mockResolvedValue({ tests: ['SampleTest', 'Sample2Test'], command: '', manifestHasApex: true });

    await run();

    expect(listTests).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'csv', manifest: '/project/manifest/package.xml', ignoreMissingTests: true }),
    );
    expect(await readSelection()).toEqual({
      plugin: PLUGIN_NAME,
      testLevel: 'RunSpecifiedTests',
      testClasses: ['SampleTest', 'Sample2Test'],
    });
    expect(context.log).toHaveBeenCalledWith(`[${PLUGIN_NAME}] RunSpecifiedTests: SampleTest, Sample2Test`);
  });

  it('keeps the test classes sfdx-hardis already selected, without duplicates', async () => {
    listTests.mockResolvedValue({ tests: ['SampleTest', 'OtherTest'], command: '', manifestHasApex: true });

    await run({ testLevel: 'RunSpecifiedTests', testClasses: ['HardisTest', 'SampleTest'] });

    expect(await readSelection()).toEqual({
      plugin: PLUGIN_NAME,
      testLevel: 'RunSpecifiedTests',
      testClasses: ['HardisTest', 'SampleTest', 'OtherTest'],
    });
  });

  it('drops names sfdx-hardis refuses and warns about them', async () => {
    listTests.mockResolvedValue({ tests: ['NS.UnlistedTest', 'SampleTest'], command: '', manifestHasApex: true });

    await run();

    expect(await readSelection()).toMatchObject({ testClasses: ['SampleTest'] });
    expect(context.warn).toHaveBeenCalledWith(
      `[${PLUGIN_NAME}] Skipping test names sfdx-hardis does not accept: NS.UnlistedTest`,
    );
  });

  it('writes nothing when no test is found', async () => {
    listTests.mockResolvedValue({ tests: [], command: '', manifestHasApex: true });

    await run();

    await expect(readFile(selectionFile)).rejects.toThrow();
  });

  it('writes nothing when every test name is refused', async () => {
    listTests.mockResolvedValue({ tests: ['NS.Test'], command: '', manifestHasApex: true });

    await run();

    await expect(readFile(selectionFile)).rejects.toThrow();
  });

  it.each(['NoTestRun', 'RunAllTestsInOrg'])('does not override %s', async (testLevel) => {
    await run({ testLevel });

    expect(listTests).not.toHaveBeenCalled();
    await expect(readFile(selectionFile)).rejects.toThrow();
  });

  it(`does nothing when ${DISABLE_ENV_VAR} is true`, async () => {
    process.env[DISABLE_ENV_VAR] = 'true';

    await run();

    expect(listTests).not.toHaveBeenCalled();
  });

  it('forwards listTests warnings with the plugin prefix', async () => {
    listTests.mockImplementation(async ({ warn }: { warn: (message: string) => void }) => {
      warn('No test methods found');
      return { tests: [], command: '', manifestHasApex: false };
    });

    await run();

    expect(context.warn).toHaveBeenCalledWith(`[${PLUGIN_NAME}] No test methods found`);
  });

  it('keeps the sfdx-hardis selection and warns when listing fails', async () => {
    listTests.mockRejectedValue(new Error('boom'));

    await run();

    await expect(readFile(selectionFile)).rejects.toThrow();
    expect(context.warn).toHaveBeenCalledWith(
      `[${PLUGIN_NAME}] Test selection failed, keeping the sfdx-hardis selection: boom`,
    );
  });
});
