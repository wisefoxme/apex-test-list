import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, availableParallelism } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { formatList } from '../../src/utils/formatters.js';
import { getRepoRoot } from '../../src/utils/getRepoRoot.js';
import { validateTests } from '../../src/utils/validateTests.js';
import { getConcurrencyThreshold } from '../../src/utils/concurrencyThreshold.js';

describe('formatList', () => {
  it('sfdx format joins tests with space', async () => {
    const result = await formatList('sfdx', ['Test1', 'Test2']);
    expect(result.tests).to.deep.equal(['Test1', 'Test2']);
    expect(result.command).to.equal('--tests Test1 Test2');
  });

  it('throws on unknown format', async () => {
    await expect(formatList('unknown', [])).rejects.toThrow('Invalid format.');
  });
});

describe('getRepoRoot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when no sfdx-project.json found in any parent directory', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue('C:\\definitely-no-sfdx-project-json-here\\deep\\path');
    await expect(getRepoRoot()).rejects.toThrow('sfdx-project.json not found in any parent directory.');
  });

  it('finds sfdx-project.json by traversing parent directories', async () => {
    const tempBase = await mkdtemp(join(tmpdir(), 'repo-root-'));
    const subDir = join(tempBase, 'src', 'deep');
    await mkdir(subDir, { recursive: true });
    await writeFile(join(tempBase, 'sfdx-project.json'), '{}');
    vi.spyOn(process, 'cwd').mockReturnValue(subDir);
    try {
      const { repoRoot } = await getRepoRoot();
      expect(repoRoot).toBe(tempBase);
    } finally {
      await rm(tempBase, { recursive: true });
    }
  });
});

describe('validateTests', () => {
  it('finds file in nested subdirectory', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'validate-test-'));
    const subDir = join(tempDir, 'sub');
    await mkdir(subDir);
    await writeFile(join(subDir, 'SomeTest.cls'), '');

    try {
      const { validatedTests, warnings } = await validateTests(['SomeTest'], [tempDir]);
      expect(validatedTests).to.deep.equal(['SomeTest']);
      expect(warnings).to.deep.equal([]);
    } finally {
      await rm(tempDir, { recursive: true });
    }
  });

  it('finds file in second directory when absent from first', async () => {
    const dir1 = await mkdtemp(join(tmpdir(), 'val1-'));
    const dir2 = await mkdtemp(join(tmpdir(), 'val2-'));
    await writeFile(join(dir2, 'SomeTest.cls'), '');
    try {
      const { validatedTests, warnings } = await validateTests(['SomeTest'], [dir1, dir2]);
      expect(validatedTests).toEqual(['SomeTest']);
      expect(warnings).toEqual([]);
    } finally {
      await rm(dir1, { recursive: true });
      await rm(dir2, { recursive: true });
    }
  });
});

describe('getConcurrencyThreshold', () => {
  it('returns Math.min of availableParallelism and 6', () => {
    const result = getConcurrencyThreshold();
    expect(result).toBe(Math.min(availableParallelism(), 6));
  });
});
