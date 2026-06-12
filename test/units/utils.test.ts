import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { formatList } from '../../src/utils/formatters.js';
import { getRepoRoot } from '../../src/utils/getRepoRoot.js';
import { validateTests } from '../../src/utils/validateTests.js';

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
});
