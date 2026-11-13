'use strict';

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { METADATA_FILTER_CONFIG } from '../utils/constants.js';
import { matchWildcard } from '../utils/matchWildcard.js';
import { parseYaml } from '../utils/yamlParser.js';
import { findLeadingHeader, isInHeader } from './header.js';
import { loadCoverage, loadProject, stripBom } from './project.js';
import { HeaderTemplate, loadTemplate } from './template.js';
import { ApexFile, Coverage, Io, MapOptions, Project, Suite } from './types.js';

const METADATA_ENTRY_REGEX = /^[A-Za-z]+:[^\s:]+$/;

type Named = { file: string; name: string };

type CoverageGap =
  | { file: string; missing: string[]; stale: string[] }
  | { file: string; issue: string; annotated: string[]; missing: string[] };

type HeaderProblem = { file: string; issue: string };

export type AuditResult = {
  projectRoot: string;
  coverageUsed: boolean;
  counts: { classesAndTriggers: number; testClasses: number; suites: number };
  unannotated: string[];
  unknownTests: Named[];
  notTests: Named[];
  unknownSuites: Named[];
  suiteProblems: Named[];
  broad: Array<{ file: string; count: number }>;
  coverageGaps: CoverageGap[];
  testDependencies: { tests: number; problems: string[] } | null;
  headerProblems: HeaderProblem[] | null;
};

/** Suite entries match test names the way apextestlist does, ignoring a namespace prefix. */
function suiteEntryMatches(entry: string, test: string): boolean {
  // Without a dot, lastIndexOf is -1 and the slice keeps the whole name.
  const bare = entry.slice(entry.lastIndexOf('.') + 1);
  return bare.includes('*') ? matchWildcard(bare, test) : bare.toLowerCase() === test.toLowerCase();
}

function coverageGaps(targets: ApexFile[], coverage: Coverage, suiteByLower: Map<string, Suite>): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  for (const t of targets) {
    const covered = coverage.get(t.name.toLowerCase());
    if (!covered) {
      if (t.tests.length) {
        gaps.push({ file: t.file, issue: 'no coverage rows in the org data', annotated: t.tests, missing: [] });
      }
      continue;
    }
    const coveredLower = new Set([...covered].map((c) => c.toLowerCase()));
    const annotatedLower = new Set(t.tests.map((c) => c.toLowerCase()));
    const suiteNames = new Set(t.suites.map((s) => s.toLowerCase()));
    const viaSuites = [...suiteByLower.values()]
      .filter((s) => suiteNames.has(s.name.toLowerCase()))
      .flatMap((s) => s.classes);
    const isSelected = (test: string): boolean =>
      annotatedLower.has(test.toLowerCase()) || viaSuites.some((entry) => suiteEntryMatches(entry, test));
    const missing = [...covered].filter((c) => !isSelected(c)).sort();
    const stale = t.tests.filter((a) => !coveredLower.has(a.toLowerCase()));
    if (missing.length || stale.length) gaps.push({ file: t.file, missing, stale });
  }
  return gaps;
}

function suiteProblems(project: Project): Named[] {
  const problems: Named[] = [];
  for (const s of project.suites) {
    if (s.error) problems.push({ file: s.file, name: `cannot read the suite: ${s.error}` });
    for (const entry of s.classes) {
      if (!project.tests.some((t) => suiteEntryMatches(entry, t.name))) problems.push({ file: s.file, name: entry });
    }
  }
  return problems;
}

/** Checks .test-dependencies.yml with the same parser apextestlist uses. */
async function testDependencyProblems(project: Project): Promise<AuditResult['testDependencies']> {
  const file = join(project.root, METADATA_FILTER_CONFIG);
  if (!existsSync(file)) return null;
  const parsed = parseYaml(stripBom(await readFile(file, 'utf8')));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { tests: 0, problems: ['the file is not a map of test classes to metadata lists'] };
  }
  const problems: string[] = [];
  const entries = Object.entries(parsed as Record<string, unknown>);
  for (const [test, value] of entries) {
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      problems.push(`"${test}" must list Type:Member entries; apextestlist rejects the file otherwise`);
    } else {
      for (const item of value as string[]) {
        if (!METADATA_ENTRY_REGEX.test(item)) problems.push(`"${test}": "${item}" is not Type:Member`);
      }
    }
    if (!project.testsByLower.has(test.toLowerCase())) problems.push(`"${test}" is not a local @isTest class`);
  }
  return { tests: entries.length, problems };
}

