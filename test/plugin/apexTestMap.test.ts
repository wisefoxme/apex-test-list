import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/map/cli.js';

type RunResult = { status: number | null; stdout: string; stderr: string };

let project: string;
let classes: string;
let triggers: string;

async function runRaw(args: string[]): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  const status = await main(args, {
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
  });
  return { status, stdout, stderr };
}

function run(...args: string[]): Promise<RunResult> {
  return runRaw([...args, '--project', project]);
}

async function runJson<T>(...args: string[]): Promise<T> {
  const result = await run(...args, '--json');
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

  write(
    join(classes, 'AccountService.cls'),
    'public class AccountService {\r\n  public static void (await run()) {}\r\n}\r\n',
  );
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
  it('proposes tests from names, references, and trigger handlers, ignoring comments and strings', async () => {
    const output = await runJson<ScanOutput>('scan');
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

  it('ranks coverage first and reports tests that exist only in the org', async () => {
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
    const output = await runJson<ScanOutput>('scan', '--coverage', coverage);
    expect(output.summary.coverageUsed).toBe(true);
    const service = target(output, 'AccountService');
    expect(service.proposed[0]).toEqual({ test: 'OrgOnlyTest', sources: ['coverage'] });
    expect(service.missingLocally).toEqual(['OrgOnlyTest']);
    const trigger = target(output, 'AccountTrigger', 'trigger');
    expect(trigger.proposed[0]).toEqual({ test: 'OtherDmlTest', sources: ['coverage'] });
    expect(trigger.dmlCandidates?.count).toBe(0);
  });

  it('filters with --missing-only, --only, and --ignore-package-directory', async () => {
    expect((await runJson<ScanOutput>('scan', '--missing-only')).targets.map((t) => t.name)).not.toContain(
      'AccountUtil',
    );
    expect((await runJson<ScanOutput>('scan', '--only', 'orphan, AccountService')).targets.map((t) => t.name)).toEqual([
      'AccountService',
      'Orphan',
    ]);
    expect((await runJson<ScanOutput>('scan')).targets.map((t) => t.name)).toContain('VendorThing');
    expect(
      (await runJson<ScanOutput>('scan', '--ignore-package-directory', 'vendor')).targets.map((t) => t.name),
    ).not.toContain('VendorThing');
  });

  it('flags broad proposals and prints a text report', async () => {
    expect(target(await runJson<ScanOutput>('scan', '--max-tests', '1'), 'AccountService').broad).toBe(false);
    write(join(classes, 'ExtraTest.cls'), '@isTest class ExtraTest { void t() { AccountService.run(); } }\n');
    expect(target(await runJson<ScanOutput>('scan', '--max-tests', '1'), 'AccountService').broad).toBe(true);

    const text = await run('scan');
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('AccountServiceTest[reference,name]');
    expect(text.stdout).toContain('DML on Account (fires trigger, not proposed): OtherDmlTest');
  });
});

describe('apex-test-map apply', () => {
  it('adds and merges annotations, keeps line endings, and is idempotent', async () => {
    const plan = join(project, 'plan.json');
    write(
      plan,
      JSON.stringify({
        AccountService: ['AccountServiceTest'],
        'trigger:AccountTrigger': ['AccountTriggerHandlerTest', 'OtherDmlTest'],
        AccountUtil: { tests: ['accountservicetest', 'AccountTriggerHandlerTest'] },
      }),
    );

    const dry = await run('apply', '--plan', plan, '--dry-run');
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('3 file(s) would change');
    expect(readFileSync(join(classes, 'AccountService.cls'), 'utf8')).not.toContain('@Tests');

    expect((await run('apply', '--plan', plan)).status).toBe(0);
    expect(readFileSync(join(classes, 'AccountService.cls'), 'utf8')).toBe(
      '// @Tests: AccountServiceTest\r\npublic class AccountService {\r\n  public static void (await run()) {}\r\n}\r\n',
    );
    expect(readFileSync(join(classes, 'AccountUtil.cls'), 'utf8')).toBe(
      '// @Tests: AccountServiceTest, AccountTriggerHandlerTest\npublic class AccountUtil {}\n',
    );
    expect(readFileSync(join(triggers, 'AccountTrigger.trigger'), 'utf8')).toMatch(
      /^\/\/ @Tests: AccountTriggerHandlerTest, OtherDmlTest\ntrigger AccountTrigger/,
    );

    const again = await run('apply', '--plan', plan);
    expect(again.stdout).toContain('0 file(s) changed, 3 unchanged');
  });

  it('writes suites and merges into an existing annotation line with CRLF', async () => {
    write(join(classes, 'Crlf.cls'), '// @Tests: AccountServiceTest\r\npublic class Crlf {}\r\n');
    write(
      join(project, 'force-app', 'main', 'default', 'testSuites', 'Sales.testSuite-meta.xml'),
      '<ApexTestSuite><testClassName>OtherDmlTest</testClassName></ApexTestSuite>',
    );
    const plan = join(project, 'plan.json');
    write(plan, JSON.stringify({ Crlf: { tests: ['OtherDmlTest'], suites: ['Sales'] } }));
    expect((await run('apply', '--plan', plan)).status).toBe(0);
    expect(readFileSync(join(classes, 'Crlf.cls'), 'utf8')).toBe(
      '// @Tests: AccountServiceTest, OtherDmlTest\r\n// @TestSuites: Sales\r\npublic class Crlf {}\r\n',
    );
  });

  it('rejects the whole plan when any entry is invalid', async () => {
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
    const result = await run('apply', '--plan', plan);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Orphan: not found locally: NoSuchTest');
    expect(result.stderr).toContain('AccountServiceTest: is a test class');
    expect(result.stderr).toContain('Missing: no class or trigger with that name');
    expect(result.stderr).toContain('AccountTriggerHandler: invalid names bad name!');
    expect(readFileSync(join(classes, 'AccountService.cls'), 'utf8')).not.toContain('@Tests');

    write(plan, JSON.stringify({ Orphan: ['OrgOnlyTest'] }));
    expect((await run('apply', '--plan', plan, '--allow-unknown')).status).toBe(0);
    expect(readFileSync(join(classes, 'Orphan.cls'), 'utf8')).toContain('// @Tests: OrgOnlyTest');
  });

  it('asks for a prefix when a class and a trigger share a name', async () => {
    write(join(triggers, 'AccountService.trigger'), 'trigger AccountService on Account (after insert) {}\n');
    const plan = join(project, 'plan.json');
    write(plan, JSON.stringify({ AccountService: ['AccountServiceTest'] }));
    const result = await run('apply', '--plan', plan);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('prefix the key with "class:" or "trigger:"');
    write(plan, JSON.stringify({ 'class:AccountService': ['AccountServiceTest'] }));
    expect((await run('apply', '--plan', plan)).status).toBe(0);
  });
});

describe('apex-test-map header template', () => {
  const TEMPLATE = [
    '/**',
    ' * @description TODO describe {{name}}',
    ' * @Tests: {{tests}}',
    ' * @TestSuites: {{suites}}',
    ' */',
    '',
  ].join('\n');

  function setup(template = TEMPLATE): { plan: string; templateFile: string } {
    const templateFile = join(project, 'header.txt');
    write(templateFile, template);
    write(
      join(project, 'force-app', 'main', 'default', 'testSuites', 'Sales.testSuite-meta.xml'),
      '<ApexTestSuite><testClassName>OtherDmlTest</testClassName></ApexTestSuite>',
    );
    return { plan: join(project, 'plan.json'), templateFile };
  }

  it('adds the template to files without a header, leaving out empty annotation lines', async () => {
    const { plan, templateFile } = setup();
    write(plan, JSON.stringify({ AccountService: ['AccountServiceTest'] }));
    expect((await run('apply', '--plan', plan, '--header-template', templateFile)).status).toBe(0);
    expect(readFileSync(join(classes, 'AccountService.cls'), 'utf8')).toBe(
      '/**\r\n * @description TODO describe AccountService\r\n * @Tests: AccountServiceTest\r\n */\r\n' +
        'public class AccountService {\r\n  public static void (await run()) {}\r\n}\r\n',
    );
    const scanned = await runJson<ScanOutput>('scan', '--only', 'AccountService');
    expect(target(scanned, 'AccountService').existing).toEqual({ tests: ['AccountServiceTest'], suites: [] });
  });

  it('adds lines inside an existing header without rewriting it', async () => {
    const { plan, templateFile } = setup();
    write(
      join(classes, 'Orphan.cls'),
      '/**\n  * @author Someone\n  * @description Keeps going\n  */\npublic class Orphan {}\n',
    );
    write(
      join(classes, 'AccountTriggerHandler.cls'),
      '// Copyright Acme\n// Handler\npublic class AccountTriggerHandler { public void go() {} }\n',
    );
    write(
      plan,
      JSON.stringify({
        Orphan: { tests: ['OtherDmlTest'], suites: ['Sales'] },
        AccountTriggerHandler: ['AccountTriggerHandlerTest'],
      }),
    );
    expect((await run('apply', '--plan', plan, '--header-template', templateFile)).status).toBe(0);
    expect(readFileSync(join(classes, 'Orphan.cls'), 'utf8')).toBe(
      '/**\n  * @author Someone\n  * @description Keeps going\n  * @Tests: OtherDmlTest\n  * @TestSuites: Sales\n  */\npublic class Orphan {}\n',
    );
    expect(readFileSync(join(classes, 'AccountTriggerHandler.cls'), 'utf8')).toBe(
      '// Copyright Acme\n// Handler\n// @Tests: AccountTriggerHandlerTest\npublic class AccountTriggerHandler { public void go() {} }\n',
    );
  });

  it('merges into existing annotations and puts a new one next to them', async () => {
    const { plan, templateFile } = setup();
    write(
      join(classes, 'Orphan.cls'),
      '/**\n * @Tests: AccountServiceTest\n * @since 1.0\n */\npublic class Orphan {}\n',
    );
    write(plan, JSON.stringify({ Orphan: { tests: ['OtherDmlTest'], suites: ['Sales'] } }));
    expect((await run('apply', '--plan', plan, '--header-template', templateFile)).status).toBe(0);
    expect(readFileSync(join(classes, 'Orphan.cls'), 'utf8')).toBe(
      '/**\n * @Tests: AccountServiceTest, OtherDmlTest\n * @TestSuites: Sales\n * @since 1.0\n */\npublic class Orphan {}\n',
    );
  });

  it('falls back to a // line when the header has no room for a new line', async () => {
    const { plan, templateFile } = setup();
    write(join(classes, 'Orphan.cls'), '/** Orphan class */\npublic class Orphan {}\n');
    write(plan, JSON.stringify({ Orphan: ['OtherDmlTest'] }));
    expect((await run('apply', '--plan', plan, '--header-template', templateFile)).status).toBe(0);
    expect(readFileSync(join(classes, 'Orphan.cls'), 'utf8')).toBe(
      '// @Tests: OtherDmlTest\n/** Orphan class */\npublic class Orphan {}\n',
    );
  });

  it('rejects templates apextestlist would misread', async () => {
    const { plan, templateFile } = setup('/** @Tests: {{tests}} */\npublic class X {}\n * {{author}}\n');
    write(plan, JSON.stringify({ Orphan: ['OtherDmlTest'] }));
    const result = await run('apply', '--plan', plan, '--header-template', templateFile);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('line 2 is not a comment line');
    expect(result.stderr).toContain('unknown placeholder {{author}}');
    expect(result.stderr).toContain('must end with "@Tests: {{tests}}"');
    expect(result.stderr).toContain('text follows the closing */');

    write(templateFile, '// header only\n');
    expect((await run('apply', '--plan', plan, '--header-template', templateFile)).stderr).toContain(
      'it needs a "@Tests: {{tests}}" line',
    );
    expect(readFileSync(join(classes, 'Orphan.cls'), 'utf8')).toBe('public class Orphan {}\n');
  });

  it('audits annotations against the template style', async () => {
    const { templateFile } = setup();
    write(join(classes, 'Orphan.cls'), '/**\n * @Tests: OtherDmlTest\n */\npublic class Orphan {}\n');
    write(join(classes, 'AccountService.cls'), '// @Tests: AccountServiceTest\npublic class AccountService {}\n');
    write(
      join(classes, 'AccountTriggerHandler.cls'),
      '/** Handler */\n// @Tests: AccountTriggerHandlerTest\npublic class AccountTriggerHandler {}\n',
    );
    write(
      join(triggers, 'AccountTrigger.trigger'),
      'trigger AccountTrigger on Account (before insert) {} // @Tests: OtherDmlTest\n',
    );
    const output = await runJson<{ headerProblems: Array<{ file: string; issue: string }> }>(
      'audit',
      '--header-template',
      templateFile,
    );
    expect(output.headerProblems).toEqual([
      {
        file: 'force-app/main/default/classes/AccountService.cls',
        issue: 'header is a line comment; the template uses a block comment',
      },
      {
        file: 'force-app/main/default/classes/AccountTriggerHandler.cls',
        issue: 'annotation is outside the leading header',
      },
      {
        file: 'force-app/main/default/classes/AccountUtil.cls',
        issue: 'header is a line comment; the template uses a block comment',
      },
      { file: 'force-app/main/default/triggers/AccountTrigger.trigger', issue: 'no leading header comment' },
    ]);
    expect((await runJson<{ headerProblems: null }>('audit')).headerProblems).toBeNull();
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

  it('reports unannotated classes, bad names, suites, and test dependency problems', async () => {
    write(join(classes, 'Bad.cls'), '// @Tests: Ghost, Orphan\n// @TestSuites: NoSuite\npublic class Bad {}\n');
    write(
      join(project, 'force-app', 'main', 'default', 'testSuites', 'S.testSuite-meta.xml'),
      '<ApexTestSuite><testClassName>Account*Test</testClassName><testClassName>NS.Nope</testClassName></ApexTestSuite>',
    );
    write(
      join(project, '.test-dependencies.yml'),
      '# comment\nAccountServiceTest:\n  - CustomField:Account.Industry\n  - not valid\nGhostTest:\n  - Flow:X\n',
    );
    const output = await runJson<AuditOutput>('audit', '--max-tests', '1');
    expect(output.unannotated).toContain('force-app/main/default/classes/Orphan.cls');
    expect(output.unannotated).not.toContain('force-app/main/default/classes/AccountUtil.cls');
    expect(output.unknownTests.map((x) => x.name)).toEqual(['Ghost']);
    expect(output.notTests.map((x) => x.name)).toEqual(['Orphan']);
    expect(output.unknownSuites.map((x) => x.name)).toEqual(['NoSuite']);
    expect(output.suiteProblems.map((x) => x.name)).toEqual(['NS.Nope']);
    expect(output.broad).toEqual([{ file: 'force-app/main/default/classes/Bad.cls', count: 2 }]);
    expect(output.testDependencies?.tests).toBe(2);
    expect(output.testDependencies?.problems).toEqual([
      '"AccountServiceTest": "not valid" is not Type:Member',
      '"GhostTest" is not a local @isTest class',
    ]);
    expect(output.coverageGaps).toEqual([]);
  });

  it('compares annotations with org coverage, counting suite members as selected', async () => {
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
    const output = await runJson<AuditOutput>('audit', '--coverage', coverage);
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

    const text = await run('audit', '--coverage', coverage);
    expect(text.stdout).toContain(
      'AccountUtil.cls: covering tests not annotated: AccountTriggerHandlerTest; annotated but no coverage: AccountServiceTest',
    );
  });
});

describe('apex-test-map usage', () => {
  it('prints help and rejects bad input', async () => {
    expect((await runRaw(['--help'])).stdout).toContain('Usage:');
    expect((await run('nope')).status).toBe(2);
    expect((await run('scan', '--bogus')).stderr).toContain('Unknown option: --bogus');
    expect((await run('scan', '--max-tests', '0')).status).toBe(2);
    expect((await run('apply')).stderr).toContain('apply needs --plan');
    expect((await run('scan', '--coverage', join(project, 'missing.json'))).stderr).toContain(
      'Cannot read coverage file',
    );
  });
});

describe('apex-test-map list', () => {
  type ListOutput = { tests: string[]; command: string; warnings: string[] };

  it('lists the tests apextestlist selects, for the whole project or a manifest', async () => {
    const all = await runJson<ListOutput>('list');
    expect(all.tests).toEqual(['AccountServiceTest', 'AccountTriggerHandlerTest', 'OtherDmlTest']);
    expect(all.command).toBe('--tests AccountServiceTest --tests AccountTriggerHandlerTest --tests OtherDmlTest');

    const manifest = join(project, 'package.xml');
    write(
      manifest,
      '<Package><types><members>AccountUtil</members><name>ApexClass</name></types><version>62.0</version></Package>',
    );
    const changed = await runJson<ListOutput>('list', '--manifest', manifest);
    expect(changed.tests).toEqual(['AccountServiceTest']);

    const text = await run('list', '--manifest', manifest);
    expect(text.stdout).toContain('Tests (1): AccountServiceTest');
    expect(text.stdout).toContain('Deploy flags: --tests AccountServiceTest');
  });

  it('reports warnings and drops missing tests on request', async () => {
    write(join(classes, 'Ghosted.cls'), '// @Tests: GhostTest\npublic class Ghosted {}\n');
    const manifest = join(project, 'package.xml');
    write(manifest, '<Package><types><members>Ghosted</members><name>ApexClass</name></types></Package>');
    const kept = await runJson<ListOutput>('list', '--manifest', manifest);
    expect(kept.tests).toEqual(['GhostTest']);
    const dropped = await run('list', '--manifest', manifest, '--ignore-missing-tests');
    expect(dropped.stdout).toContain('Tests (0): -');
    expect(dropped.stdout).toMatch(/Warnings \(\d+\):/);
  });

  it('needs a manifest to filter by metadata, and reports project errors', async () => {
    expect((await run('list', '--filter-by-metadata')).stderr).toContain('--filter-by-metadata needs --manifest');
    const empty = mkdtempSync(join(tmpdir(), 'apex-test-map-empty-'));
    try {
      const result = await runRaw(['list', '--project', empty]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Cannot list tests');
      expect((await runRaw(['scan', '--project', empty])).stderr).toContain('Cannot read the Salesforce DX project');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('apex-test-map audit edge cases', () => {
  it('reports unreadable suites and a .test-dependencies.yml apextestlist would reject', async () => {
    write(
      join(project, 'force-app', 'main', 'default', 'testSuites', 'Broken.testSuite-meta.xml'),
      '<NotASuite></NotASuite>',
    );
    write(join(project, '.test-dependencies.yml'), 'AccountServiceTest: Flow:Single\n');
    const output = await runJson<{
      suiteProblems: Array<{ name: string }>;
      testDependencies: { problems: string[] };
    }>('audit');
    expect(output.suiteProblems[0].name).toContain('cannot read the suite');
    expect(output.testDependencies.problems).toEqual([
      '"AccountServiceTest" must list Type:Member entries; apextestlist rejects the file otherwise',
    ]);
  });
});

describe('package exports', () => {
  it('exposes listTests and apex-test-map for programmatic use', async () => {
    const api = await import('../../src/index.js');
    expect(typeof api.listTests).toBe('function');
    expect(api.apexTestMap).toBe(main);
    const result = await api.listTests({ format: 'csv', projectDir: project });
    expect(result.command).toBe('AccountServiceTest,AccountTriggerHandlerTest,OtherDmlTest');
  });
});
