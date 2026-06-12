import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

import { TestMetadataMap } from '../utils/types.js';

/**
 * Verifies structure matches the test metadata map type.
 */
function isTestMetadataMap(obj: unknown): obj is TestMetadataMap {
  if (typeof obj !== 'object' || obj === null) return false;

  return Object.entries(obj).every(
    // Stryker disable next-line ConditionalExpression: Object.entries always yields string keys — typeof key === 'string' is unconditionally true
    ([key, value]) => typeof key === 'string' && Array.isArray(value) && value.every((v) => typeof v === 'string'),
  );
}

/**
 * Loads the test metadata filter YAML file and confirms it matches the expected structure.
 */
export async function loadTestMetadataDependencies(configPath: string): Promise<TestMetadataMap> {
  const content = await readFile(configPath, 'utf-8');
  const parsed: unknown = parse(content);

  if (isTestMetadataMap(parsed)) {
    return parsed;
  }

  throw new Error('Invalid test metadata dependencies format in YAML');
}

/**
 * Compare two metadata strings like "CustomField:Account__c.Name"
 * against patterns with wildcards, like "CustomField:Account__c.*"
 */
function matchesDependency(dependency: string, changed: string): boolean {
  if (dependency.includes('*')) {
    const pattern = dependency.replace('.', '\\.').replace('*', '.*');
    return new RegExp(`^${pattern}$`).test(changed);
  }
  return dependency === changed;
}

/**
 * Return test classes that depend on any of the changed metadata.
 */
export function selectRelevantTests(testMap: TestMetadataMap, changedMetadata: string[]): string[] {
  const selected: string[] = [];

  for (const [testClass, dependencies] of Object.entries(testMap)) {
    const matches = changedMetadata.some((changed) => dependencies.some((dep) => matchesDependency(dep, changed)));
    if (matches) {
      selected.push(testClass);
    }
  }

  return selected;
}
