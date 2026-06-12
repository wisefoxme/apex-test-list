import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

import { matchWildcard } from '../../src/utils/matchWildcard.js';
import { searchDirectoryForTestClasses } from '../../src/readers/directorySearcher.js';
import { searchDirectoryForTestNamesInTestSuites } from '../../src/readers/testSuiteSearcher.js';

describe('tests of the searchDirectoryForTestNamesInTestSuites fn', () => {
  it('should read the sample suite from the file', async () => {
    const suitePath = './samples/testSuites';
    const result = await searchDirectoryForTestNamesInTestSuites(suitePath, ['./samples/classes']);

    expect(result).to.deep.equal(
      ['UnlistedTest', 'NS.UnlistedTest', 'Sample2Test', 'SampleTriggerTest', 'SampleTest'].sort(),
    );
  });
});

describe('tests of the searchDirectoryForTestClasses fn', () => {
  it('should read the Sample.cls class in the classes directory and return its tests and test suites', async () => {
    const classesPath = './samples/classes';
    const result = await searchDirectoryForTestClasses(classesPath, ['ApexClass:Sample']);

    expect(result).to.deep.equal({
      classes: ['SampleTest', 'SuperSampleTest'],
      testSuites: ['SampleSuite'],
      warnings: [],
    });
  });
});

describe('tests of the searchDirectoryForTestClasses fn with no annotations', () => {
  it('should read the NoAnnotations.cls class in the classes directory and return no tests with a warning', async () => {
    const classesPath = './samples/classes';
    const result = await searchDirectoryForTestClasses(classesPath, ['ApexClass:NoAnnotations']);

    expect(result).to.deep.equal({
      classes: [],
      testSuites: [],
      warnings: ['File "NoAnnotations.cls" does not contain @tests, @testsuites, or @istest annotations'],
    });
  });
});

describe('searchDirectoryForTestClasses error handling', () => {
  it('should throw on invalid directory', async () => {
    await expect(searchDirectoryForTestClasses('/nonexistent/invalid/path', null)).rejects.toThrow(
      'Invalid or inaccessible directory',
    );
  });
});

describe('searchDirectoryForTestNamesInTestSuites error handling', () => {
  it('should throw on invalid directory', async () => {
    await expect(searchDirectoryForTestNamesInTestSuites('/nonexistent/invalid/path', [])).rejects.toThrow(
      'Invalid or inaccessible directory',
    );
  });
});

