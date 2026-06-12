'use strict';

import { resolve, join, basename } from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';

import { getRepoRoot } from './getRepoRoot.js';
import { SfdxProject } from './types.js';
import { SEARCHABLE_METADATA_FOLDERS } from './constants.js';

export async function getPackageDirectories(
  ignoreDirs: string[],
): Promise<{ metadataPaths: string[]; repoRoot: string }> {
  const { repoRoot, dxConfigFilePath } = await getRepoRoot();

  /* v8 ignore next 3 */
  if (!repoRoot || !dxConfigFilePath) {
    throw new Error('Failed to retrieve repository root or sfdx-project.json path.');
  }

  const sfdxProjectRaw: string = await readFile(dxConfigFilePath, 'utf-8');
  const sfdxProject: SfdxProject = JSON.parse(sfdxProjectRaw) as SfdxProject;
  const packageDirectories = sfdxProject.packageDirectories
    .map((directory) => resolve(repoRoot, directory.path))
    .filter((directory) => !ignoreDirs.includes(basename(directory)));

  const metadataPaths = (
    await Promise.all(
      packageDirectories.map((directory) => searchForSubFolders(directory, SEARCHABLE_METADATA_FOLDERS)),
    )
  ).flat();

  return { metadataPaths, repoRoot };
}

async function searchForSubFolders(dxDirectory: string, subDirectoryNames: string[]): Promise<string[]> {
  const foundPaths: string[] = [];
  const files = await readdir(dxDirectory);

  const subfolderChecks = await Promise.all(
    files.map(async (file) => {
      const filePath = join(dxDirectory, file);
      const stats = await stat(filePath);

      if (stats.isDirectory() && subDirectoryNames.includes(file)) {
        return [filePath];
        /* v8 ignore start */
      } else if (stats.isDirectory()) {
        return searchForSubFolders(filePath, subDirectoryNames);
        /* v8 ignore stop */
      }
      return [];
    }),
  );

  for (const paths of subfolderChecks) {
    foundPaths.push(...paths);
  }

  return foundPaths;
}
