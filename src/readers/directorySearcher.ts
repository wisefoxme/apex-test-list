'use strict';

import { readdirSync, readFileSync } from 'node:fs';
import { queue } from 'async';
import { parseTestSuitesNames } from '../parsers/testSuiteParser.js';
import { parseTestsNames } from '../parsers/testNameParser.js';
import { SearchResult } from '../utils/types.js';
import { TEST_CLASS_ANNOTATION_REGEX, TEST_NAME_REGEX, TEST_SUITE_NAME_REGEX } from '../utils/constants.js';
import { getConcurrencyThreshold } from '../utils/concurrencyThreshold.js';

/**
 * Given a certain directory, search its contents for files that end with '.cls' or '.trigger'.
 * Extracts the test names from the annotations on those files, and returns a list with those.
 *
 * @param directory directory within the project to search for files
 * @param names names of test files
 * @returns list of test classes
 */
export async function searchDirectoryForTestClasses(directory: string, names: string[] | null): Promise<SearchResult> {
  const testClassesNames: Set<string> = new Set<string>();
  const testSuitesNames: Set<string> = new Set<string>();
  const warnings: string[] = [];

  let readDir;
  try {
    readDir = readdirSync(directory, { recursive: true }) as string[];
  } catch (error) {
    throw new Error(`Invalid or inaccessible directory: ${directory}`);
  }

  // Gets the list of Apex files (classes and triggers)
  const apexFiles = readDir.filter((file) => {
    if (!file.endsWith('.cls') && !file.endsWith('.trigger')) {
      return false;
    }

    if (!names) {
      return true;
    }

    const parts = (file.split('/').pop() as string).split('.');
    const formattedName = `${parts[1] === 'cls' ? 'ApexClass' : 'ApexTrigger'}:${parts[0]}`;
    return names.includes(formattedName);
  });

  const testClassNameHandler = (fileName: string): void => {
    const path = `${directory}/${fileName}`;
    const data = readFileSync(path, 'utf-8');

    const testNameMatches = Array.from(data.matchAll(TEST_NAME_REGEX));
    const testSuiteMatches = Array.from(data.matchAll(TEST_SUITE_NAME_REGEX));
    const testClassAnnotationMatches = data.match(TEST_CLASS_ANNOTATION_REGEX);

    let hasAnnotation = false;

    if (testNameMatches.length > 0) {
      hasAnnotation = true;
      for (const match of testNameMatches) {
        parseTestsNames(match).forEach((testMethod) => testClassesNames.add(testMethod));
      }
    }

    if (testSuiteMatches.length > 0) {
      hasAnnotation = true;
      for (const match of testSuiteMatches) {
        parseTestSuitesNames(match).forEach((testMethod) => testSuitesNames.add(testMethod));
      }
    }

    if (testClassAnnotationMatches && testClassAnnotationMatches.length > 0) {
      hasAnnotation = true;
      testClassesNames.add(fileName.split('.').shift() as string);
    }

    if (!hasAnnotation) {
      warnings.push(`File "${fileName}" does not contain @tests, @testsuites, or @istest annotations`);
    }
  };

  const testClassNameProcessor = queue((f: string, cb: (error?: Error | undefined) => void) => {
    testClassNameHandler(f);
    cb();
  }, getConcurrencyThreshold());

  await testClassNameProcessor.push(apexFiles);

  return {
    classes: Array.from(testClassesNames),
    testSuites: Array.from(testSuitesNames),
    warnings,
  };
}
