import * as core from '@actions/core';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { run } from '../../src/action/main.js';
import { listTests } from '../../src/core/listTests.js';

vi.mock('@actions/core');
vi.mock('../../src/core/listTests.js');

const listTestsMock = listTests as unknown as Mock;
const getInputMock = core.getInput as unknown as Mock;
const getMultilineInputMock = core.getMultilineInput as unknown as Mock;
const getBooleanInputMock = core.getBooleanInput as unknown as Mock;

function stubInputs(
  inputs: Record<string, string>,
  multilineInputs: Record<string, string[]> = {},
  booleanInputs: Record<string, boolean> = {},
): void {
  getInputMock.mockImplementation((name: string) => inputs[name] ?? '');
  getMultilineInputMock.mockImplementation((name: string) => multilineInputs[name] ?? []);
  getBooleanInputMock.mockImplementation((name: string) => booleanInputs[name] ?? false);
}

const baseResult = {
  tests: ['SampleTest', 'SuperSampleTest'],
  command: '--tests SampleTest --tests SuperSampleTest',
};

describe('GitHub Action entrypoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps inputs to listTests, trimming/filtering multiline values and defaulting empty manifest to undefined', async () => {
    stubInputs(
      { format: 'csv', manifest: '' },
      { 'ignore-package-directory': ['  ignore1  ', '', 'ignore2'] },
      { 'ignore-missing-tests': false, 'no-warnings': false, 'filter-by-metadata': false },
    );
    listTestsMock.mockResolvedValue(baseResult);

    await run();

    expect(listTestsMock).toHaveBeenCalledWith({
      format: 'csv',
      manifest: undefined,
      ignoreMissingTests: false,
      ignoreDirs: ['ignore1', 'ignore2'],
      noWarnings: false,
      filterByMetadata: false,
      warn: expect.any(Function),
    });
  });

  it('passes through a non-empty manifest input', async () => {
    stubInputs({ manifest: 'package.xml' });
    listTestsMock.mockResolvedValue(baseResult);

    await run();

    expect(listTestsMock).toHaveBeenCalledWith(expect.objectContaining({ manifest: 'package.xml' }));
  });

  it('defaults format to sf when the input is empty', async () => {
    stubInputs({ format: '' });
    listTestsMock.mockResolvedValue(baseResult);

    await run();

    expect(listTestsMock).toHaveBeenCalledWith(expect.objectContaining({ format: 'sf' }));
  });

  it('sets outputs and logs the command on success', async () => {
    stubInputs({});
    listTestsMock.mockResolvedValue(baseResult);

    await run();

    expect(core.setOutput).toHaveBeenCalledWith('tests', 'SampleTest\nSuperSampleTest');
    expect(core.setOutput).toHaveBeenCalledWith('test-count', 2);
    expect(core.setOutput).toHaveBeenCalledWith('command', '--tests SampleTest --tests SuperSampleTest');
    expect(core.setOutput).toHaveBeenCalledWith('warnings', '');
    expect(core.info).toHaveBeenCalledWith('--tests SampleTest --tests SuperSampleTest');
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('propagates warnings from the warn callback to core.warning and the warnings output', async () => {
    stubInputs({});
    listTestsMock.mockImplementation(async ({ warn }: { warn: (msg: string) => void }) => {
      warn('first warning');
      warn('second warning');
      return baseResult;
    });

    await run();

    expect(core.warning).toHaveBeenCalledWith('first warning');
    expect(core.warning).toHaveBeenCalledWith('second warning');
    expect(core.setOutput).toHaveBeenCalledWith('warnings', 'first warning\nsecond warning');
  });

  it('does not log a command when no tests are found', async () => {
    stubInputs({});
    listTestsMock.mockResolvedValue({ tests: [], command: '' });

    await run();

    expect(core.setOutput).toHaveBeenCalledWith('tests', '');
    expect(core.setOutput).toHaveBeenCalledWith('test-count', 0);
    expect(core.info).not.toHaveBeenCalled();
  });

  it('fails the action when fail-on-empty is true and no tests are found', async () => {
    stubInputs({}, {}, { 'fail-on-empty': true });
    listTestsMock.mockResolvedValue({ tests: [], command: '' });

    await run();

    expect(core.setFailed).toHaveBeenCalledWith('No test methods found.');
  });

  it('does not fail when fail-on-empty is false even if no tests are found', async () => {
    stubInputs({}, {}, { 'fail-on-empty': false });
    listTestsMock.mockResolvedValue({ tests: [], command: '' });

    await run();

    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('does not fail when fail-on-empty is true but tests are found', async () => {
    stubInputs({}, {}, { 'fail-on-empty': true });
    listTestsMock.mockResolvedValue(baseResult);

    await run();

    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('fails the action with the error message when listTests throws', async () => {
    stubInputs({});
    listTestsMock.mockRejectedValue(new Error('boom'));

    await run();

    expect(core.setFailed).toHaveBeenCalledWith('boom');
  });

  it('fails the action with String(error) when the thrown value is not an Error instance', async () => {
    stubInputs({});
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    listTestsMock.mockRejectedValue('a plain string rejection');

    await run();

    expect(core.setFailed).toHaveBeenCalledWith('a plain string rejection');
  });
});
