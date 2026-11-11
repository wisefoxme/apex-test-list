import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('bin/apex-test-map.mjs');

type RunResult = { status: number | null; stdout: string; stderr: string };

let project: string;
let classes: string;
let triggers: string;

function run(...args: string[]): RunResult {
  const result = spawnSync(process.execPath, [SCRIPT, ...args, '--project', project], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runJson<T>(...args: string[]): T {
  const result = run(...args, '--json');
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as T;
}

function write(path: string, content: string): void {
  writeFileSync(path, content, 'utf8');
}

type ScanTarget = {
  name: string;
  kind: string;
  existing: { tests: string[]; suites: string[] };
  proposed: Array<{ test: string; sources: string[] }>;
  handlers?: string[];
  dmlCandidates?: { count: number; sample: string[] };
  missingLocally: string[];
  broad: boolean;
};
type ScanOutput = { summary: { coverageUsed: boolean; testClasses: number }; targets: ScanTarget[] };

function target(output: ScanOutput, name: string, kind = 'class'): ScanTarget {
  const found = output.targets.find((t) => t.name === name && t.kind === kind);
  expect(found, `${kind} ${name}`).toBeDefined();
  return found as ScanTarget;
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'apex-test-map-'));
  classes = join(project, 'force-app', 'main', 'default', 'classes');
  triggers = join(project, 'force-app', 'main', 'default', 'triggers');
  mkdirSync(classes, { recursive: true });
  mkdirSync(triggers, { recursive: true });
  mkdirSync(join(project, 'force-app', 'main', 'default', 'testSuites'), { recursive: true });
  mkdirSync(join(project, 'vendor', 'classes'), { recursive: true });
  write(
    join(project, 'sfdx-project.json'),
    JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }, { path: 'vendor' }] }),
  );

  write(join(classes, 'AccountService.cls'), 'public class AccountService {\r\n  public static void run() {}\r\n}\r\n');
  write(join(classes, 'AccountUtil.cls'), '// @Tests: AccountServiceTest\npublic class AccountUtil {}\n');
  write(join(classes, 'AccountTriggerHandler.cls'), 'public class AccountTriggerHandler { public void go() {} }\n');
  write(join(classes, 'Orphan.cls'), 'public class Orphan {}\n');
  write(
    join(triggers, 'AccountTrigger.trigger'),
    'trigger AccountTrigger on Account (before insert) { new AccountTriggerHandler().go(); }\n',
  );
  write(
    join(classes, 'AccountServiceTest.cls'),
    "@isTest\nprivate class AccountServiceTest {\n  // Orphan is only mentioned in a comment\n  @isTest static void t() { AccountService.run(); String s = 'AccountTriggerHandler'; }\n}\n",
  );
  write(
    join(classes, 'AccountTriggerHandlerTest.cls'),
    "@IsTest\nclass AccountTriggerHandlerTest { @isTest static void t() { insert new Account(Name = 'x'); new AccountTriggerHandler().go(); } }\n",
  );
  write(
    join(classes, 'OtherDmlTest.cls'),
    '@isTest class OtherDmlTest { @isTest static void t() { insert new Account(); } }\n',
  );
  write(join(project, 'vendor', 'classes', 'VendorThing.cls'), 'public class VendorThing {}\n');
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe('apex-test-map scan', () => {
  it('proposes tests from names, references, and trigger handlers, ignoring comments and strings', () => {
    const output = runJson<ScanOutput>('scan');
    expect(output.summary.testClasses).toBe(3);
    expect(output.summary.coverageUsed).toBe(false);

    expect(target(output, 'AccountService').proposed).toEqual([
      { test: 'AccountServiceTest', sources: ['reference', 'name'] },
    ]);
    expect(target(output, 'Orphan').proposed).toEqual([]);
    expect(target(output, 'AccountTriggerHandler').proposed.map((p) => p.test)).toEqual(['AccountTriggerHandlerTest']);
    expect(target(output, 'AccountUtil').existing.tests).toEqual(['AccountServiceTest']);

    const trigger = target(output, 'AccountTrigger', 'trigger');
    expect(trigger.handlers).toEqual(['AccountTriggerHandler']);
    expect(trigger.proposed).toEqual([{ test: 'AccountTriggerHandlerTest', sources: ['handler'] }]);
    expect(trigger.dmlCandidates).toEqual({ count: 1, sample: ['OtherDmlTest'] });
  });

  it('ranks coverage first and reports tests that exist only in the org', () => {
    const coverage = join(project, 'coverage.json');
    write(
      coverage,
      JSON.stringify({
        result: {
          records: [
            { ApexTestClass: { Name: 'OrgOnlyTest' }, ApexClassOrTrigger: { Name: 'AccountService' } },
            { ApexTestClass: { Name: 'othERdmltest' }, ApexClassOrTrigger: { Name: 'AccountTrigger' } },
          ],
        },
      }),
    );
    const output = runJson<ScanOutput>('scan', '--coverage', coverage);
    expect(output.summary.coverageUsed).toBe(true);
    const service = target(output, 'AccountService');
    expect(service.proposed[0]).toEqual({ test: 'OrgOnlyTest', sources: ['coverage'] });
    expect(service.missingLocally).toEqual(['OrgOnlyTest']);
    const trigger = target(output, 'AccountTrigger', 'trigger');
    expect(trigger.proposed[0]).toEqual({ test: 'OtherDmlTest', sources: ['coverage'] });
    expect(trigger.dmlCandidates?.count).toBe(0);
  });

  it('filters with --missing-only, --only, and --ignore-package-directory', () => {
    expect(runJson<ScanOutput>('scan', '--missing-only').targets.map((t) => t.name)).not.toContain('AccountUtil');
    expect(runJson<ScanOutput>('scan', '--only', 'orphan, AccountService').targets.map((t) => t.name)).toEqual([
      'AccountService',
      'Orphan',
    ]);
    expect(runJson<ScanOutput>('scan').targets.map((t) => t.name)).toContain('VendorThing');
    expect(
      runJson<ScanOutput>('scan', '--ignore-package-directory', 'vendor').targets.map((t) => t.name),
    ).not.toContain('VendorThing');
  });

  it('flags broad proposals and prints a text report', () => {
    expect(target(runJson<ScanOutput>('scan', '--max-tests', '1'), 'AccountService').broad).toBe(false);
    write(join(classes, 'ExtraTest.cls'), '@isTest class ExtraTest { void t() { AccountService.run(); } }\n');
    expect(target(runJson<ScanOutput>('scan', '--max-tests', '1'), 'AccountService').broad).toBe(true);

    const text = run('scan');
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('AccountServiceTest[reference,name]');
    expect(text.stdout).toContain('DML on Account (fires trigger, not proposed): OtherDmlTest');
  });
});