describe('searchDirectoryForTestNamesInTestSuites with no wildcards', () => {
  it('should skip wildcard search when suites contain no wildcards', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'suite-no-wildcard-'));
    await writeFile(
      join(tempDir, 'Plain.testSuite-meta.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>
<ApexTestSuite xmlns="http://soap.sforce.com/2006/04/metadata">
  <testClassName>PlainTest</testClassName>
</ApexTestSuite>`,
    );
    try {
      const result = await searchDirectoryForTestNamesInTestSuites(tempDir, []);
      expect(result).to.deep.equal(['PlainTest']);
    } finally {
      await rm(tempDir, { recursive: true });
    }
  });
});

describe('test suite wildcards', () => {
  it('should match the wildcard with the test class name', () => {
    expect(matchWildcard('*Test', 'SampleTest')).to.be.true;
    expect(matchWildcard('Other*Test', 'SampleSomethingTest')).to.be.false;
    expect(matchWildcard('Sample*', 'SampleTest')).to.be.true;
    expect(matchWildcard('Sample*Test', 'SampleSomethingTest')).to.be.true;
    expect(matchWildcard('Sample*Test', 'SampleTest')).to.be.true;
    expect(matchWildcard('Sample*Test', 'SuperSampleTest')).to.be.false;
  });

  it('should read the SampleSuite test suite file and list the test classes with wildcards', async () => {
    const suitePath = './samples/testSuites';
    const result = await searchDirectoryForTestNamesInTestSuites(suitePath, ['./samples/classes']);
    const tests = ['NS.UnlistedTest', 'UnlistedTest', 'Sample2Test', 'SampleTriggerTest', 'SampleTest'].sort();

    expect(result).to.deep.equal(tests);
  });
});

describe('searchDirectoryForTestClasses file type filtering', () => {
  it('should not process non-.cls and non-.trigger files', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'non-apex-'));
    await writeFile(join(tempDir, 'README.txt'), 'not a class');
    await writeFile(join(tempDir, 'Sample.cls'), '// @Tests: SomeTest');
    try {
      const result = await searchDirectoryForTestClasses(tempDir, null);
      expect(result.warnings).toEqual([]);
      expect(result.classes).toContain('SomeTest');
    } finally {
      await rm(tempDir, { recursive: true });
    }
  });

  it('should match trigger files using the ApexTrigger prefix', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'trigger-'));
    await writeFile(join(tempDir, 'MyTrigger.trigger'), '// @Tests: TriggerTest');
    try {
      const result = await searchDirectoryForTestClasses(tempDir, ['ApexTrigger:MyTrigger']);
      expect(result.classes).toContain('TriggerTest');
    } finally {
      await rm(tempDir, { recursive: true });
    }
  });

  it('should match cls files using the ApexClass prefix', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'apexclass-'));
    await writeFile(join(tempDir, 'MyClass.cls'), '// @Tests: MyTest');
    try {
      const result = await searchDirectoryForTestClasses(tempDir, ['ApexClass:MyClass']);
      expect(result.classes).toContain('MyTest');
    } finally {
      await rm(tempDir, { recursive: true });
    }
  });
});

describe('searchDirectoryForTestClasses annotation detection', () => {
  it('should not warn for files with only @tests annotation', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'tests-only-'));
    await writeFile(join(tempDir, 'MyClass.cls'), '// @Tests: MyTest');
    try {
      const result = await searchDirectoryForTestClasses(tempDir, null);
      expect(result.warnings).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true });
    }
  });

  it('should not warn for files with only @isTest annotation', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'istest-only-'));
    await writeFile(join(tempDir, 'MyTestClass.cls'), '@isTest\npublic class MyTestClass {}');
    try {
      const result = await searchDirectoryForTestClasses(tempDir, null);
      expect(result.warnings).toEqual([]);
      expect(result.classes).toContain('MyTestClass');
    } finally {
      await rm(tempDir, { recursive: true });
    }
  });
});

describe('searchDirectoryForTestNamesInTestSuites file type filtering', () => {
  it('should only process .testSuite-meta.xml files', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'suite-filter-'));
    await writeFile(
      join(tempDir, 'Valid.testSuite-meta.xml'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<ApexTestSuite xmlns="http://soap.sforce.com/2006/04/metadata">\n  <testClassName>ValidTest</testClassName>\n</ApexTestSuite>',
    );
    await writeFile(join(tempDir, 'SomeClass.cls'), 'public class SomeClass {}');
    try {
      const result = await searchDirectoryForTestNamesInTestSuites(tempDir, []);
      expect(result).toEqual(['ValidTest']);
    } finally {
      await rm(tempDir, { recursive: true });
    }
  });
});

describe('searchDirectoryForTestNamesInTestSuites wildcard guard', () => {
  it('should not search package directories when suite contains no wildcards', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'no-wildcard-'));
    await writeFile(
      join(tempDir, 'Plain.testSuite-meta.xml'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<ApexTestSuite xmlns="http://soap.sforce.com/2006/04/metadata">\n  <testClassName>PlainTest</testClassName>\n</ApexTestSuite>',
    );
    try {
      // Non-existent dir should never be accessed since requiresWildcardSearch stays false
      const result = await searchDirectoryForTestNamesInTestSuites(tempDir, ['/this/path/does/not/exist']);
      expect(result).toEqual(['PlainTest']);
    } finally {
      await rm(tempDir, { recursive: true });
    }
  });
});
