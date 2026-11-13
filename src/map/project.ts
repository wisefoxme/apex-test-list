'use strict';

import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

import { parseTestSuiteFile } from '../parsers/testSuiteParser.js';
import { TEST_CLASS_ANNOTATION_REGEX, TEST_NAME_REGEX, TEST_SUITE_NAME_REGEX } from '../utils/constants.js';
import { getPackageDirectories } from '../utils/getPackageDirectories.js';
import { SfdxProject } from '../utils/types.js';
import { ApexFile, Coverage, MapError, MapOptions, Project, Suite } from './types.js';

const DML_REGEX =
  /\b(insert|update|upsert|delete|undelete|merge)\b|\bdatabase\s*\.\s*(insert|update|upsert|delete|undelete|merge)/i;

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

/** Removes comments and string literals so only code identifiers remain. */
export function stripCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
    } else if (c === "'") {
      i++;
      while (i < src.length && src[i] !== "'") i += src[i] === '\\' ? 2 : 1;
      i++;
      out += "''";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Reads `@Tests:` or `@TestSuites:` names the way apextestlist does: the
 * plugin's own regex, names separated by commas and/or whitespace.
 */
export function parseAnnotation(raw: string, regex: RegExp): string[] {
  const names: string[] = [];
  for (const match of raw.matchAll(new RegExp(regex.source, 'gi'))) {
    for (const name of match[1].split(/[,\s]+/)) {
      const clean = name.replace(/\*/g, '').trim();
      if (clean) names.push(clean);
    }
  }
  return names;
}

export function parseTests(raw: string): string[] {
  return parseAnnotation(raw, TEST_NAME_REGEX);
}

export function parseSuites(raw: string): string[] {
  return parseAnnotation(raw, TEST_SUITE_NAME_REGEX);
}

export async function readApexFile(path: string, root: string): Promise<ApexFile> {
  const raw = stripBom(await readFile(path, 'utf8'));
  const isTrigger = path.endsWith('.trigger');
  const name = basename(path, isTrigger ? '.trigger' : '.cls');
  const code = stripCommentsAndStrings(raw);
  const tokens = new Set(Array.from(code.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g), (m) => m[0].toLowerCase()));
  tokens.delete(name.toLowerCase());
  const sObjectMatch = isTrigger ? /\btrigger\s+\w+\s+on\s+(\w+)/i.exec(code) : null;
  return {
    name,
    kind: isTrigger ? 'trigger' : 'class',
    file: normalizePath(relative(root, path)),
    path,
    isTest: !isTrigger && new RegExp(TEST_CLASS_ANNOTATION_REGEX.source, 'i').test(raw),
    tests: parseTests(raw),
    suites: parseSuites(raw),
    tokens,
    sObject: sObjectMatch ? sObjectMatch[1] : undefined,
    hasDml: DML_REGEX.test(code),
  };
}

async function readSuite(path: string, root: string): Promise<Suite> {
  const suite: Suite = {
    name: basename(path, '.testSuite-meta.xml'),
    file: normalizePath(relative(root, path)),
    classes: [],
  };
  try {
    suite.classes = parseTestSuiteFile(await readFile(path, 'utf8'));
  } catch (error) {
    suite.error = (error as Error).message;
  }
  return suite;
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.map((entry) => join(dir, entry));
}

/** Package directories from sfdx-project.json, as written there, minus ignored ones. */
async function readPackageDirectoryNames(root: string, ignore: string[]): Promise<string[]> {
  const project = JSON.parse(stripBom(await readFile(join(root, 'sfdx-project.json'), 'utf8'))) as SfdxProject;
  const names = project.packageDirectories.map((d) => normalizePath(d.path).replace(/^\.\//, '').replace(/\/+$/, ''));
  return [...new Set(names)].filter((name) => !ignore.includes(basename(name)));
}

/**
 * Loads the project's Apex classes, triggers, and test suites from the same
 * folders apextestlist searches (`classes`, `triggers`, `testSuites` in each
 * package directory, minus ignored package directories).
 */
export async function loadProject(opts: Pick<MapOptions, 'project' | 'ignore'>): Promise<Project> {
  let found: { metadataPaths: string[]; repoRoot: string };
  try {
    found = await getPackageDirectories(opts.ignore, resolve(opts.project));
  } catch (error) {
    throw new MapError(`Cannot read the Salesforce DX project: ${(error as Error).message}`, { cause: error });
  }
  const root = found.repoRoot;
  const files = (await Promise.all(found.metadataPaths.map(listFiles))).flat().sort();
  const apex = await Promise.all(
    files.filter((f) => f.endsWith('.cls') || f.endsWith('.trigger')).map((f) => readApexFile(f, root)),
  );
  const suites = await Promise.all(
    files.filter((f) => f.endsWith('.testSuite-meta.xml')).map((f) => readSuite(f, root)),
  );
  const tests = apex.filter((a) => a.isTest);
  return {
    root,
    pkgDirs: await readPackageDirectoryNames(root, opts.ignore),
    apex,
    suites,
    tests,
    testsByLower: new Map(tests.map((t) => [t.name.toLowerCase(), t])),
    classesByLower: new Map(apex.filter((a) => a.kind === 'class').map((a) => [a.name.toLowerCase(), a])),
  };
}

type CoverageRecord = { ApexClassOrTrigger?: { Name?: string }; ApexTestClass?: { Name?: string } };

/** Reads `sf data query --json` output of ApexCodeCoverage (or its records array). */
export async function loadCoverage(file: string | undefined): Promise<Coverage | null> {
  if (!file) return null;
  let data: unknown;
  try {
    data = JSON.parse(stripBom(await readFile(file, 'utf8')));
  } catch (error) {
    throw new MapError(`Cannot read coverage file ${file}: ${(error as Error).message}`, { cause: error });
  }
  const wrapped = data as { result?: { records?: unknown }; records?: unknown };
  const records = wrapped?.result?.records ?? wrapped?.records ?? (Array.isArray(data) ? data : null);
  if (!Array.isArray(records)) throw new MapError(`Coverage file ${file} has no records array`);
  const map: Coverage = new Map();
  for (const record of records as CoverageRecord[]) {
    const target = record?.ApexClassOrTrigger?.Name;
    const test = record?.ApexTestClass?.Name;
    if (!target || !test) continue;
    const key = target.toLowerCase();
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)?.add(test);
  }
  return map;
}
