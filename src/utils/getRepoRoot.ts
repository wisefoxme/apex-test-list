'use strict';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { SFDX_PROJECT_FILE_NAME } from '../utils/constants.js';

async function findRepoRoot(dir: string): Promise<{ repoRoot: string; dxConfigFilePath: string }> {
  const filePath = join(dir, SFDX_PROJECT_FILE_NAME);
  try {
    // Check if sfdx-project.json exists in the current directory
    await access(filePath);
    return { repoRoot: dir, dxConfigFilePath: filePath };
  } catch (error) {
    const parentDir = dirname(dir);
    if (dir === parentDir) {
      // Reached the root without finding the file, throw an error
      throw new Error('sfdx-project.json not found in any parent directory.', { cause: error });
    }
    // Recursively search in the parent directory
    return findRepoRoot(parentDir);
  }
}

/**
 * Finds the Salesforce DX project root: the nearest folder, from `startDir`
 * upwards, that contains sfdx-project.json.
 *
 * @param startDir folder to start from; defaults to the current working directory
 */
export async function getRepoRoot(startDir?: string): Promise<{ repoRoot: string; dxConfigFilePath: string }> {
  return findRepoRoot(startDir ?? process.cwd());
}
