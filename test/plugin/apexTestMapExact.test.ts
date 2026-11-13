import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apply } from '../../src/map/apply.js';
import { main, parseArgs } from '../../src/map/cli.js';
import { findLeadingHeader, isInHeader, mergeExisting } from '../../src/map/header.js';
import { list } from '../../src/map/list.js';
import {
  loadCoverage,
  loadProject,
  normalizePath,
  parseAnnotation,
  stripCommentsAndStrings,
} from '../../src/map/project.js';
import { loadTemplate } from '../../src/map/template.js';
import { MapError } from '../../src/map/types.js';
import { TEST_NAME_REGEX, TEST_SUITE_NAME_REGEX } from '../../src/utils/constants.js';

let root: string;

const DEFAULT = 'force-app/main/default';

function write(path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

async function run(...args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const status = await main([...args, '--project', root], {
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
  });
  // Only the project path varies between runs; JSON output escapes its backslashes.
  const clean = (text: string): string =>
    text.split(JSON.stringify(root).slice(1, -1)).join('<root>').split(root).join('<root>');
  return { status, stdout: clean(stdout), stderr: clean(stderr) };
}

async function json<T>(...args: string[]): Promise<T> {
  const result = await run(...args, '--json');
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as T;
}

/**
 * A project laid out so that sorting, filtering, and every naming convention
 * show up in the output: package directories listed out of order, a nested
 * class folder, -meta.xml files, a class and a trigger with the same name.
 */
function buildProject(): void {
  write(
    'sfdx-project.json',
    JSON.stringify({
      packageDirectories: [
        { path: 'vendor' },
        { path: './force-app/' },
        { path: 'vendor/' },
        { path: 'extra/./pkg//' },
      ],
    }),
  );
  write('vendor/classes/Vendor.cls', 'public class Vendor {}\n');
  write('extra/pkg/classes/Extra.cls', '// @Tests: AlphaTest, MentionTest\npublic class Extra {}\n');
  write(`${DEFAULT}/classes/Alpha.cls`, '// @Tests: AlphaTest\npublic class Alpha {}\n');
  write(`${DEFAULT}/classes/Alpha.cls-meta.xml`, '<ApexClass/>\n');
  write(`${DEFAULT}/classes/Beta.cls`, 'public class Beta {}\n');
  write(
    `${DEFAULT}/classes/Gamma.cls`,
    '// @Tests: AlphaTest\n// @TestSuites: Suite1, Suite2\npublic class Gamma {}\n',
  );
  write(`${DEFAULT}/classes/sub/Deep.cls`, 'public class Deep {}\n');
  write(`${DEFAULT}/classes/AlphaTest.cls`, '@isTest class AlphaTest { void t() { new Alpha(); } }\n');
  for (const name of ['BetaTest', 'Beta_Test', 'BetaTests', 'Beta_Tests', 'TestBeta', 'Test_Beta']) {
    write(`${DEFAULT}/classes/${name}.cls`, `@isTest class ${name} {}\n`);
  }
  write(`${DEFAULT}/classes/ZRefTest.cls`, '@isTest class ZRefTest { void t() { new Beta(); } }\n');
  write(`${DEFAULT}/classes/ARefTest.cls`, '@isTest class ARefTest { void t() { new Beta(); } }\n');
  write(`${DEFAULT}/classes/DmlTest.cls`, '@isTest class DmlTest { void t() { Database.insert(new Account()); } }\n');
  write(`${DEFAULT}/classes/MentionTest.cls`, '@isTest class MentionTest { AlphaTrigger t; Beta b; }\n');
  write(
    `${DEFAULT}/triggers/AlphaTrigger.trigger`,
    'trigger  AlphaTrigger  on\n  Account (before insert) { new Alpha(); new Gamma(); }\n',
  );
  write(`${DEFAULT}/triggers/AlphaTrigger.trigger-meta.xml`, '<ApexTrigger/>\n');
  write(`${DEFAULT}/triggers/Beta.trigger`, 'trigger Beta on Contact (after insert) {}\n');
  write(
    `${DEFAULT}/testSuites/Suite1.testSuite-meta.xml`,
    '<ApexTestSuite><testClassName>NS.AlphaTest</testClassName><testClassName>alphatest</testClassName><testClassName>Beta*</testClassName></ApexTestSuite>',
  );
  write(
    `${DEFAULT}/testSuites/Suite2.testSuite-meta.xml`,
    '<ApexTestSuite><testClassName>ZRefTest</testClassName></ApexTestSuite>',
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'apex-test-map-exact-'));
  buildProject();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('scan output', () => {
  it('prints every target with its sources, sorted by name then kind', async () => {
    write(
      'coverage.json',
      JSON.stringify([
        { ApexTestClass: { Name: 'ZRefTest' }, ApexClassOrTrigger: { Name: 'Beta' } },
        { ApexTestClass: { Name: 'OrgOnlyTest' }, ApexClassOrTrigger: { Name: 'Alpha' } },
        { ApexTestClass: { Name: 'OrgOnly2Test' }, ApexClassOrTrigger: { Name: 'Alpha' } },
      ]),
    );
    const plain = (await run('scan', '--max-tests', '6')).stdout;
    expect(plain).toContain('Coverage data: no (static analysis only)\n');
    expect(plain).toContain('Test_Beta[name], TestBeta[name]\n  on Contact; calls: -');
    const { stdout } = await run('scan', '--coverage', join(root, 'coverage.json'), '--max-tests', '8');
    expect(stdout).toMatchInlineSnapshot(`
      "Project: <root>
      Package directories: vendor, force-app, extra/./pkg
      Test classes: 11 | targets: 8 | already annotated: 3 | with proposal: 4 | no proposal: 4 | broad (>8): 1
      Coverage data: yes

      Sources: coverage = covered in org | name = naming convention | handler = tests of a class the trigger calls | reference = test code names the class

      Alpha  (force-app/main/default/classes/Alpha.cls)
        existing: @Tests: AlphaTest
        proposed: OrgOnly2Test[coverage], OrgOnlyTest[coverage], AlphaTest[reference,name]
        not found locally: OrgOnly2Test, OrgOnlyTest
      trigger AlphaTrigger  (force-app/main/default/triggers/AlphaTrigger.trigger)
        existing: -
        proposed: AlphaTest[handler]
        on Account; calls: Alpha, Gamma
        DML on Account (fires trigger, not proposed): DmlTest
      Beta  (force-app/main/default/classes/Beta.cls)
        existing: -
        proposed: ZRefTest[coverage,reference], Beta_Test[name], Beta_Tests[name], BetaTest[name], BetaTests[name], Test_Beta[name], TestBeta[name], ARefTest[reference] +1 more (BROAD)
      trigger Beta  (force-app/main/default/triggers/Beta.trigger)
        existing: -
        proposed: ZRefTest[coverage], Beta_Test[name], Beta_Tests[name], BetaTest[name], BetaTests[name], Test_Beta[name], TestBeta[name]
        on Contact; calls: -
      Deep  (force-app/main/default/classes/sub/Deep.cls)
        existing: -
        proposed: -
      Extra  (extra/pkg/classes/Extra.cls)
        existing: @Tests: AlphaTest, MentionTest
        proposed: -
      Gamma  (force-app/main/default/classes/Gamma.cls)
        existing: @Tests: AlphaTest | @TestSuites: Suite1, Suite2
        proposed: -
      Vendor  (vendor/classes/Vendor.cls)
        existing: -
        proposed: -
      "
    `);
  });

  it('prints the summary and proposals as JSON', async () => {
    expect(await json('scan', '--max-tests', '9')).toMatchInlineSnapshot(`
      {
        "summary": {
          "alreadyAnnotated": 3,
          "broad": 0,
          "coverageUsed": false,
          "packageDirectories": [
            "vendor",
            "force-app",
            "extra/./pkg",
          ],
          "projectRoot": "<root>",
          "targets": 8,
          "testClasses": 11,
          "withProposal": 4,
          "withoutProposal": 4,
        },
        "targets": [
          {
            "broad": false,
            "existing": {
              "suites": [],
              "tests": [
                "AlphaTest",
              ],
            },
            "file": "force-app/main/default/classes/Alpha.cls",
            "kind": "class",
            "missingLocally": [],
            "name": "Alpha",
            "proposed": [
              {
                "sources": [
                  "reference",
                  "name",
                ],
                "test": "AlphaTest",
              },
            ],
          },
          {
            "broad": false,
            "dmlCandidates": {
              "count": 1,
              "sample": [
                "DmlTest",
              ],
            },
            "existing": {
              "suites": [],
              "tests": [],
            },
            "file": "force-app/main/default/triggers/AlphaTrigger.trigger",
            "handlers": [
              "Alpha",
              "Gamma",
            ],
            "kind": "trigger",
            "missingLocally": [],
            "name": "AlphaTrigger",
            "proposed": [
              {
                "sources": [
                  "handler",
                ],
                "test": "AlphaTest",
              },
            ],
            "sObject": "Account",
          },
          {
            "broad": false,
            "existing": {
              "suites": [],
              "tests": [],
            },
            "file": "force-app/main/default/classes/Beta.cls",
            "kind": "class",
            "missingLocally": [],
            "name": "Beta",
            "proposed": [
              {
                "sources": [
                  "name",
                ],
                "test": "Beta_Test",
              },
              {
                "sources": [
                  "name",
                ],
                "test": "Beta_Tests",
              },
              {
                "sources": [
                  "name",
                ],
                "test": "BetaTest",
              },
              {
                "sources": [
                  "name",
                ],
                "test": "BetaTests",
              },
              {
                "sources": [
                  "name",
                ],
                "test": "Test_Beta",
              },
              {
                "sources": [
                  "name",
                ],
                "test": "TestBeta",
              },
              {
                "sources": [
                  "reference",
                ],
                "test": "ARefTest",
              },
              {
                "sources": [
                  "reference",
                ],
                "test": "MentionTest",
              },
              {
                "sources": [
                  "reference",
                ],
                "test": "ZRefTest",
              },
            ],
          },
          {
            "broad": false,
            "dmlCandidates": {
              "count": 0,
              "sample": [],
            },
            "existing": {
              "suites": [],
              "tests": [],
            },
            "file": "force-app/main/default/triggers/Beta.trigger",
            "handlers": [],
            "kind": "trigger",
            "missingLocally": [],
            "name": "Beta",
            "proposed": [
              {
                "sources": [
                  "name",
                ],
                "test": "Beta_Test",
              },
              {
                "sources": [
                  "name",
                ],
                "test": "Beta_Tests",
              },
              {
                "sources": [
                  "name",
                ],
                "test": "BetaTest",
              },
              {
                "sources": [
                  "name",
                ],
                "test": "BetaTests",
              },
              {
                "sources": [
                  "name",
                ],
                "test": "Test_Beta",
              },
              {
                "sources": [
                  "name",
                ],
                "test": "TestBeta",
              },
            ],
            "sObject": "Contact",
          },
          {
            "broad": false,
            "existing": {
              "suites": [],
              "tests": [],
            },
            "file": "force-app/main/default/classes/sub/Deep.cls",
            "kind": "class",
            "missingLocally": [],
            "name": "Deep",
            "proposed": [],
          },
          {
            "broad": false,
            "existing": {
              "suites": [],
              "tests": [
                "AlphaTest",
                "MentionTest",
              ],
            },
            "file": "extra/pkg/classes/Extra.cls",
            "kind": "class",
            "missingLocally": [],
            "name": "Extra",
            "proposed": [],
          },
          {
            "broad": false,
            "existing": {
              "suites": [
                "Suite1",
                "Suite2",
              ],
              "tests": [
                "AlphaTest",
              ],
            },
            "file": "force-app/main/default/classes/Gamma.cls",
            "kind": "class",
            "missingLocally": [],
            "name": "Gamma",
            "proposed": [],
          },
          {
            "broad": false,
            "existing": {
              "suites": [],
              "tests": [],
            },
            "file": "vendor/classes/Vendor.cls",
            "kind": "class",
            "missingLocally": [],
            "name": "Vendor",
            "proposed": [],
          },
        ],
      }
    `);
  });

  it('limits targets with --missing-only and --only', async () => {
    write(`${DEFAULT}/classes/SuitesOnly.cls`, '// @TestSuites: Suite1\npublic class SuitesOnly {}\n');
    const missing = await json<{
      summary: { withProposal: number; withoutProposal: number };
      targets: Array<{ name: string; kind: string }>;
    }>('scan', '--missing-only');
    expect(missing.targets.map((t) => `${t.kind} ${t.name}`)).toEqual([
      'trigger AlphaTrigger',
      'class Beta',
      'trigger Beta',
      'class Deep',
      'class Vendor',
    ]);
    expect(missing.summary).toEqual(expect.objectContaining({ withProposal: 3, withoutProposal: 2 }));
    const only = await json<{ targets: Array<{ name: string }> }>('scan', '--only', 'deep,,GAMMA');
    expect(only.targets.map((t) => t.name)).toEqual(['Deep', 'Gamma']);
  });
});

describe('audit output', () => {
  it('prints every section exactly', async () => {
    write(`${DEFAULT}/classes/Late.cls`, 'public class Late {}\n// @Tests: Ghost, Gamma, AlphaTrigger, OrgOnlyTest\n');
    write(
      `${DEFAULT}/classes/Known.cls`,
      '// @Tests: AlphaTest, BetaTest\n// @TestSuites: suite1, Missing\npublic class Known {}\n',
    );
    write(
      '.test-dependencies.yml',
      'AlphaTest:\n  - Flow:Ok\n  - Flow:Has Space\n  - 1Flow:X\nNotATest:\n  - Flow:X\nMixed:\n  - Flow:A\n  - 5\n',
    );
    write(
      'coverage.json',
      JSON.stringify([
        { ApexTestClass: { Name: 'ZRefTest' }, ApexClassOrTrigger: { Name: 'Alpha' } },
        { ApexTestClass: { Name: 'ARefTest' }, ApexClassOrTrigger: { Name: 'Alpha' } },
        { ApexTestClass: { Name: 'BetaTest' }, ApexClassOrTrigger: { Name: 'Gamma' } },
        { ApexTestClass: { Name: 'AlphaTest' }, ApexClassOrTrigger: { Name: 'Gamma' } },
        { ApexTestClass: { Name: 'OtherTest' }, ApexClassOrTrigger: { Name: 'Known' } },
      ]),
    );
    write('header.txt', '/**\n * @Tests: {{tests}}\n */\n');
    const { stdout } = await run(
      'audit',
      '--coverage',
      join(root, 'coverage.json'),
      '--header-template',
      join(root, 'header.txt'),
      '--max-tests',
      '3',
    );
    expect(stdout).toMatchInlineSnapshot(`
      "Project: <root>
      Classes/triggers: 10 | test classes: 11 | suites: 2 | coverage data: yes

      No @Tests or @TestSuites (no tests run when these change): 5
        force-app/main/default/classes/Beta.cls
        force-app/main/default/classes/sub/Deep.cls
        force-app/main/default/triggers/AlphaTrigger.trigger
        force-app/main/default/triggers/Beta.trigger
        vendor/classes/Vendor.cls
      @Tests names that are not local classes: 3
        force-app/main/default/classes/Late.cls: Ghost
        force-app/main/default/classes/Late.cls: AlphaTrigger
        force-app/main/default/classes/Late.cls: OrgOnlyTest
      @Tests names that are classes without @isTest: 1
        force-app/main/default/classes/Late.cls: Gamma
      @TestSuites names with no local suite: 1
        force-app/main/default/classes/Known.cls: Missing
      Suite entries that match no local test class: 0
      Annotations with more than 3 tests: 1
        force-app/main/default/classes/Late.cls: 4 tests
      Differences from org coverage: 4
        extra/pkg/classes/Extra.cls: no coverage rows in the org data; annotated AlphaTest, MentionTest
        force-app/main/default/classes/Alpha.cls: covering tests not annotated: ARefTest, ZRefTest; annotated but no coverage: AlphaTest
        force-app/main/default/classes/Known.cls: covering tests not annotated: OtherTest; annotated but no coverage: AlphaTest, BetaTest
        force-app/main/default/classes/Late.cls: no coverage rows in the org data; annotated Ghost, Gamma, AlphaTrigger, OrgOnlyTest
      Annotations not in a leading header like the template: 5
        extra/pkg/classes/Extra.cls: header is a line comment; the template uses a block comment
        force-app/main/default/classes/Alpha.cls: header is a line comment; the template uses a block comment
        force-app/main/default/classes/Gamma.cls: header is a line comment; the template uses a block comment
        force-app/main/default/classes/Known.cls: header is a line comment; the template uses a block comment
        force-app/main/default/classes/Late.cls: no leading header comment
      .test-dependencies.yml problems: 5
        "AlphaTest": "Flow:Has Space" is not Type:Member
        "AlphaTest": "1Flow:X" is not Type:Member
        "NotATest" is not a local @isTest class
        "Mixed" must list Type:Member entries; apextestlist rejects the file otherwise
        "Mixed" is not a local @isTest class
      "
    `);
  });

  it('prints the JSON result and the short form without coverage or a template', async () => {
    expect(await json('audit')).toMatchInlineSnapshot(`
      {
        "broad": [],
        "counts": {
          "classesAndTriggers": 8,
          "suites": 2,
          "testClasses": 11,
        },
        "coverageGaps": [],
        "coverageUsed": false,
        "headerProblems": null,
        "notTests": [],
        "projectRoot": "<root>",
        "suiteProblems": [],
        "testDependencies": null,
        "unannotated": [
          "force-app/main/default/classes/Beta.cls",
          "force-app/main/default/classes/sub/Deep.cls",
          "force-app/main/default/triggers/AlphaTrigger.trigger",
          "force-app/main/default/triggers/Beta.trigger",
          "vendor/classes/Vendor.cls",
        ],
        "unknownSuites": [],
        "unknownTests": [],
      }
    `);
    expect((await run('audit')).stdout).toMatchInlineSnapshot(`
      "Project: <root>
      Classes/triggers: 8 | test classes: 11 | suites: 2 | coverage data: no

      No @Tests or @TestSuites (no tests run when these change): 5
        force-app/main/default/classes/Beta.cls
        force-app/main/default/classes/sub/Deep.cls
        force-app/main/default/triggers/AlphaTrigger.trigger
        force-app/main/default/triggers/Beta.trigger
        vendor/classes/Vendor.cls
      @Tests names that are not local classes: 0
      @Tests names that are classes without @isTest: 0
      @TestSuites names with no local suite: 0
      Suite entries that match no local test class: 0
      Annotations with more than 10 tests: 0
      .test-dependencies.yml: not present
      "
    `);
  });

  it('treats an annotation right after a line header as outside it', async () => {
    write(`${DEFAULT}/classes/Edge.cls`, '// header\n@Tests: AlphaTest\npublic class Edge {}\n');
    write('header.txt', '// @Tests: {{tests}}\n');
    const output = await json<{ headerProblems: Array<{ file: string; issue: string }> }>(
      'audit',
      '--header-template',
      join(root, 'header.txt'),
    );
    expect(output.headerProblems).toContainEqual({
      file: `${DEFAULT}/classes/Edge.cls`,
      issue: 'annotation is outside the leading header',
    });
    expect(output.headerProblems).not.toContainEqual(expect.objectContaining({ file: `${DEFAULT}/classes/Alpha.cls` }));
  });
});

describe('apply output', () => {
  it('reports each file exactly, in text and JSON, and for a dry run', async () => {
    write(`${DEFAULT}/classes/Spaced.cls`, '// @Tests: AlphaTest,BetaTest\npublic class Spaced {}\n');
    write(
      'plan.json',
      JSON.stringify({
        ' Alpha ': ['AlphaTest'],
        'class:Beta': [' BetaTest ', '', 'beta_test', 'BetaTest', 'Beta_Test'],
        Gamma: { suites: ['Suite1'] },
        Deep: { tests: ['ARefTest', 'ZRefTest'], suites: [' Suite1 ', '', 'Suite2'] },
        'trigger:Beta': ['BetaTest'],
        Spaced: { suites: ['Suite1'] },
      }),
    );
    const dry = await run('apply', '--plan', join(root, 'plan.json'), '--dry-run');
    expect(dry.stdout).toMatchInlineSnapshot(`
      "unchanged  force-app/main/default/classes/Alpha.cls
      would update  force-app/main/default/classes/Beta.cls  @Tests += BetaTest, Beta_Test
      unchanged  force-app/main/default/classes/Gamma.cls
      would update  force-app/main/default/classes/sub/Deep.cls  @Tests += ARefTest, ZRefTest; @TestSuites += Suite1, Suite2
      would update  force-app/main/default/triggers/Beta.trigger  @Tests += BetaTest
      would update  force-app/main/default/classes/Spaced.cls  @TestSuites += Suite1
      4 file(s) would change, 2 unchanged.
      "
    `);
    expect(read(`${DEFAULT}/classes/Beta.cls`)).toBe('public class Beta {}\n');

    expect(await json('apply', '--plan', join(root, 'plan.json'))).toMatchInlineSnapshot(`
      {
        "dryRun": false,
        "files": [
          {
            "addedSuites": [],
            "addedTests": [],
            "changed": false,
            "file": "force-app/main/default/classes/Alpha.cls",
          },
          {
            "addedSuites": [],
            "addedTests": [
              "BetaTest",
              "Beta_Test",
            ],
            "changed": true,
            "file": "force-app/main/default/classes/Beta.cls",
          },
          {
            "addedSuites": [],
            "addedTests": [],
            "changed": false,
            "file": "force-app/main/default/classes/Gamma.cls",
          },
          {
            "addedSuites": [
              "Suite1",
              "Suite2",
            ],
            "addedTests": [
              "ARefTest",
              "ZRefTest",
            ],
            "changed": true,
            "file": "force-app/main/default/classes/sub/Deep.cls",
          },
          {
            "addedSuites": [],
            "addedTests": [
              "BetaTest",
            ],
            "changed": true,
            "file": "force-app/main/default/triggers/Beta.trigger",
          },
          {
            "addedSuites": [
              "Suite1",
            ],
            "addedTests": [],
            "changed": true,
            "file": "force-app/main/default/classes/Spaced.cls",
          },
        ],
      }
    `);
    expect(read(`${DEFAULT}/classes/Beta.cls`)).toBe('// @Tests: BetaTest, Beta_Test\npublic class Beta {}\n');
    expect(read(`${DEFAULT}/classes/Spaced.cls`)).toBe(
      '// @Tests: AlphaTest,BetaTest\n// @TestSuites: Suite1\npublic class Spaced {}\n',
    );
    expect(read(`${DEFAULT}/classes/Deep.cls`.replace('classes/', 'classes/sub/'))).toBe(
      '// @Tests: ARefTest, ZRefTest\n// @TestSuites: Suite1, Suite2\npublic class Deep {}\n',
    );
    write('plan.json', JSON.stringify({ Vendor: ['NS.Abc', 'ns.x_1'] }));
    expect((await run('apply', '--plan', join(root, 'plan.json'), '--allow-unknown')).stdout).toContain(
      'updated  vendor/classes/Vendor.cls  @Tests += NS.Abc, ns.x_1',
    );
  });

  it('lists every plan problem, with exact messages', async () => {
    write(`${DEFAULT}/classes/AlphaTrigger.cls`, 'public class AlphaTrigger {}\n');
    write(
      'plan.json',
      JSON.stringify({
        'xclass:Alpha': ['AlphaTest'],
        'class:Alpha\nzzz': ['AlphaTest'],
        AlphaTrigger: ['AlphaTest'],
        Alpha: ['1Bad', 'Also Bad', 'NS.1Bad'],
        'class:Beta': ['NopeTest', 'OtherNopeTest'],
        Gamma: { suites: ['NoSuite', 'NoSuite2'] },
      }),
    );
    const result = await run('apply', '--plan', join(root, 'plan.json'));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatchInlineSnapshot(`
      "Plan has problems; no files were changed:
        xclass:Alpha: no class or trigger with that name
        class:Alpha
      zzz: no class or trigger with that name
        AlphaTrigger: matches force-app/main/default/classes/AlphaTrigger.cls and force-app/main/default/triggers/AlphaTrigger.trigger; prefix the key with "class:" or "trigger:"
        Alpha: invalid names 1Bad, Also Bad, NS.1Bad
        class:Beta: not found locally: NopeTest, OtherNopeTest (use --allow-unknown for tests that only exist in the org)
        Gamma: not found locally: suite NoSuite, suite NoSuite2 (use --allow-unknown for tests that only exist in the org)
      "
    `);
  });

  it('rejects a plan that is a string or null', async () => {
    for (const plan of ['"text"', 'null']) {
      write('plan.json', plan);
      expect((await run('apply', '--plan', join(root, 'plan.json'))).stderr).toBe(
        'apex-test-map: Plan must be a JSON object\n',
      );
    }
  });
});

describe('list output', () => {
  it('prints tests, deploy flags, and warnings exactly', async () => {
    // apextestlist's warnings name files with the platform's path separator.
    const slashes = (text: string): string => text.replace(/\\/g, '/');
    expect(slashes((await run('list')).stdout)).toMatchInlineSnapshot(`
      "Tests (13): alphatest, AlphaTest, ARefTest, Beta_Test, Beta_Tests, BetaTest, BetaTests, DmlTest, MentionTest, NS.AlphaTest, Test_Beta, TestBeta, ZRefTest
      Deploy flags: --tests alphatest --tests AlphaTest --tests ARefTest --tests Beta_Test --tests Beta_Tests --tests BetaTest --tests BetaTests --tests DmlTest --tests MentionTest --tests NS.AlphaTest --tests Test_Beta --tests TestBeta --tests ZRefTest
      Warnings (6):
        File "Vendor.cls" does not contain @tests, @testsuites, or @istest annotations
        File "Beta.cls" does not contain @tests, @testsuites, or @istest annotations
        File "sub/Deep.cls" does not contain @tests, @testsuites, or @istest annotations
        File "AlphaTrigger.trigger" does not contain @tests, @testsuites, or @istest annotations
        File "Beta.trigger" does not contain @tests, @testsuites, or @istest annotations
        File "Vendor.cls" does not contain @tests, @testsuites, or @istest annotations
      "
    `);
    const listed = await json<{ warnings: string[] }>('list');
    expect({ ...listed, warnings: listed.warnings.map(slashes) }).toMatchInlineSnapshot(`
      {
        "command": "--tests alphatest --tests AlphaTest --tests ARefTest --tests Beta_Test --tests Beta_Tests --tests BetaTest --tests BetaTests --tests DmlTest --tests MentionTest --tests NS.AlphaTest --tests Test_Beta --tests TestBeta --tests ZRefTest",
        "tests": [
          "alphatest",
          "AlphaTest",
          "ARefTest",
          "Beta_Test",
          "Beta_Tests",
          "BetaTest",
          "BetaTests",
          "DmlTest",
          "MentionTest",
          "NS.AlphaTest",
          "Test_Beta",
          "TestBeta",
          "ZRefTest",
        ],
        "warnings": [
          "File "Vendor.cls" does not contain @tests, @testsuites, or @istest annotations",
          "File "Beta.cls" does not contain @tests, @testsuites, or @istest annotations",
          "File "sub/Deep.cls" does not contain @tests, @testsuites, or @istest annotations",
          "File "AlphaTrigger.trigger" does not contain @tests, @testsuites, or @istest annotations",
          "File "Beta.trigger" does not contain @tests, @testsuites, or @istest annotations",
          "File "Vendor.cls" does not contain @tests, @testsuites, or @istest annotations",
        ],
      }
    `);
    write('package.xml', '<Package><types><members>Alpha</members><name>ApexClass</name></types></Package>');
    expect((await run('list', '--manifest', join(root, 'package.xml'))).stdout).toBe(
      'Tests (1): AlphaTest\nDeploy flags: --tests AlphaTest\n',
    );
    write('package.xml', '<Package><types><members>Vendor</members><name>ApexClass</name></types></Package>');
    expect((await run('list', '--manifest', join(root, 'package.xml'))).stdout).toMatchInlineSnapshot(`
      "Tests (0): -
      Warnings (3):
        File "Vendor.cls" does not contain @tests, @testsuites, or @istest annotations
        File "Vendor.cls" does not contain @tests, @testsuites, or @istest annotations
        No test methods found
      "
    `);
  });
});

describe('cli', () => {
  it('parses every option into the expected options object', () => {
    expect(
      parseArgs([
        'scan',
        '--project',
        'p',
        '--ignore-package-directory',
        'a',
        '--ignore-package-directory',
        'b',
        '--coverage',
        'c.json',
        '--plan',
        'plan.json',
        '--header-template',
        'h.txt',
        '--manifest',
        'm.xml',
        '--only',
        ' One,,two ,',
        '--max-tests',
        '3',
        '--json',
        '--missing-only',
        '--dry-run',
        '--allow-unknown',
        '--ignore-missing-tests',
        '--filter-by-metadata',
      ]),
    ).toEqual({
      command: 'scan',
      project: 'p',
      ignore: ['a', 'b'],
      coverage: 'c.json',
      plan: 'plan.json',
      headerTemplate: 'h.txt',
      manifest: 'm.xml',
      only: new Set(['one', 'two']),
      maxTests: 3,
      json: true,
      missingOnly: true,
      dryRun: true,
      allowUnknown: true,
      ignoreMissingTests: true,
      filterByMetadata: true,
      help: false,
    });
    expect(parseArgs([])).toEqual(expect.objectContaining({ command: undefined, ignore: [], only: null, help: false }));
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['list', '--help'])).toEqual(expect.objectContaining({ command: 'list', help: true }));
  });

  it('prints usage, and formats errors with or without the command name', async () => {
    let out = '';
    let err = '';
    const io = {
      out: (text: string): void => {
        out += text;
      },
      err: (text: string): void => {
        err += text;
      },
    };
    expect(await main([], io)).toBe(0);
    expect(out).toMatch(/^Usage: apex-test-map <scan\|apply\|audit\|list>/);
    out = '';
    expect(await main(['scan', '--help', '--project', root], io)).toBe(0);
    expect(out).toMatch(/^Usage:/);
    expect(await main(['nope'], io)).toBe(2);
    expect(await main(['scan', '--max-tests', 'x'], io)).toBe(2);
    write('plan.json', JSON.stringify({ Nope: ['AlphaTest'] }));
    expect(await main(['apply', '--plan', join(root, 'plan.json'), '--project', root], io)).toBe(1);
    expect(err.split(root).join('<root>')).toBe(
      'apex-test-map: Unknown command "nope". Use scan, apply, audit, or list.\n' +
        'apex-test-map: --max-tests must be a positive number\n' +
        'Plan has problems; no files were changed:\n  Nope: no class or trigger with that name\n',
    );
  });
});

