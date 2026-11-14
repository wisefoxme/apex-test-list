import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf-8')) as T;
}

const root = readJson<{ version: string; bin: Record<string, string>; files: string[] }>('package.json');

describe('apex-test-map command', () => {
  it('is published as a bin of the npm package, which the plugin skills run with npx', () => {
    expect(root.bin).toEqual({ 'apex-test-map': './bin/apex-test-map.mjs' });
    expect(root.files).toContain('/bin/apex-test-map.mjs');
    expect(readFileSync(resolve(process.cwd(), 'bin/apex-test-map.mjs'), 'utf-8')).toMatch(/^#!\/usr\/bin\/env node\n/);
  });
});

describe('Claude Code plugin', () => {
  it('has the same version as the npm package, so Claude Code offers updates on each release', () => {
    const plugin = readJson<{ name: string; version: string }>('plugins/apex-test-list/.claude-plugin/plugin.json');
    expect(plugin.name).toBe('apex-test-list');
    expect(plugin.version).toBe(root.version);
  });

  it('is bumped by release-please with every release', () => {
    const config = readJson<{
      packages: Record<string, { 'extra-files': Array<{ path: string; jsonpath: string }> }>;
    }>('release-please-config.json');
    expect(config.packages['.']['extra-files']).toContainEqual(
      expect.objectContaining({ path: 'plugins/apex-test-list/.claude-plugin/plugin.json', jsonpath: '$.version' }),
    );
  });

  it('tracks the released version in the release-please manifest', () => {
    expect(readJson<Record<string, string>>('.release-please-manifest.json')['.']).toBe(root.version);
  });
});
