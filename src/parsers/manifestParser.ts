'use strict';

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { findChild, findChildren, parseXml } from '../utils/xmlParser.js';

// Salesforce's metadata registry resolves type names case-insensitively;
// manifests may declare them in any case (e.g. "apexclass"), but downstream
// consumers compare against the canonical capitalization.
const CANONICAL_TYPE_NAMES: Record<string, string> = {
  apexclass: 'ApexClass',
  apextrigger: 'ApexTrigger',
};

function canonicalTypeName(typeName: string): string {
  return CANONICAL_TYPE_NAMES[typeName.toLowerCase()] ?? typeName;
}

/**
 * Given a certain manifest file, reads that file and returns the classes,
 * triggers and test suites members with their types as prefix.
 *
 * For example, as ApexClass:MyClass.
 *
 * @param manifestFile the path to the manifest file
 * @returns a list of strings with the type and member names
 */
export async function extractTypeNamesFromManifestFile(manifestFile: string): Promise<string[]> {
  const result: string[] = [];

  if (!manifestFile || !existsSync(manifestFile)) {
    return result;
  }

  const content = await readFile(manifestFile, 'utf-8');
  const root = parseXml(content);

  for (const typesElement of findChildren(root, 'types')) {
    const nameElement = findChild(typesElement, 'name');
    if (!nameElement) continue;

    const typeName = canonicalTypeName(nameElement.text.trim());
    for (const memberElement of findChildren(typesElement, 'members')) {
      result.push(`${typeName}:${memberElement.text.trim()}`);
    }
  }

  return result.sort((a, b) => a.localeCompare(b));
}