describe('internals', () => {
  it('uses forward slashes in paths on every platform', () => {
    expect(normalizePath('force-app\\main\\default\\classes\\A.cls')).toBe('force-app/main/default/classes/A.cls');
  });

  it('strips comments and strings but keeps code', () => {
    expect(stripCommentsAndStrings("a // x 'q'\nb /* 1 */c/* 2\n*/d 'it\\'s' e 'x' f")).toBe("a \nb  c d '' e '' f");
    expect(stripCommentsAndStrings('a /* unclosed\nb')).toBe('a  ');
    expect(stripCommentsAndStrings("a 'unclosed\nb")).toBe("a ''");
    expect(stripCommentsAndStrings("x '//' y")).toBe("x '' y");
    expect(stripCommentsAndStrings("x 'a\\ b' y")).toBe("x '' y");
  });

  it('parses annotation names like apextestlist', () => {
    expect(parseAnnotation('// @Tests: A, B  C\n// @tests:D', TEST_NAME_REGEX)).toEqual(['A', 'B', 'C', 'D']);
    expect(parseAnnotation('/* @Tests: A, B */', TEST_NAME_REGEX)).toEqual(['A', 'B']);
    expect(parseAnnotation('// @Tests: ,', TEST_NAME_REGEX)).toEqual([]);
    expect(parseAnnotation('// @TestSuites: S1', TEST_SUITE_NAME_REGEX)).toEqual(['S1']);
  });

  it('fills in an empty annotation on its own line, without touching the next line', () => {
    const merge = (content: string, names: string[]): string => mergeExisting(content, '@Tests', names).content;
    expect(merge('// @Tests:\n// note\npublic class X {}', ['A'])).toBe('// @Tests: A\n// note\npublic class X {}');
    expect(merge('// @Tests:\npublic class X {}', ['A', 'B'])).toBe('// @Tests: A, B\npublic class X {}');
    expect(merge('// @Tests:\r\npublic class X {}\r\n', ['A'])).toBe('// @Tests: A\r\npublic class X {}\r\n');
    expect(merge('// @Tests: \npublic class X {}', ['A'])).toBe('// @Tests: A\npublic class X {}');
    expect(merge('// @Tests:A\n', ['B'])).toBe('// @Tests: A, B\n');
    expect(merge('// @Tests :\n', ['A'])).toBe('// @Tests : A\n');
    expect(mergeExisting('// @TestSuites\t:\n', '@TestSuites', ['S']).content).toBe('// @TestSuites\t: S\n');
    expect(merge('// @Tests: A\n// @Tests: B\n', ['C'])).toBe('// @Tests: A, C\n// @Tests: B\n');
    expect(mergeExisting('// @TestSuites:\n// @Tests: A\n', '@TestSuites', ['S'])).toEqual({
      content: '// @TestSuites: S\n// @Tests: A\n',
      added: ['S'],
      pending: [],
    });
  });

  it('merges names into the first annotation, keeping a closing */', () => {
    expect(mergeExisting('/* @Tests: A, B */\nclass X {}', '@Tests', ['C', 'c', 'A'])).toEqual({
      content: '/* @Tests: A, B, C */\nclass X {}',
      added: ['C'],
      pending: [],
    });
    expect(mergeExisting('// @Tests: A,B\n', '@Tests', ['a'])).toEqual({
      content: '// @Tests: A,B\n',
      added: [],
      pending: [],
    });
    expect(mergeExisting('class X {}', '@Tests', ['A', 'A'])).toEqual({
      content: 'class X {}',
      added: ['A'],
      pending: ['A'],
    });
  });

  it('finds leading headers', () => {
    expect(findLeadingHeader('\n  /*/ still open */\nclass X {}')).toEqual({ type: 'block', start: 3, close: 18 });
    expect(findLeadingHeader('/* never closed')).toBeNull();
    expect(findLeadingHeader('\n// a\n  // b\nclass X {}')).toEqual({ type: 'line', start: 1, end: 13 });
    expect(findLeadingHeader('class X {} // a')).toBeNull();
    expect(isInHeader({ type: 'line', start: 0, end: 5 }, 4)).toBe(true);
    expect(isInHeader({ type: 'line', start: 0, end: 5 }, 5)).toBe(false);
    expect(isInHeader({ type: 'block', start: 0, close: 9 }, 8)).toBe(true);
    expect(isInHeader({ type: 'block', start: 0, close: 9 }, 9)).toBe(false);
  });

  it('reads coverage records defensively and keeps the cause of a read error', async () => {
    write(
      'c.json',
      JSON.stringify([null, { ApexClassOrTrigger: { Name: 'Alpha' } }, { ApexTestClass: { Name: 'T' } }]),
    );
    expect(await loadCoverage(join(root, 'c.json'))).toEqual(new Map());
    write('c.json', 'null');
    await expect(loadCoverage(join(root, 'c.json'))).rejects.toThrow('has no records array');
    write('c.json', '{');
    await expect(loadCoverage(join(root, 'c.json'))).rejects.toMatchObject({
      name: 'MapError',
      exitCode: 2,
      cause: expect.any(SyntaxError),
    });
    expect(await loadCoverage(undefined)).toBeNull();
  });

  it('loads the project the way apextestlist sees it', async () => {
    const project = await loadProject({ project: root, ignore: [] });
    expect(project.pkgDirs).toEqual(['vendor', 'force-app', 'extra/./pkg']);
    expect(project.apex.map((a) => a.file)).toEqual([...project.apex.map((a) => a.file).sort()]);
    expect(project.apex.map((a) => `${a.kind} ${a.name}`)).toContain('class Deep');
    expect(project.apex.some((a) => a.file.endsWith('-meta.xml'))).toBe(false);
    expect(project.classesByLower.has('alphatrigger')).toBe(false);
    const trigger = project.apex.find((a) => a.name === 'AlphaTrigger');
    expect(trigger?.sObject).toBe('Account');
    expect(trigger?.tokens.has('alphatrigger')).toBe(false);
    expect(project.apex.find((a) => a.name === 'DmlTest')?.hasDml).toBe(true);
    expect(project.apex.find((a) => a.name === 'AlphaTest')?.hasDml).toBe(false);
    expect((await loadProject({ project: root, ignore: ['vendor'] })).pkgDirs).toEqual(['force-app', 'extra/./pkg']);
    await expect(loadProject({ project: tmpdir(), ignore: [] })).rejects.toMatchObject({ cause: expect.any(Error) });
  });

  it('reports a suite it cannot read once, without inventing entries', async () => {
    write(`${DEFAULT}/testSuites/Broken.testSuite-meta.xml`, '<Other/>');
    const project = await loadProject({ project: root, ignore: [] });
    expect(project.suites.find((s) => s.name === 'Broken')).toEqual({
      name: 'Broken',
      file: `${DEFAULT}/testSuites/Broken.testSuite-meta.xml`,
      classes: [],
      error: 'Invalid XML: expected root element "ApexTestSuite", got "Other"',
    });
  });

  it('checks templates line by line', async () => {
    const problems = async (template: string): Promise<string> => {
      write('t.txt', template);
      try {
        await loadTemplate(join(root, 't.txt'));
        return 'ok';
      } catch (error) {
        return (error as Error).message.split(root).join('<root>').replace(/\\/g, '/');
      }
    };
    expect(await problems('  \n \n')).toBe('Header template <root>/t.txt has problems:\n  it is empty');
    expect(await problems('  // @tests: {{tests}}\n')).toBe('ok');
    expect(await problems('/**\r\n * @Tests: {{tests}}\r\n */\r\n')).toBe('ok');
    expect(await problems('/**\n * @Tests: {{tests}}\n */\n   \n')).toBe('ok');
    expect(await problems('// a\n// {{who}}\n// @Tests: {{tests}}\n')).toBe(
      'Header template <root>/t.txt has problems:\n  line 2: unknown placeholder {{who}}',
    );
    expect(await problems('// a\nx // b\n// @Tests: {{tests}}\n')).toBe(
      'Header template <root>/t.txt has problems:\n  line 2 is not a comment line',
    );
    expect(await problems('/**\n *   @Tests: {{tests}} x\n * @TestSuites: {{suites}} */\n')).toBe(
      'Header template <root>/t.txt has problems:\n' +
        '  "*   @Tests: {{tests}} x" must end with "@Tests: {{tests}}", with nothing after it\n' +
        '  "* @TestSuites: {{suites}} */" must end with "@TestSuites: {{suites}}", with nothing after it',
    );
    write('t.txt', '/**\n * @Tests: {{tests}}\n */\n');
    const template = await loadTemplate(join(root, 't.txt'));
    expect(template.type).toBe('block');
    write('t.txt', '// @Tests: {{tests}}\n\n\n');
    expect((await loadTemplate(join(root, 't.txt'))).lines).toEqual(['// @Tests: {{tests}}']);
    await expect(loadTemplate(join(root, 'missing.txt'))).rejects.toMatchObject({ cause: expect.any(Error) });
  });

  it('keeps the cause when apply or list fail', async () => {
    write('plan.json', '{');
    const io = { out: (): void => {}, err: (): void => {} };
    await expect(
      apply(parseArgs(['apply', '--plan', join(root, 'plan.json'), '--project', root]), io),
    ).rejects.toMatchObject({
      cause: expect.any(SyntaxError),
    });
    await expect(list(parseArgs(['list', '--project', tmpdir()]), io)).rejects.toMatchObject({
      cause: expect.any(Error),
    });
    const error = new MapError('boom', { exitCode: 1, cause: 'why' });
    expect([error.name, error.message, error.exitCode, error.cause]).toEqual(['MapError', 'boom', 1, 'why']);
  });
});

