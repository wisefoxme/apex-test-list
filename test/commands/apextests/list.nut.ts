import { rm, writeFile, mkdir, rmdir } from 'node:fs/promises';
import * as path from 'node:path';
import { execCmd, TestSession } from '@salesforce/cli-plugins-testkit';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { SFDX_PROJECT_FILE_NAME } from '../../../src/utils/constants.js';

// only tests which exist in the samples directory
const VALIDATED_TEST_LIST = [
  'Sample2Test',
  'SampleTest',
  'SampleTriggerTest',
  'SuperSample2Test',
  'SuperSampleTest',
  'UnlistedTest',
  'UnlistedTest2',
].sort((a, b) => a.localeCompare(b));

// all tests provided in the sample annotations
const TEST_LIST = [
  'FridayTest',
  'NotYourLuckyDayTest',
  'NS.UnlistedTest',
  'Sample2Test',
  'SampleTest',
  'SampleTriggerTest',
  'SuperSample2Test',
  'SuperSampleTest',
  'UnlistedTest',
  'UnlistedTest2',
].sort((a, b) => a.localeCompare(b));

describe('apextests list NUTs', () => {
  let session: TestSession;

  const configFile = {
    packageDirectories: [{ path: 'samples', default: true }],
    namespace: '',
    sfdcLoginUrl: 'https://login.salesforce.com',
    sourceApiVersion: '64.0',
  };
  const configJsonString = JSON.stringify(configFile, null, 2);
  const ignoreDir = 'ignore';

  beforeAll(async () => {
    await writeFile(SFDX_PROJECT_FILE_NAME, configJsonString);
    await mkdir(ignoreDir);
  });

  beforeEach(async () => {
    session = await TestSession.create({ devhubAuthStrategy: 'NONE' });
  });

  afterAll(async () => {
    await session?.clean();
    await rm(SFDX_PROJECT_FILE_NAME);
    await rmdir(ignoreDir);
  });

  it('should display the help information', () => {
    const command = 'apextests list --help';
    const output = execCmd(command, { ensureExitCode: 0 }).shellOutput.stdout;
    expect(output.replace('\n', '')).to.include('List');
  });

  it('runs list', async () => {
    const command = `apextests list -d ${ignoreDir}`;
    const output = execCmd(command, { ensureExitCode: 0 }).shellOutput.stdout;

    expect(output.replace('\n', '')).to.equal(`--tests ${TEST_LIST.join(' --tests ')}`);
  });

  it('runs list with --json', async () => {
    const command = `apextests list --json -d ${ignoreDir}`;
    const output = execCmd(command, { ensureExitCode: 0 }).shellOutput.stdout;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(JSON.parse(output).result.command).to.equal(`--tests ${TEST_LIST.join(' --tests ')}`);
  });

  it('runs list --format csv', async () => {
    const command = `apextests list ${['--format', 'csv'].join(' ')} --json -d ${ignoreDir}`;
    const output = execCmd(command, { ensureExitCode: 0 }).shellOutput.stdout;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(JSON.parse(output).result.command).to.equal(TEST_LIST.join(','));
  });

  it('runs list and validates tests exist', async () => {
    const command = `apextests list --ignore-missing-tests -d ${ignoreDir}`;
    const output = execCmd(command, { ensureExitCode: 0 }).shellOutput.stdout;

    expect(output.replace('\n', '')).to.equal(`--tests ${VALIDATED_TEST_LIST.join(' --tests ')}`);
  });

  it('runs list with --json and validates tests exist', async () => {
    const command = `apextests list --json --ignore-missing-tests -d ${ignoreDir}`;
    const output = execCmd(command, { ensureExitCode: 0 }).shellOutput.stdout;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(JSON.parse(output).result.command).to.equal(`--tests ${VALIDATED_TEST_LIST.join(' --tests ')}`);
  });

  it('runs list --format csv and validates tests exist', async () => {
    const command = `apextests list ${['--format', 'csv', '--ignore-missing-tests'].join(' ')} --json -d ${ignoreDir}`;
    const output = execCmd(command, { ensureExitCode: 0 }).shellOutput.stdout;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(JSON.parse(output).result.command).to.equal(VALIDATED_TEST_LIST.join(','));
  });

  it('runs list --format csv --manifest samples/samplePackage.xml', async () => {
    const command = `apextests list --format csv --manifest ${path.join('samples', 'samplePackage.xml')} -d ${ignoreDir}`;
    const output = execCmd(command, { ensureExitCode: 0 }).shellOutput.stdout;

    expect(output.replace('\n', '')).to.equal(
      ['NS.UnlistedTest', 'Sample2Test', 'SampleTest', 'SampleTriggerTest', 'SuperSampleTest', 'UnlistedTest']
        .sort((a, b) => a.localeCompare(b))
        .join(','),
    );
  });

  it('runs list --format csv --manifest samples/samplePackageWithTrigger.xml', async () => {
    const command = `apextests list --format csv --manifest ${path.join('samples', 'samplePackageWithTrigger.xml')} -d ${ignoreDir}`;
    const output = execCmd(command, { ensureExitCode: 0 }).shellOutput.stdout;

    expect(output.replace('\n', '')).to.equal(
      ['NS.UnlistedTest', 'Sample2Test', 'SampleTest', 'SampleTriggerTest', 'SuperSampleTest', 'UnlistedTest']
        .sort((a, b) => a.localeCompare(b))
        .join(','),
    );
  });
});
