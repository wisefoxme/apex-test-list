'use strict';

import { readFile, writeFile } from 'node:fs/promises';

import { TEST_NAME_REGEX, TEST_SUITE_NAME_REGEX } from '../utils/constants.js';
import { Insert, insertAnnotations, mergeExisting } from './header.js';
import { loadProject, stripBom } from './project.js';
import { loadTemplate } from './template.js';
import { ApexFile, Io, MapError, MapOptions, Project } from './types.js';

type PlanEntry = { tests: string[]; suites: string[] };

type Change = { target: ApexFile; tests: string[]; suites: string[] };

type FileReport = { file: string; addedTests: string[]; addedSuites: string[]; changed: boolean };

const NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

function normalizePlanEntry(key: string, value: unknown): PlanEntry {
  if (Array.isArray(value)) return { tests: value as string[], suites: [] };
  if (value && typeof value === 'object') {
    const entry = value as { tests?: unknown; suites?: unknown };
    return {
      tests: Array.isArray(entry.tests) ? (entry.tests as string[]) : [],
      suites: Array.isArray(entry.suites) ? (entry.suites as string[]) : [],
    };
  }
  throw new MapError(`Plan entry "${key}" must be an array of test names or { "tests": [...], "suites": [...] }`);
}

async function readPlan(file: string): Promise<Record<string, unknown>> {
  let plan: unknown;
  try {
    plan = JSON.parse(stripBom(await readFile(file, 'utf8')));
  } catch (error) {
    throw new MapError(`Cannot read plan ${file}: ${(error as Error).message}`, { cause: error });
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new MapError('Plan must be a JSON object');
  return plan as Record<string, unknown>;
}

/** Checks one plan entry; returns the change to make, or a problem to report. */
function checkEntry(
  rawKey: string,
  value: unknown,
  project: Project,
  suiteNames: Set<string>,
  allowUnknown: boolean,
): Change | string {
  const entry = normalizePlanEntry(rawKey, value);
  const kindMatch = /^(class|trigger):(.+)$/i.exec(rawKey);
  const kind = kindMatch ? kindMatch[1].toLowerCase() : null;
  const name = (kindMatch ? kindMatch[2] : rawKey).trim();
  const matches = project.apex.filter((a) => a.name.toLowerCase() === name.toLowerCase() && (!kind || a.kind === kind));
  if (matches.length === 0) return `${rawKey}: no class or trigger with that name`;
  if (matches.length > 1) {
    return `${rawKey}: matches ${matches.map((m) => m.file).join(' and ')}; prefix the key with "class:" or "trigger:"`;
  }
  const target = matches[0];
  if (target.isTest) return `${rawKey}: is a test class; it runs on its own and needs no @Tests annotation`;

  const tests = entry.tests.map((t) => String(t).trim()).filter(Boolean);
  const suites = entry.suites.map((s) => String(s).trim()).filter(Boolean);
  const badNames = [...tests, ...suites].filter((n) => !NAME_REGEX.test(n));
  if (badNames.length) return `${rawKey}: invalid names ${badNames.join(', ')}`;
  if (!allowUnknown) {
    const unknownTests = tests.filter((t) => !project.testsByLower.has(t.toLowerCase()));
    const unknownSuites = suites.filter((s) => !suiteNames.has(s.toLowerCase())).map((s) => `suite ${s}`);
    if (unknownTests.length || unknownSuites.length) {
      return `${rawKey}: not found locally: ${[...unknownTests, ...unknownSuites].join(', ')} (use --allow-unknown for tests that only exist in the org)`;
    }
  }
  // Write local test classes with their own capitalization; org-only names stay as given.
  return { target, tests: tests.map((t) => project.testsByLower.get(t.toLowerCase())?.name ?? t), suites };
}

function formatReport(report: FileReport[], dryRun: boolean): string {
  const lines: string[] = [];
  for (const r of report) {
    if (!r.changed) {
      lines.push(`unchanged  ${r.file}`);
      continue;
    }
    const parts: string[] = [];
    if (r.addedTests.length) parts.push(`@Tests += ${r.addedTests.join(', ')}`);
    if (r.addedSuites.length) parts.push(`@TestSuites += ${r.addedSuites.join(', ')}`);
    lines.push(`${dryRun ? 'would update' : 'updated'}  ${r.file}  ${parts.join('; ')}`);
  }
  const count = report.filter((r) => r.changed).length;
  lines.push(`${count} file(s) ${dryRun ? 'would change' : 'changed'}, ${report.length - count} unchanged.`);
  return lines.join('\n');
}

/** Writes or merges `@Tests:` / `@TestSuites:` annotations from a reviewed plan. */
export async function apply(opts: MapOptions, io: Io): Promise<void> {
  if (!opts.plan) throw new MapError('apply needs --plan <file>');
  const plan = await readPlan(opts.plan);
  const template = opts.headerTemplate ? await loadTemplate(opts.headerTemplate) : null;
  const project = await loadProject(opts);
  const suiteNames = new Set(project.suites.map((s) => s.name.toLowerCase()));

  const errors: string[] = [];
  const changes: Change[] = [];
  for (const [rawKey, value] of Object.entries(plan)) {
    const result = checkEntry(rawKey, value, project, suiteNames, opts.allowUnknown);
    if (typeof result === 'string') errors.push(result);
    else changes.push(result);
  }
  if (errors.length) {
    throw new MapError(`Plan has problems; no files were changed:\n  ${errors.join('\n  ')}`, { exitCode: 1 });
  }

  const report: FileReport[] = [];
  for (const { target, tests, suites } of changes) {
    const original = await readFile(target.path, 'utf8');
    const bom = original.charCodeAt(0) === 0xfeff ? '﻿' : '';
    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    let content = stripBom(original);
    const t = mergeExisting(content, TEST_NAME_REGEX, tests);
    content = t.content;
    const s = mergeExisting(content, TEST_SUITE_NAME_REGEX, suites);
    content = s.content;
    const inserts: Insert[] = [];
    if (t.pending.length) inserts.push({ label: '@Tests', names: t.pending });
    if (s.pending.length) inserts.push({ label: '@TestSuites', names: s.pending });
    // Stryker disable next-line ConditionalExpression: with nothing to insert, the content only changes when no name
    // was added, and then `changed` is false and the file isn't written.
    if (inserts.length) content = insertAnnotations(content, inserts, eol, template, target);
    const changed = t.added.length > 0 || s.added.length > 0;
    if (changed && !opts.dryRun) await writeFile(target.path, bom + content);
    report.push({ file: target.file, addedTests: t.added, addedSuites: s.added, changed });
  }

  if (opts.json) io.out(`${JSON.stringify({ dryRun: opts.dryRun, files: report }, null, 2)}\n`);
  else io.out(`${formatReport(report, opts.dryRun)}\n`);
}
