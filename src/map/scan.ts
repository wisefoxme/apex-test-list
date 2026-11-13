'use strict';

import { loadCoverage, loadProject } from './project.js';
import { ApexFile, Coverage, Io, MapOptions, Project } from './types.js';

export type ProposalSource = 'coverage' | 'name' | 'handler' | 'reference';

export type Proposal = { test: string; sources: ProposalSource[] };

export type ScanTarget = {
  name: string;
  kind: ApexFile['kind'];
  file: string;
  existing: { tests: string[]; suites: string[] };
  sObject?: string;
  handlers?: string[];
  dmlCandidates?: { count: number; sample: string[] };
  proposed: Proposal[];
  missingLocally: string[];
  broad: boolean;
};

const SOURCE_RANK: Record<ProposalSource, number> = { coverage: 0, name: 1, handler: 2, reference: 3 };

function nameConventionMatches(target: string, testsByLower: Project['testsByLower']): string[] {
  const n = target.toLowerCase();
  const candidates = [`${n}test`, `${n}_test`, `${n}tests`, `${n}_tests`, `test${n}`, `test_${n}`];
  return candidates.flatMap((c) => {
    const test = testsByLower.get(c);
    return test ? [test.name] : [];
  });
}

function addProposal(proposals: Map<string, Proposal>, test: string, source: ProposalSource): void {
  const key = test.toLowerCase();
  let proposal = proposals.get(key);
  if (!proposal) {
    proposal = { test, sources: [] };
    proposals.set(key, proposal);
  }
  if (!proposal.sources.includes(source)) proposal.sources.push(source);
}

function directProposals(target: ApexFile, project: Project, coverage: Coverage | null): Map<string, Proposal> {
  const proposals = new Map<string, Proposal>();
  for (const test of coverage?.get(target.name.toLowerCase()) ?? []) {
    addProposal(proposals, project.testsByLower.get(test.toLowerCase())?.name ?? test, 'coverage');
  }
  if (target.kind === 'class') {
    const lower = target.name.toLowerCase();
    for (const test of project.tests) {
      if (test.tokens.has(lower)) addProposal(proposals, test.name, 'reference');
    }
  }
  for (const test of nameConventionMatches(target.name, project.testsByLower)) addProposal(proposals, test, 'name');
  return proposals;
}

function rank(proposal: Proposal): number {
  return Math.min(...proposal.sources.map((s) => SOURCE_RANK[s]));
}

export function scanTarget(
  target: ApexFile,
  project: Project,
  coverage: Coverage | null,
  maxTests: number,
): ScanTarget {
  const proposals = directProposals(target, project, coverage);
  const trigger: Pick<ScanTarget, 'sObject' | 'handlers' | 'dmlCandidates'> = {};

  if (target.kind === 'trigger') {
    trigger.sObject = target.sObject;
    // Tests of the handler classes the trigger calls.
    const handlers = [...target.tokens].flatMap((t) => {
      const cls = project.classesByLower.get(t);
      return cls && !cls.isTest ? [cls] : [];
    });
    trigger.handlers = handlers.map((h) => h.name);
    for (const handler of handlers) {
      for (const p of directProposals(handler, project, null).values()) addProposal(proposals, p.test, 'handler');
    }
    // Tests that run DML on the trigger's object fire it, but that set is usually broad.
    if (target.sObject) {
      const so = target.sObject.toLowerCase();
      const dml = project.tests.filter((t) => t.hasDml && t.tokens.has(so) && !proposals.has(t.name.toLowerCase()));
      trigger.dmlCandidates = { count: dml.length, sample: dml.slice(0, 25).map((t) => t.name) };
    }
  }

  const proposed = [...proposals.values()].sort((a, b) => rank(a) - rank(b) || a.test.localeCompare(b.test));
  return {
    name: target.name,
    kind: target.kind,
    file: target.file,
    existing: { tests: target.tests, suites: target.suites },
    ...trigger,
    proposed,
    missingLocally: proposed.filter((p) => !project.testsByLower.has(p.test.toLowerCase())).map((p) => p.test),
    broad: proposed.length > maxTests,
  };
}

function formatTarget(r: ScanTarget, maxTests: number): string[] {
  const existing = [
    r.existing.tests.length ? `@Tests: ${r.existing.tests.join(', ')}` : '',
    r.existing.suites.length ? `@TestSuites: ${r.existing.suites.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' | ');
  const shown = r.proposed.slice(0, maxTests).map((p) => `${p.test}[${p.sources.join(',')}]`);
  const more = r.proposed.length > maxTests ? ` +${r.proposed.length - maxTests} more (BROAD)` : '';
  const lines = [
    `${r.kind === 'trigger' ? 'trigger ' : ''}${r.name}  (${r.file})`,
    `  existing: ${existing || '-'}`,
    `  proposed: ${shown.join(', ') || '-'}${more}`,
  ];
  if (r.kind === 'trigger') {
    // Triggers always get handlers; dmlCandidates only when the trigger names its object.
    lines.push(`  on ${r.sObject ?? '?'}; calls: ${(r.handlers as string[]).join(', ') || '-'}`);
    const dml = r.dmlCandidates;
    if (dml?.count) {
      const extra = dml.count > dml.sample.length ? ` +${dml.count - dml.sample.length} more` : '';
      lines.push(`  DML on ${r.sObject as string} (fires trigger, not proposed): ${dml.sample.join(', ')}${extra}`);
    }
  }
  if (r.missingLocally.length) lines.push(`  not found locally: ${r.missingLocally.join(', ')}`);
  return lines;
}

/** Proposes tests for each class and trigger from coverage, naming, trigger handlers, and references. */
export async function scan(opts: MapOptions, io: Io): Promise<void> {
  const project = await loadProject(opts);
  const coverage = await loadCoverage(opts.coverage);
  let targets = project.apex.filter((a) => !a.isTest);
  const only = opts.only;
  if (only) targets = targets.filter((t) => only.has(t.name.toLowerCase()));
  if (opts.missingOnly) targets = targets.filter((t) => t.tests.length === 0 && t.suites.length === 0);
  targets.sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
  const results = targets.map((t) => scanTarget(t, project, coverage, opts.maxTests));

  const summary = {
    projectRoot: project.root,
    packageDirectories: project.pkgDirs,
    coverageUsed: Boolean(coverage),
    testClasses: project.tests.length,
    targets: results.length,
    alreadyAnnotated: results.filter((r) => r.existing.tests.length || r.existing.suites.length).length,
    withProposal: results.filter((r) => r.proposed.length).length,
    withoutProposal: results.filter((r) => !r.proposed.length).length,
    broad: results.filter((r) => r.broad).length,
  };

  if (opts.json) {
    io.out(`${JSON.stringify({ summary, targets: results }, null, 2)}\n`);
    return;
  }

  const lines = [
    `Project: ${summary.projectRoot}`,
    `Package directories: ${summary.packageDirectories.join(', ') || '(none)'}`,
    `Test classes: ${summary.testClasses} | targets: ${summary.targets} | already annotated: ${summary.alreadyAnnotated} | ` +
      `with proposal: ${summary.withProposal} | no proposal: ${summary.withoutProposal} | broad (>${opts.maxTests}): ${summary.broad}`,
    `Coverage data: ${summary.coverageUsed ? 'yes' : 'no (static analysis only)'}`,
    '',
    'Sources: coverage = covered in org | name = naming convention | handler = tests of a class the trigger calls | reference = test code names the class',
    '',
    ...results.flatMap((r) => formatTarget(r, opts.maxTests)),
  ];
  io.out(`${lines.join('\n')}\n`);
}
