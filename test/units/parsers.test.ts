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
  it('should return results sorted alphabetically', async () => {
    const result = await extractTypeNamesFromManifestFile('./samples/samplePackage.xml');
    expect(result.length).toBeGreaterThan(1);
    expect(result).toEqual([...result].sort((a, b) => a.localeCompare(b)));
  });

  it('should sort alphabetically when ApexTrigger is declared before ApexClass in manifest', async () => {
    const result = await extractTypeNamesFromManifestFile('./samples/samplePackageTriggerFirst.xml');
    expect(result.length).toBeGreaterThan(1);
    expect(result).toEqual([...result].sort((a, b) => a.localeCompare(b)));
    expect(result.findIndex((r) => r.startsWith('ApexClass'))).toBeLessThan(
      result.findIndex((r) => r.startsWith('ApexTrigger')),
    );
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

  it('should throw the xml parse error, not a downstream TypeError', () => {
    try {
      parseTestSuiteFile('<<< not valid xml >>>');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).not.toBeInstanceOf(TypeError);
    }
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

  it('should handle spaces before the colon in @testsuites annotation', () => {
    expect(parseTestSuitesNames(['@testsuites   :SuiteA'])).toEqual(['SuiteA']);
  });

  it('should collapse consecutive commas between suite names', () => {
    expect(parseTestSuitesNames(['@testsuites:SuiteA,,SuiteB'])).toEqual(['SuiteA', 'SuiteB']);
  });

  it('should trim trailing separators', () => {
    expect(parseTestSuitesNames(['@testsuites:SuiteA,'])).toEqual(['SuiteA']);
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

  it('uses exact match for dependencies without wildcards', () => {
    // 'A.BXC' matches regex ^A\.B.C$ (second dot unescaped) but not exact string 'A.B.C'
    const testMap = { TestA: ['A.B.C'] };
    expect(selectRelevantTests(testMap, ['A.BXC'])).toEqual([]);
  });

  it('requires a literal dot in wildcard patterns', () => {
    const testMap = { TestA: ['CustomField.*'] };
    // No dot after CustomField — escaped-dot regex should not match
    expect(selectRelevantTests(testMap, ['CustomFieldNoDot'])).toEqual([]);
  });

  it('wildcard does not match unrelated metadata prefix', () => {
    const testMap = { TestA: ['Foo.*'] };
    expect(selectRelevantTests(testMap, ['Bar.Something'])).toEqual([]);
  });

  it('wildcard matches metadata with the correct prefix and a literal dot', () => {
    const testMap = { TestA: ['CustomField:Account.*'] };
    expect(selectRelevantTests(testMap, ['CustomField:Account.Name'])).toEqual(['TestA']);
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

  it('should throw on null YAML value', async () => {
    const tempFile = join(tmpdir(), `null-metadata-${Date.now()}.yml`);
    await writeFile(tempFile, 'null');
    try {
      await expect(loadTestMetadataDependencies(tempFile)).rejects.toThrow('Invalid test metadata dependencies format');
    } finally {
      await unlink(tempFile);
    }
  });

  it('should throw when top-level YAML value is a number', async () => {
    const tempFile = join(tmpdir(), `number-metadata-${Date.now()}.yml`);
    await writeFile(tempFile, '123');
    try {
      await expect(loadTestMetadataDependencies(tempFile)).rejects.toThrow('Invalid test metadata dependencies format');
    } finally {
      await unlink(tempFile);
    }
  });

  it('should throw when map values are not arrays', async () => {
    const tempFile = join(tmpdir(), `not-array-${Date.now()}.yml`);
    await writeFile(tempFile, 'TestClass: "not-an-array"');
    try {
      await expect(loadTestMetadataDependencies(tempFile)).rejects.toThrow('Invalid test metadata dependencies format');
    } finally {
      await unlink(tempFile);
    }
  });

  it('should throw when array elements are not strings', async () => {
    const tempFile = join(tmpdir(), `non-string-${Date.now()}.yml`);
    await writeFile(tempFile, 'TestClass:\n  - valid\n  - 123');
    try {
      await expect(loadTestMetadataDependencies(tempFile)).rejects.toThrow('Invalid test metadata dependencies format');
    } finally {
      await unlink(tempFile);
    }
  });

  it('should throw when at least one entry is invalid even if another is valid', async () => {
    const tempFile = join(tmpdir(), `mixed-${Date.now()}.yml`);
    await writeFile(tempFile, 'ValidClass:\n  - ValidTest\nInvalidClass: not-an-array');
    try {
      await expect(loadTestMetadataDependencies(tempFile)).rejects.toThrow('Invalid test metadata dependencies format');
    } finally {
      await unlink(tempFile);
    }
  });
});
