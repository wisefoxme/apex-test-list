'use strict';

import { readdirSync, readFileSync } from 'node:fs';
import { queue } from 'async';

import { parseTestSuiteFile } from '../parsers/testSuiteParser.js';
import { getConcurrencyThreshold } from '../utils/concurrencyThreshold.js';
import { matchWildcard } from '../utils/matchWildcard.js';
import { searchDirectoryForTestClasses } from './directorySearcher.js';

/**
 * Given a certain directory, search its contents for files that end with
 * '.testSuite-meta.xml' and extract the class names mentioned in the test
 * suites.
 *
 * @param directory directory within the project to search for files
 * @returns a Promise<string> with a list of test names
 */
export async function searchDirectoryForTestNamesInTestSuites(
  directory: string,
  packageDirectories: string[],
): Promise<string[]> {
  const testClassesNames: Set<string> = new Set<string>();
  let readDir;

  try {
    readDir = readdirSync(directory, { recursive: true }) as string[];
  } catch (error) {
    throw new Error(`Invalid or inaccessible directory: ${directory}`);
  }

  // Gets the list of test suites
  const suiteFiles = readDir.filter((file) => file.endsWith('.testSuite-meta.xml'));
  const wildcards: Set<string> = new Set<string>();
  let requiresWildcardSearch = false;

  // Function that handles the parsing of test suites and helps to build the
  // list of test classes for the next steps
  const testSuiteNameHandler = (fileName: string): void => {
    const path = `${directory}/${fileName}`;
    const data = readFileSync(path, 'utf-8');
    const classes = parseTestSuiteFile(data);

    // TODO: Support for wildcards
    for (const test of classes) {
      if (test.includes('*')) {
        requiresWildcardSearch = true;
        wildcards.add(test);
        continue;
      }
      testClassesNames.add(test);
    }
  };

  // define the processors
  const testSuiteNameProcessor = queue((f: string, cb: (error?: Error | undefined) => void) => {
    testSuiteNameHandler(f);
    cb();
  }, getConcurrencyThreshold());

  // initialize the processor with the names of files we want to process
  await testSuiteNameProcessor.push(suiteFiles);

  // make sure no dangling process is left before continuing
  /* v8 ignore next 3 */
  if (testSuiteNameProcessor.length() > 0) {
    await testSuiteNameProcessor.drain();
  }

  if (requiresWildcardSearch && packageDirectories) {
    for (const pkgDir of packageDirectories) {
      // eslint-disable-next-line no-await-in-loop
      const searchResult = await searchDirectoryForTestClasses(pkgDir, null);
      const testClassesInDir = searchResult.classes;

      for (const test of testClassesInDir) {
        // if the test class name matches the wildcard, add it to the list
        for (const wildcard of wildcards) {
          if (!matchWildcard(wildcard, test)) {
            continue;
          }

          testClassesNames.add(test);
        }
      }
    }
  }

  return Array.from(testClassesNames).sort();
}