describe('apex-test-map apply', () => {
  it('adds and merges annotations, keeps line endings, and is idempotent', () => {
    const plan = join(project, 'plan.json');
    write(
      plan,
      JSON.stringify({
        AccountService: ['AccountServiceTest'],
        'trigger:AccountTrigger': ['AccountTriggerHandlerTest', 'OtherDmlTest'],
        AccountUtil: { tests: ['accountservicetest', 'AccountTriggerHandlerTest'] },
      }),
    );

    const dry = run('apply', '--plan', plan, '--dry-run');
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('3 file(s) would change');
    expect(readFileSync(join(classes, 'AccountService.cls'), 'utf8')).not.toContain('@Tests');

    expect(run('apply', '--plan', plan).status).toBe(0);
    expect(readFileSync(join(classes, 'AccountService.cls'), 'utf8')).toBe(
      '// @Tests: AccountServiceTest\r\npublic class AccountService {\r\n  public static void run() {}\r\n}\r\n',
    );
    expect(readFileSync(join(classes, 'AccountUtil.cls'), 'utf8')).toBe(
      '// @Tests: AccountServiceTest, AccountTriggerHandlerTest\npublic class AccountUtil {}\n',
    );
    expect(readFileSync(join(triggers, 'AccountTrigger.trigger'), 'utf8')).toMatch(
      /^\/\/ @Tests: AccountTriggerHandlerTest, OtherDmlTest\ntrigger AccountTrigger/,
    );

    const again = run('apply', '--plan', plan);
    expect(again.stdout).toContain('0 file(s) changed, 3 unchanged');
  });

  it('writes suites and merges into an existing annotation line with CRLF', () => {
    write(join(classes, 'Crlf.cls'), '// @Tests: AccountServiceTest\r\npublic class Crlf {}\r\n');
    write(
      join(project, 'force-app', 'main', 'default', 'testSuites', 'Sales.testSuite-meta.xml'),
      '<ApexTestSuite><testClassName>OtherDmlTest</testClassName></ApexTestSuite>',
    );
    const plan = join(project, 'plan.json');
    write(plan, JSON.stringify({ Crlf: { tests: ['OtherDmlTest'], suites: ['Sales'] } }));
    expect(run('apply', '--plan', plan).status).toBe(0);
    expect(readFileSync(join(classes, 'Crlf.cls'), 'utf8')).toBe(
      '// @TestSuites: Sales\r\n// @Tests: AccountServiceTest, OtherDmlTest\r\npublic class Crlf {}\r\n',
    );
  });

  it('rejects the whole plan when any entry is invalid', () => {
    const plan = join(project, 'plan.json');
    write(
      plan,
      JSON.stringify({
        AccountService: ['AccountServiceTest'],
        Orphan: ['NoSuchTest'],
        AccountServiceTest: ['OtherDmlTest'],
        Missing: ['AccountServiceTest'],
        AccountTriggerHandler: ['bad name!'],
      }),
    );
    const result = run('apply', '--plan', plan);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Orphan: not found locally: NoSuchTest');
    expect(result.stderr).toContain('AccountServiceTest: is a test class');
    expect(result.stderr).toContain('Missing: no class or trigger with that name');
    expect(result.stderr).toContain('AccountTriggerHandler: invalid names bad name!');
    expect(readFileSync(join(classes, 'AccountService.cls'), 'utf8')).not.toContain('@Tests');

    write(plan, JSON.stringify({ Orphan: ['OrgOnlyTest'] }));
    expect(run('apply', '--plan', plan, '--allow-unknown').status).toBe(0);
    expect(readFileSync(join(classes, 'Orphan.cls'), 'utf8')).toContain('// @Tests: OrgOnlyTest');
  });

  it('asks for a prefix when a class and a trigger share a name', () => {
    write(join(triggers, 'AccountService.trigger'), 'trigger AccountService on Account (after insert) {}\n');
    const plan = join(project, 'plan.json');
    write(plan, JSON.stringify({ AccountService: ['AccountServiceTest'] }));
    const result = run('apply', '--plan', plan);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('prefix the key with "class:" or "trigger:"');
    write(plan, JSON.stringify({ 'class:AccountService': ['AccountServiceTest'] }));
    expect(run('apply', '--plan', plan).status).toBe(0);
  });
});

