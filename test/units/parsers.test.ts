import { readFileSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';

import { extractTypeNamesFromManifestFile } from '../../src/parsers/manifestParser.js';
import { parseTestSuiteFile, parseTestSuitesNames } from '../../src/parsers/testSuiteParser.js';
import { parseTestsNames } from '../../src/parsers/testNameParser.js';
import { loadTestMetadataDependencies, selectRelevantTests } from '../../src/parsers/metadataFilterParser.js';

describe('tests of the extractTypeNamesFromManifestFile fn', () => {
  it('should read an empty manifest', async () => {
    const manifestPath = './samples/samplePackageNoTypes.xml';
    const result = await extractTypeNamesFromManifestFile(manifestPath);

    expect(result).to.deep.equal([]);
  });
  it('should read a non-existent manifest', async () => {
    const manifestPath = './samples/invalid.xml';
    const result = await extractTypeNamesFromManifestFile(manifestPath);

    expect(result).to.deep.equal([]);
  });
});

describe('tests of the parseTestSuiteFile fn', () => {
  it('should read the sample suite', async () => {
    const suitePath = './samples/testSuites/SampleSuite.testSuite-meta.xml';
    const result = parseTestSuiteFile(readFileSync(suitePath, 'utf-8'));

    expect(result).to.deep.equal(['Sample*Test', 'UnlistedTest']);
  });

  it('should throw on invalid XML', () => {
    expect(() => parseTestSuiteFile('<<< not valid xml >>>')).toThrow();
  });
});

describe('tests of the parseTestsNames fn', () => {
  it('should parse tests names', () => {
    const result: string[] = parseTestsNames(['@Tests:SampleTest,AnotherTest', '@Tests:UnlistedTest']);

    expect(result).to.deep.equal(['SampleTest', 'AnotherTest', 'UnlistedTest']);
  });

  it('should return empty array for null', () => {
    expect(parseTestsNames(null)).to.deep.equal([]);
  });

  it('should return empty array for empty array', () => {
    expect(parseTestsNames([])).to.deep.equal([]);
  });
});

describe('tests of the parseTestSuitesNames fn', () => {
  it('should parse test suites names', () => {
    const result: string[] = parseTestSuitesNames([
      '@TESTSUITES:SampleSuite,AnotherSuite',
      '@testsuites:UnlistedSuite',
    ]);

    expect(result).to.deep.equal(['SampleSuite', 'AnotherSuite', 'UnlistedSuite']);
  });

  it('should return empty array for null', () => {
    expect(parseTestSuitesNames(null)).to.deep.equal([]);
  });

  it('should return empty array for empty array', () => {
    expect(parseTestSuitesNames([])).to.deep.equal([]);
  });
});

describe('tests of the selectRelevantTests fn', () => {
  it('excludes tests with no matching metadata', () => {
    const testMap = {
      MatchingTest: ['Flow:SomeFlow'],
      NonMatchingTest: ['CustomField:SomeObject.SomeField'],
    };
    const result = selectRelevantTests(testMap, ['Flow:SomeFlow']);
    expect(result).to.deep.equal(['MatchingTest']);
  });
});

describe('tests of the loadTestMetadataDependencies fn', () => {
  it('should throw on invalid YAML structure', async () => {
    const tempFile = join(tmpdir(), `invalid-metadata-${Date.now()}.yml`);
    await writeFile(tempFile, 'just a string value');
    try {
      await expect(loadTestMetadataDependencies(tempFile)).rejects.toThrow('Invalid test metadata dependencies format');
    } finally {
      await unlink(tempFile);
    }
  });
});
