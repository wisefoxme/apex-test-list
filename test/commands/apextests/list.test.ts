import { rm, writeFile, mkdir, rmdir } from 'node:fs/promises';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { listTests } from '../../../src/core/listTests.js';
import { SFDX_PROJECT_FILE_NAME } from '../../../src/utils/constants.js';

const VALIDATED_TEST_LIST = [
  'Sample2Test',
  'SampleTest',
  'SampleTriggerTest',
  'SuperSample2Test',
  'SuperSampleTest',
  'UnlistedTest',
  'UnlistedTest2',
].sort((a, b) => a.localeCompare(b));

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

describe('apextests list', () => {
  const configFile = {
    packageDirectories: [{ path: 'samples', default: true }, { path: 'ignore' }],
    namespace: '',
    sfdcLoginUrl: 'https://login.salesforce.com',
    sourceApiVersion: '62.0',
  };
  const ignoreDir = 'ignore';

  beforeAll(async () => {
    await writeFile(SFDX_PROJECT_FILE_NAME, JSON.stringify(configFile, null, 2));
    await mkdir(ignoreDir);
  });

  afterAll(async () => {
    await rm(SFDX_PROJECT_FILE_NAME);
    await rmdir(ignoreDir);
  });

  it('runs list', async () => {
    const result = await listTests({});
    expect(result.command).to.equal(`--tests ${TEST_LIST.join(' --tests ')}`);
  });

  it('runs list with --json', async () => {
    const result = await listTests({ ignoreDirs: [ignoreDir] });
    expect(result.command).to.equal(`--tests ${TEST_LIST.sort((a, b) => a.localeCompare(b)).join(' --tests ')}`);
  });

  it('runs list --format csv', async () => {
    const result = await listTests({ format: 'csv', ignoreDirs: [ignoreDir] });
    expect(result.command).to.equal(TEST_LIST.sort((a, b) => a.localeCompare(b)).join(','));
  });

  it('runs list --format sfdx', async () => {
    const result = await listTests({ format: 'csv', ignoreDirs: [ignoreDir] });
    expect(result.command).to.equal(TEST_LIST.sort((a, b) => a.localeCompare(b)).join(','));
  });

  it('runs list and validates tests exist', async () => {
    const warnings: string[] = [];
    const result = await listTests({
      ignoreMissingTests: true,
      ignoreDirs: [ignoreDir],
      warn: (msg) => warnings.push(msg),
    });
    expect(result.command).to.equal(`--tests ${VALIDATED_TEST_LIST.join(' --tests ')}`);
    expect(warnings.join('\n')).to.include(
      'The test method NotYourLuckyDayTest.cls was not found in any package directory',
    );
  });

  it('runs list with --json and validates tests exist', async () => {
    const result = await listTests({ ignoreMissingTests: true, ignoreDirs: [ignoreDir] });
    expect(result.command).to.equal(
      `--tests ${VALIDATED_TEST_LIST.sort((a, b) => a.localeCompare(b)).join(' --tests ')}`,
    );
  });

  it('runs list --format csv and validates tests exist', async () => {
    const warnings: string[] = [];
    const result = await listTests({
      format: 'csv',
      ignoreMissingTests: true,
      ignoreDirs: [ignoreDir],
      warn: (msg) => warnings.push(msg),
    });
    expect(result.command).to.equal(VALIDATED_TEST_LIST.sort((a, b) => a.localeCompare(b)).join(','));
    expect(warnings.join('\n')).to.include(
      'The test method NotYourLuckyDayTest.cls was not found in any package directory',
    );
  });

  it('runs list --format csv --manifest samples/samplePackage.xml', async () => {
    const warnings: string[] = [];
    const result = await listTests({
      format: 'csv',
      manifest: 'samples/samplePackage.xml',
      ignoreDirs: [ignoreDir],
      warn: (msg) => warnings.push(msg),
    });
    expect(result.command).to.equal(
      ['NS.UnlistedTest', 'Sample2Test', 'SampleTest', 'SampleTriggerTest', 'SuperSampleTest', 'UnlistedTest']
        .sort((a, b) => a.localeCompare(b))
        .join(),
    );
    expect(warnings.join('\n')).to.include('');
  });

  it('runs list --format csv --manifest samples/samplePackageWithTrigger.xml', async () => {
    const warnings: string[] = [];
    const result = await listTests({
      format: 'csv',
      manifest: 'samples/samplePackageWithTrigger.xml',
      ignoreDirs: [ignoreDir],
      warn: (msg) => warnings.push(msg),
    });
    expect(result.command).to.equal(
      ['NS.UnlistedTest', 'Sample2Test', 'SampleTest', 'SampleTriggerTest', 'SuperSampleTest', 'UnlistedTest']
        .sort((a, b) => a.localeCompare(b))
        .join(),
    );
    expect(warnings.join('\n')).to.include('');
  });

  it('runs list --manifest samples/noAnnotationPackage.xml', async () => {
    const warnings: string[] = [];
    const result = await listTests({
      manifest: 'samples/noAnnotationPackage.xml',
      warn: (msg) => warnings.push(msg),
    });
    expect(result.command).to.equal('');
    expect(warnings.join('\n')).to.include(
      'File "NoAnnotations.cls" does not contain @tests, @testsuites, or @istest annotations',
    );
  });

  it('runs list --manifest samples/noAnnotationPackage.xml --no-warnings', async () => {
    const warnings: string[] = [];
    const result = await listTests({
      manifest: 'samples/noAnnotationPackage.xml',
      noWarnings: true,
      warn: (msg) => warnings.push(msg),
    });
    expect(result.command).to.equal('');
    expect(warnings.join('\n')).to.include('No test methods found');
  });

  it('runs list with the metadata filter and manifest selected', async () => {
    const warnings: string[] = [];
    const result = await listTests({
      manifest: 'samples/metadataFilterPackage.xml',
      filterByMetadata: true,
      ignoreDirs: [ignoreDir],
      warn: (msg) => warnings.push(msg),
    });
    expect(result.command).to.equal('--tests SampleTest --tests SuperSampleTest');
    expect(warnings.join('\n')).to.include('');
  });
});
