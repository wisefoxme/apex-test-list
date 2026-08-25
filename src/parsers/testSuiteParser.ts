'use strict';

import { findChildren, parseXml } from '../utils/xmlParser.js';

/**
 * Analyzes the content of a test suite xml file and returns the Apex classes
 * included in it.
 *
 * @param data string with the content of the test suite xml file
 * @returns a list of test classes names in the test suite
 */
export function parseTestSuiteFile(data: string): string[] {
  const root = parseXml(data);

  if (root.name !== 'ApexTestSuite') {
    throw new Error(`Invalid XML: expected root element "ApexTestSuite", got "${root.name}"`);
  }

  return findChildren(root, 'testClassName')
    .map((element) => element.text.trim())
    .sort();
}

/**
 * Parses the line in an Apex file that contains the test suites names.
 *
 * @param testNames names of the test suites in an Apex file line
 * @returns list of the test suites
 */
export function parseTestSuitesNames(testSuitesNames: string[] | null): string[] {
  if (!testSuitesNames || testSuitesNames.length === 0) {
    return [];
  }

  // remove the prefix @testsuites
  return testSuitesNames
    .join(' ')
    .replace(/(@testsuites\s*:\s*)/gi, '')
    .replace(/[,\s]+/g, ' ')
    .trim()
    .split(' ');
}