/** Annotated files whose annotations aren't inside a leading header of the template's comment style. */
async function headerProblems(targets: ApexFile[], template: HeaderTemplate): Promise<HeaderProblem[]> {
  const problems: HeaderProblem[] = [];
  for (const t of targets) {
    if (!t.tests.length && !t.suites.length) continue;
    const content = stripBom(await readFile(t.path, 'utf8'));
    const header = findLeadingHeader(content);
    // Only annotated files get here, so the annotation is always found.
    const first = (/@(tests|testsuites)\s*:/i.exec(content) as RegExpExecArray).index;
    if (!header) problems.push({ file: t.file, issue: 'no leading header comment' });
    else if (header.type !== template.type) {
      problems.push({
        file: t.file,
        issue: `header is a ${header.type} comment; the template uses a ${template.type} comment`,
      });
    } else if (!isInHeader(header, first)) {
      problems.push({ file: t.file, issue: 'annotation is outside the leading header' });
    }
  }
  return problems;
}

function formatGap(x: CoverageGap): string {
  if ('issue' in x) return `${x.file}: ${x.issue}; annotated ${x.annotated.join(', ')}`;
  const parts = [
    x.missing.length ? `covering tests not annotated: ${x.missing.join(', ')}` : '',
    x.stale.length ? `annotated but no coverage: ${x.stale.join(', ')}` : '',
  ];
  return `${x.file}: ${parts.filter(Boolean).join('; ')}`;
}

function formatAudit(result: AuditResult, maxTests: number): string {
  const lines = [
    `Project: ${result.projectRoot}`,
    `Classes/triggers: ${result.counts.classesAndTriggers} | test classes: ${result.counts.testClasses} | suites: ${result.counts.suites} | coverage data: ${result.coverageUsed ? 'yes' : 'no'}`,
    '',
  ];
  const section = <T>(title: string, items: T[], fmt: (item: T) => string): void => {
    lines.push(`${title}: ${items.length}`);
    for (const item of items) lines.push(`  ${fmt(item)}`);
  };
  const named = (x: Named): string => `${x.file}: ${x.name}`;
  section('No @Tests or @TestSuites (no tests run when these change)', result.unannotated, (f) => f);
  section('@Tests names that are not local classes', result.unknownTests, named);
  section('@Tests names that are classes without @isTest', result.notTests, named);
  section('@TestSuites names with no local suite', result.unknownSuites, named);
  section('Suite entries that match no local test class', result.suiteProblems, named);
  section(`Annotations with more than ${maxTests} tests`, result.broad, (x) => `${x.file}: ${x.count} tests`);
  if (result.coverageUsed) section('Differences from org coverage', result.coverageGaps, formatGap);
  if (result.headerProblems) {
    section(
      'Annotations not in a leading header like the template',
      result.headerProblems,
      (x) => `${x.file}: ${x.issue}`,
    );
  }
  if (result.testDependencies)
    section(`${METADATA_FILTER_CONFIG} problems`, result.testDependencies.problems, (x) => x);
  else lines.push(`${METADATA_FILTER_CONFIG}: not present`);
  return lines.join('\n');
}

/** Reports missing, unknown, and stale annotations, and drift from org coverage. */
export async function audit(opts: MapOptions, io: Io): Promise<void> {
  const template = opts.headerTemplate ? await loadTemplate(opts.headerTemplate) : null;
  const project = await loadProject(opts);
  const coverage = await loadCoverage(opts.coverage);
  const suiteByLower = new Map(project.suites.map((s) => [s.name.toLowerCase(), s]));
  const targets = project.apex.filter((a) => !a.isTest);

  const result: AuditResult = {
    projectRoot: project.root,
    coverageUsed: Boolean(coverage),
    counts: { classesAndTriggers: targets.length, testClasses: project.tests.length, suites: project.suites.length },
    unannotated: targets.filter((t) => !t.tests.length && !t.suites.length).map((t) => t.file),
    unknownTests: [],
    notTests: [],
    unknownSuites: [],
    suiteProblems: suiteProblems(project),
    broad: [],
    coverageGaps: coverage ? coverageGaps(targets, coverage, suiteByLower) : [],
    testDependencies: await testDependencyProblems(project),
    headerProblems: template ? await headerProblems(targets, template) : null,
  };

  for (const t of project.apex) {
    for (const name of t.tests) {
      const key = name.toLowerCase();
      if (project.testsByLower.has(key)) continue;
      if (project.classesByLower.has(key)) result.notTests.push({ file: t.file, name });
      else result.unknownTests.push({ file: t.file, name });
    }
    for (const name of t.suites) {
      if (!suiteByLower.has(name.toLowerCase())) result.unknownSuites.push({ file: t.file, name });
    }
    if (!t.isTest && t.tests.length > opts.maxTests) result.broad.push({ file: t.file, count: t.tests.length });
  }

  io.out(`${opts.json ? JSON.stringify(result, null, 2) : formatAudit(result, opts.maxTests)}\n`);
}
