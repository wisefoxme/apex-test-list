import { describe, it, expect } from 'vitest';

import { matchWildcard } from '../../src/utils/matchWildcard.js';
import { searchDirectoryForTestClasses } from '../../src/readers/directorySearcher.js';
import { searchDirectoryForTestNamesInTestSuites } from '../../src/readers/testSuiteSearcher.js';

describe('tests of the searchDirectoryForTestNamesInTestSuites fn', () => {
  it('should read the sample suite from the file', async () => {
    const suitePath = './samples/testSuites';
    const result = await searchDirectoryForTestNamesInTestSuites(suitePath, ['./samples/classes']);

    expect(result).to.deep.equal(['UnlistedTest', 'NS.UnlistedTest', 'Sample2Test', 'SampleTriggerTest', 'SampleTest'].sort());
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