describe('insertion edge cases', () => {
  async function applyOne(file: string, content: string, entry: unknown, template?: string): Promise<string> {
    write(`${DEFAULT}/classes/${file}.cls`, content);
    write('plan.json', JSON.stringify({ [file]: entry }));
    const args = ['apply', '--plan', join(root, 'plan.json')];
    if (template !== undefined) {
      write('header.txt', template);
      args.push('--header-template', join(root, 'header.txt'));
    }
    const result = await run(...args);
    expect(result.status, result.stderr).toBe(0);
    return read(`${DEFAULT}/classes/${file}.cls`);
  }

  const suites = { suites: ['Suite1'] };
  const LINE = '// @Tests: {{tests}}\n';
  const BLOCK = '/**\n * @Tests: {{tests}}\n */\n';

  it('puts a new annotation next to an existing one only when that line is just a comment', async () => {
    expect(await applyOne('N1', '// note @Tests: AlphaTest\nclass N1 {}', suites)).toBe(
      '// @TestSuites: Suite1\n// note @Tests: AlphaTest\nclass N1 {}',
    );
    expect(await applyOne('N2', '//@Tests: AlphaTest\nclass N2 {}', suites)).toBe(
      '//@Tests: AlphaTest\n//@TestSuites: Suite1\nclass N2 {}',
    );
    expect(await applyOne('N3', '// @Tests : AlphaTest\nclass N3 {}', suites)).toBe(
      '// @Tests : AlphaTest\n// @TestSuites: Suite1\nclass N3 {}',
    );
  });

  it('adds to a // header whether or not the file ends inside it', async () => {
    expect(await applyOne('L1', '// only comment\n', ['AlphaTest'], LINE)).toBe(
      '// only comment\n// @Tests: AlphaTest\n',
    );
    expect(await applyOne('L2', '// c\nclass L2 {}', ['AlphaTest'], LINE)).toBe(
      '// c\n// @Tests: AlphaTest\nclass L2 {}',
    );
    expect(await applyOne('L3', '\n// c', ['AlphaTest'], LINE)).toBe('\n// c\n// @Tests: AlphaTest\n');
  });

  it('matches the indentation of the line above the closing */', async () => {
    expect(await applyOne('B1', '/**\n   * deep\n */\nclass B1 {}', ['AlphaTest'], BLOCK)).toBe(
      '/**\n   * deep\n   * @Tests: AlphaTest\n */\nclass B1 {}',
    );
    expect(await applyOne('B2', '/*\n* flush\n  */\nclass B2 {}', ['AlphaTest'], BLOCK)).toBe(
      '/*\n* flush\n* @Tests: AlphaTest\n  */\nclass B2 {}',
    );
    expect(await applyOne('B3', '/*\nCopyright * 2024\n*/\nclass B3 {}', ['AlphaTest'], BLOCK)).toBe(
      '/*\nCopyright * 2024\n* @Tests: AlphaTest\n*/\nclass B3 {}',
    );
    expect(await applyOne('B4', '/* one line */\nclass B4 {}', ['AlphaTest'], BLOCK)).toBe(
      '// @Tests: AlphaTest\n/* one line */\nclass B4 {}',
    );
  });

  it('renders a template without blank lines it ended with', async () => {
    expect(await applyOne('T1', 'class T1 {}\n', ['AlphaTest'], `${BLOCK}\n\n`)).toBe(
      '/**\n * @Tests: AlphaTest\n */\nclass T1 {}\n',
    );
  });
});
