import { resolve } from 'node:path';
import { extractTypeNamesFromManifestFile } from '../parsers/manifestParser.js';
import { loadTestMetadataDependencies, selectRelevantTests } from '../parsers/metadataFilterParser.js';
import { searchDirectoryForTestClasses } from '../readers/directorySearcher.js';
import { searchDirectoryForTestNamesInTestSuites } from '../readers/testSuiteSearcher.js';
import { METADATA_FILTER_CONFIG } from '../utils/constants.js';
import { formatList } from '../utils/formatters.js';
import { getPackageDirectories } from '../utils/getPackageDirectories.js';
import { ApextestsListResult, ListTestsOptions, SearchResult } from '../utils/types.js';
import { validateTests } from '../utils/validateTests.js';

export async function listTests({
  format = 'sf',
  manifest,
  ignoreMissingTests = false,
  ignoreDirs = [],
  noWarnings = false,
  filterByMetadata = false,
  warn = (): void => {
    // no-op default
  },
}: ListTestsOptions): Promise<ApextestsListResult> {
  let testClassesNames: string[] | null = null;
  const testSuitesNames: string[] = [];
  const allTestClasses: string[] = [];
  const warnings: string[] = [];

  const { metadataPaths: packageDirectories, repoRoot } = await getPackageDirectories(ignoreDirs);

  if (manifest) {
    const manifestMetadata = await extractTypeNamesFromManifestFile(manifest);
    testClassesNames = manifestMetadata.filter((name) => !name.endsWith('testSuite-meta.xml'));
    if (filterByMetadata) {
      const ymlConfigPath = resolve(repoRoot, METADATA_FILTER_CONFIG);
      const testMap = await loadTestMetadataDependencies(ymlConfigPath);
      const testsToRun = selectRelevantTests(testMap, manifestMetadata);
      allTestClasses.push(...testsToRun);
    }
  }

  if (!filterByMetadata) {
    for (const directory of packageDirectories) {
      const searchResult: SearchResult = await searchDirectoryForTestClasses(directory, testClassesNames);
      allTestClasses.push(...searchResult.classes);
      testSuitesNames.push(...searchResult.testSuites);
      if (searchResult.warnings?.length) {
        warnings.push(...searchResult.warnings);
      }
    }

    if (testSuitesNames.length > 0) {
      for (const directory of packageDirectories.filter((dir) => dir.includes('testSuites'))) {
        const testNames = await searchDirectoryForTestNamesInTestSuites(directory, packageDirectories);
        allTestClasses.push(...testNames);
      }
    }
  }

  let finalTestMethods = Array.from(new Set(allTestClasses.map((test) => test.trim())));

  if (ignoreMissingTests) {
    const { validatedTests, warnings: validationWarnings } = await validateTests(finalTestMethods, packageDirectories);
    finalTestMethods = validatedTests;
    warnings.push(...validationWarnings);
  }

  // Stryker disable next-line ConditionalExpression,EqualityOperator: empty array forEach is a no-op — guard is equivalent when warnings is empty
  if (!noWarnings && warnings.length > 0) {
    warnings.forEach(warn);
  }

  finalTestMethods.sort((a, b) => a.localeCompare(b));

  if (finalTestMethods.length === 0) {
    warn('No test methods found');
    return {
      tests: [],
      command: '',
    };
  }

  return formatList(format, finalTestMethods);
}