describe('apex-test-map audit', () => {
  type AuditOutput = {
    unannotated: string[];
    unknownTests: Array<{ name: string }>;
    notTests: Array<{ name: string }>;
    unknownSuites: Array<{ name: string }>;
    suiteProblems: Array<{ name: string }>;
    broad: Array<{ count: number }>;
    coverageGaps: Array<{ file: string; missing?: string[]; stale?: string[]; issue?: string }>;
    testDependencies: { tests: number; problems: string[] } | null;
  };

  it('reports unannotated classes, bad names, suites, and test dependency problems', () => {
    write(join(classes, 'Bad.cls'), '// @Tests: Ghost, Orphan\n// @TestSuites: NoSuite\npublic class Bad {}\n');
    write(
      join(project, 'force-app', 'main', 'default', 'testSuites', 'S.testSuite-meta.xml'),
      '<ApexTestSuite><testClassName>Account*Test</testClassName><testClassName>NS.Nope</testClassName></ApexTestSuite>',
    );
    write(
      join(project, '.test-dependencies.yml'),
      '# comment\nAccountServiceTest:\n  - CustomField:Account.Industry\n  - not valid\nGhostTest:\n  - Flow:X\n',
    );
    const output = runJson<AuditOutput>('audit', '--max-tests', '1');
    expect(output.unannotated).toContain('force-app/main/default/classes/Orphan.cls');
    expect(output.unannotated).not.toContain('force-app/main/default/classes/AccountUtil.cls');
    expect(output.unknownTests.map((x) => x.name)).toEqual(['Ghost']);
    expect(output.notTests.map((x) => x.name)).toEqual(['Orphan']);
    expect(output.unknownSuites.map((x) => x.name)).toEqual(['NoSuite']);
    expect(output.suiteProblems.map((x) => x.name)).toEqual(['NS.Nope']);
    expect(output.broad).toEqual([{ file: 'force-app/main/default/classes/Bad.cls', count: 2 }]);
    expect(output.testDependencies?.tests).toBe(2);
    expect(output.testDependencies?.problems).toEqual([
      'line 4: "not valid" is not Type:Member',
      '"GhostTest" is not a local @isTest class',
    ]);
    expect(output.coverageGaps).toEqual([]);
  });

  it('compares annotations with org coverage, counting suite members as selected', () => {
    write(join(classes, 'Suited.cls'), '// @TestSuites: Sales\npublic class Suited {}\n');
    write(
      join(project, 'force-app', 'main', 'default', 'testSuites', 'Sales.testSuite-meta.xml'),
      '<ApexTestSuite><testClassName>Other*Test</testClassName></ApexTestSuite>',
    );
    const coverage = join(project, 'coverage.json');
    write(
      coverage,
      JSON.stringify({
        records: [
          { ApexTestClass: { Name: 'AccountTriggerHandlerTest' }, ApexClassOrTrigger: { Name: 'AccountUtil' } },
          { ApexTestClass: { Name: 'OtherDmlTest' }, ApexClassOrTrigger: { Name: 'Suited' } },
        ],
      }),
    );
    write(join(classes, 'NoRows.cls'), '// @Tests: OtherDmlTest\npublic class NoRows {}\n');
    const output = runJson<AuditOutput>('audit', '--coverage', coverage);
    expect(output.coverageGaps).toEqual([
      {
        file: 'force-app/main/default/classes/AccountUtil.cls',
        missing: ['AccountTriggerHandlerTest'],
        stale: ['AccountServiceTest'],
      },
      {
        file: 'force-app/main/default/classes/NoRows.cls',
        issue: 'no coverage rows in the org data',
        annotated: ['OtherDmlTest'],
        missing: [],
      },
    ]);

    const text = run('audit', '--coverage', coverage);
    expect(text.stdout).toContain(
      'AccountUtil.cls: covering tests not annotated: AccountTriggerHandlerTest; annotated but no coverage: AccountServiceTest',
    );
  });
});

describe('apex-test-map usage', () => {
  it('prints help and rejects bad input', () => {
    expect(spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' }).stdout).toContain('Usage:');
    expect(run('nope').status).toBe(2);
    expect(run('scan', '--bogus').stderr).toContain('Unknown option: --bogus');
    expect(run('scan', '--max-tests', '0').status).toBe(2);
    expect(run('apply').stderr).toContain('apply needs --plan');
    expect(run('scan', '--coverage', join(project, 'missing.json')).stderr).toContain('Cannot read coverage file');
  });
});
