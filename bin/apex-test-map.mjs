#!/usr/bin/env node
// apex-test-map: helper for the apex-test-list Claude Code plugin, published as
// the `apex-test-map` bin of the apextestlist npm package.
//
// Scans a Salesforce DX project and maps each Apex class and trigger to the
// test classes that exercise it, so `// @Tests:` annotations can be written
// for the apextestlist plugin (`sf apextests list`). No dependencies; Node 22+.
//
//   scan   propose tests for each class/trigger (code coverage, references, names)
//   apply  write or merge `// @Tests:` / `// @TestSuites:` annotations from a plan
//   audit  report missing, unknown, and stale annotations
//
// Run with --help for options.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

const USAGE = `Usage: apex-test-map <scan|apply|audit> [options]

Common options:
  --project <dir>                  Salesforce DX project folder (default: nearest
                                   folder with sfdx-project.json, from the cwd)
  --ignore-package-directory <dir> Skip a package directory (repeatable)
  --coverage <file>                JSON from: sf data query --use-tooling-api --json -q
                                   "SELECT ApexTestClass.Name, ApexClassOrTrigger.Name
                                   FROM ApexCodeCoverage"
  --json                           Print JSON instead of text

scan options:
  --missing-only                   Only classes/triggers without @Tests/@TestSuites
  --only <Name,Name>               Only these classes/triggers
  --max-tests <n>                  Flag proposals with more than n tests (default 10)

apply options:
  --plan <file>                    JSON: { "ClassName": ["TestA", "TestB"] } or
                                   { "ClassName": { "tests": [...], "suites": [...] } }
                                   Prefix a key with "trigger:" or "class:" if a
                                   class and a trigger share a name.
  --dry-run                        Show changes without writing files
  --allow-unknown                  Allow test names that are not local @isTest classes
  --header-template <file>         Comment header to follow. Names go into an existing
                                   header; files without one get the template, with
                                   {{name}}, {{kind}}, {{tests}}, {{suites}} filled in.
                                   Existing headers are never rewritten.

audit options:
  --max-tests <n>                  Flag annotations with more than n tests (default 10)
  --header-template <file>         Flag annotated files whose annotations are not in a
                                   leading header of the template's comment style
`;

const SKIP_DIRS = new Set(['node_modules', '.git', '.sfdx', '.sf', '.husky']);
const TEST_NAME_REGEX = /@tests\s*:\s*([^/\n]+)/gi;
const TEST_SUITE_NAME_REGEX = /@testsuites\s*:\s*([^/\n]+)/gi;
const IS_TEST_REGEX = /@istest/i;
const DML_REGEX =
  /\b(insert|update|upsert|delete|undelete|merge)\b|\bdatabase\s*\.\s*(insert|update|upsert|delete|undelete|merge)/i;
const TEST_DEPENDENCIES_FILE = '.test-dependencies.yml';
const METADATA_ENTRY_REGEX = /^[A-Za-z]+:[^\s:]+$/;

// ---------- argument parsing ----------

function parseArgs(argv) {
  const hasCommand = argv.length > 0 && !argv[0].startsWith('-');
  const opts = { command: hasCommand ? argv[0] : undefined, ignore: [], only: null, maxTests: 10 };
  for (let i = hasCommand ? 1 : 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) fail(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case '--project':
        opts.project = next();
        break;
      case '--ignore-package-directory':
        opts.ignore.push(next());
        break;
      case '--coverage':
        opts.coverage = next();
        break;
      case '--plan':
        opts.plan = next();
        break;
      case '--only':
        opts.only = new Set(
          next()
            .split(',')
            .map((n) => n.trim().toLowerCase())
            .filter(Boolean),
        );
        break;
      case '--max-tests':
        opts.maxTests = Number.parseInt(next(), 10);
        if (!Number.isFinite(opts.maxTests) || opts.maxTests < 1) fail('--max-tests must be a positive number');
        break;
      case '--json':
        opts.json = true;
        break;
      case '--missing-only':
        opts.missingOnly = true;
        break;
      case '--header-template':
        opts.headerTemplate = next();
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--allow-unknown':
        opts.allowUnknown = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        fail(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function fail(message) {
  process.stderr.write(`apex-test-map: ${message}\n`);
  process.exit(2);
}

// ---------- project discovery ----------

function findProjectRoot(start) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'sfdx-project.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) fail(`No sfdx-project.json found in ${resolve(start)} or its parents`);
    dir = parent;
  }
}

function normalize(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function packageDirectories(root, ignore) {
  let project;
  try {
    project = JSON.parse(stripBom(readFileSync(join(root, 'sfdx-project.json'), 'utf8')));
  } catch (error) {
    fail(`Cannot read sfdx-project.json: ${error.message}`);
  }
  const ignored = new Set(ignore.map(normalize));
  const dirs = (project.packageDirectories ?? [])
    .map((d) => normalize(d.path ?? ''))
    .filter((p) => p && !ignored.has(p));
  return [...new Set(dirs)];
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ---------- Apex source analysis ----------

/** Removes comments and string literals so only code identifiers remain. */
function stripCommentsAndStrings(src) {
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

/** Same parsing as apextestlist: names separated by commas and/or whitespace. */
function parseAnnotation(raw, regex) {
  const names = [];
  for (const match of raw.matchAll(regex)) {
    for (const name of match[1].split(/[,\s]+/)) {
      const clean = name.replace(/\*/g, '').trim();
      if (clean) names.push(clean);
    }
  }
  return names;
}

function readApexFile(file, root) {
  const raw = stripBom(readFileSync(file, 'utf8'));
  const isTrigger = file.endsWith('.trigger');
  const name = basename(file, isTrigger ? '.trigger' : '.cls');
  const code = stripCommentsAndStrings(raw);
  const tokens = new Set((code.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).map((t) => t.toLowerCase()));
  tokens.delete(name.toLowerCase());
  const sObjectMatch = isTrigger ? /\btrigger\s+\w+\s+on\s+(\w+)/i.exec(code) : null;
  return {
    name,
    kind: isTrigger ? 'trigger' : 'class',
    file: normalize(relative(root, file)),
    path: file,
    isTest: !isTrigger && IS_TEST_REGEX.test(raw),
    tests: parseAnnotation(raw, TEST_NAME_REGEX),
    suites: parseAnnotation(raw, TEST_SUITE_NAME_REGEX),
    tokens,
    sObject: sObjectMatch ? sObjectMatch[1] : undefined,
    hasDml: DML_REGEX.test(code),
  };
}

function readSuite(file, root) {
  const xml = readFileSync(file, 'utf8');
  const classes = [...xml.matchAll(/<testClassName>\s*([^<]+?)\s*<\/testClassName>/g)].map((m) => m[1]);
  return { name: basename(file, '.testSuite-meta.xml'), file: normalize(relative(root, file)), classes };
}

function loadProject(opts) {
  const root = opts.project ? resolve(opts.project) : findProjectRoot(process.cwd());
  if (!existsSync(join(root, 'sfdx-project.json'))) fail(`No sfdx-project.json in ${root}`);
  const pkgDirs = packageDirectories(root, opts.ignore);
  const files = [];
  for (const dir of pkgDirs) {
    const full = join(root, dir);
    if (existsSync(full) && statSync(full).isDirectory()) walk(full, files);
  }
  files.sort();
  const apex = files.filter((f) => f.endsWith('.cls') || f.endsWith('.trigger')).map((f) => readApexFile(f, root));
  const suites = files.filter((f) => f.endsWith('.testSuite-meta.xml')).map((f) => readSuite(f, root));
  const tests = apex.filter((a) => a.isTest);
  const testsByLower = new Map(tests.map((t) => [t.name.toLowerCase(), t]));
  const classesByLower = new Map(apex.filter((a) => a.kind === 'class').map((a) => [a.name.toLowerCase(), a]));
  return { root, pkgDirs, apex, suites, tests, testsByLower, classesByLower };
}

function loadCoverage(file) {
  if (!file) return null;
  let data;
  try {
    data = JSON.parse(stripBom(readFileSync(file, 'utf8')));
  } catch (error) {
    fail(`Cannot read coverage file ${file}: ${error.message}`);
  }
  const records = data?.result?.records ?? data?.records ?? (Array.isArray(data) ? data : null);
  if (!Array.isArray(records)) fail(`Coverage file ${file} has no records array`);
  const map = new Map();
  for (const r of records) {
    const target = r?.ApexClassOrTrigger?.Name;
    const test = r?.ApexTestClass?.Name;
    if (!target || !test) continue;
    const key = target.toLowerCase();
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(test);
  }
  return map;
}

// ---------- scan ----------

function nameConventionMatches(target, testsByLower) {
  const n = target.toLowerCase();
  const candidates = [`${n}test`, `${n}_test`, `${n}tests`, `${n}_tests`, `test${n}`, `test_${n}`];
  return candidates.filter((c) => testsByLower.has(c)).map((c) => testsByLower.get(c).name);
}

function directProposals(target, project, coverage) {
  const proposals = new Map();
  const add = (test, source) => {
    const key = test.toLowerCase();
    if (!proposals.has(key)) proposals.set(key, { test, sources: [] });
    const p = proposals.get(key);
    if (!p.sources.includes(source)) p.sources.push(source);
  };
  for (const test of coverage?.get(target.name.toLowerCase()) ?? []) {
    add(project.testsByLower.get(test.toLowerCase())?.name ?? test, 'coverage');
  }
  if (target.kind === 'class') {
    const lower = target.name.toLowerCase();
    for (const test of project.tests) {
      if (test.tokens.has(lower)) add(test.name, 'reference');
    }
  }
  for (const test of nameConventionMatches(target.name, project.testsByLower)) add(test, 'name');
  return proposals;
}

function scanTarget(target, project, coverage, maxTests) {
  const proposals = directProposals(target, project, coverage);
  const result = {
    name: target.name,
    kind: target.kind,
    file: target.file,
    existing: { tests: target.tests, suites: target.suites },
  };

  if (target.kind === 'trigger') {
    result.sObject = target.sObject;
    // Tests of the handler classes the trigger calls.
    const handlers = [...target.tokens].map((t) => project.classesByLower.get(t)).filter((c) => c && !c.isTest);
    result.handlers = handlers.map((h) => h.name);
    for (const handler of handlers) {
      for (const p of directProposals(handler, project, null).values()) {
        const key = p.test.toLowerCase();
        if (!proposals.has(key)) proposals.set(key, { test: p.test, sources: [] });
        const entry = proposals.get(key);
        if (!entry.sources.includes('handler')) entry.sources.push('handler');
      }
    }
    // Tests that run DML on the trigger's object fire it, but that set is usually broad.
    if (target.sObject) {
      const so = target.sObject.toLowerCase();
      const dml = project.tests.filter((t) => t.hasDml && t.tokens.has(so) && !proposals.has(t.name.toLowerCase()));
      result.dmlCandidates = { count: dml.length, sample: dml.slice(0, 25).map((t) => t.name) };
    }
  }

  const sourceRank = { coverage: 0, name: 1, handler: 2, reference: 3 };
  result.proposed = [...proposals.values()].sort(
    (a, b) =>
      Math.min(...a.sources.map((s) => sourceRank[s])) - Math.min(...b.sources.map((s) => sourceRank[s])) ||
      a.test.localeCompare(b.test),
  );
  result.missingLocally = result.proposed
    .filter((p) => !project.testsByLower.has(p.test.toLowerCase()))
    .map((p) => p.test);
  result.broad = result.proposed.length > maxTests;
  return result;
}

function scan(opts) {
  const project = loadProject(opts);
  const coverage = loadCoverage(opts.coverage);
  let targets = project.apex.filter((a) => !a.isTest);
  if (opts.only) targets = targets.filter((t) => opts.only.has(t.name.toLowerCase()));
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
    print(JSON.stringify({ summary, targets: results }, null, 2));
    return;
  }

  const lines = [];
  lines.push(`Project: ${summary.projectRoot}`);
  lines.push(`Package directories: ${summary.packageDirectories.join(', ') || '(none)'}`);
  lines.push(
    `Test classes: ${summary.testClasses} | targets: ${summary.targets} | already annotated: ${summary.alreadyAnnotated} | ` +
      `with proposal: ${summary.withProposal} | no proposal: ${summary.withoutProposal} | broad (>${opts.maxTests}): ${summary.broad}`,
  );
  lines.push(`Coverage data: ${summary.coverageUsed ? 'yes' : 'no (static analysis only)'}`);
  lines.push('');
  lines.push(
    'Sources: coverage = covered in org | name = naming convention | handler = tests of a class the trigger calls | reference = test code names the class',
  );
  lines.push('');
  for (const r of results) {
    const existing = [
      r.existing.tests.length ? `@Tests: ${r.existing.tests.join(', ')}` : '',
      r.existing.suites.length ? `@TestSuites: ${r.existing.suites.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join(' | ');
    const shown = r.proposed.slice(0, opts.maxTests).map((p) => `${p.test}[${p.sources.join(',')}]`);
    const more = r.proposed.length > opts.maxTests ? ` +${r.proposed.length - opts.maxTests} more (BROAD)` : '';
    lines.push(`${r.kind === 'trigger' ? 'trigger ' : ''}${r.name}  (${r.file})`);
    lines.push(`  existing: ${existing || '-'}`);
    lines.push(`  proposed: ${shown.join(', ') || '-'}${more}`);
    if (r.kind === 'trigger') {
      lines.push(`  on ${r.sObject ?? '?'}; calls: ${r.handlers.join(', ') || '-'}`);
      if (r.dmlCandidates?.count) {
        const extra =
          r.dmlCandidates.count > r.dmlCandidates.sample.length
            ? ` +${r.dmlCandidates.count - r.dmlCandidates.sample.length} more`
            : '';
        lines.push(`  DML on ${r.sObject} (fires trigger, not proposed): ${r.dmlCandidates.sample.join(', ')}${extra}`);
      }
    }
    if (r.missingLocally.length) lines.push(`  not found locally: ${r.missingLocally.join(', ')}`);
  }
  print(lines.join('\n'));
}

// ---------- apply ----------

function joinNames(names) {
  return names.join(', ');
}

/**
 * Adds names to the first existing annotation of this kind. When the file has
 * none, returns the names as `pending` so the caller can insert a new line.
 */
function mergeExisting(content, regex, names) {
  const existing = parseAnnotation(content, regex);
  const seen = new Set(existing.map((n) => n.toLowerCase()));
  const added = names.filter((n) => {
    const key = n.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!added.length) return { content, added, pending: [] };

  const first = new RegExp(regex.source, 'i').exec(content);
  if (!first) return { content, added, pending: added };
  const captured = first[1];
  const trailing = /[\s*]*$/.exec(captured)[0];
  const start = first.index + first[0].length - captured.length;
  const merged = joinNames([...existing, ...added]);
  // Later lines of the same annotation are still read by apextestlist; their names are now on the first line too.
  return {
    content: content.slice(0, start) + merged + trailing + content.slice(start + captured.length),
    added,
    pending: [],
  };
}

const ANNOTATION_LINE_PREFIX = /^[ \t]*(\/\/|\*)[ \t]*$/;

/** Finds a leading `/* ... *\/` or `//` comment block before any code. */
function findLeadingHeader(content) {
  const lead = /^\s*/.exec(content)[0].length;
  const lineStart = content.lastIndexOf('\n', lead - 1) + 1;
  if (content.startsWith('/*', lead)) {
    const close = content.indexOf('*/', lead + 2);
    if (close === -1) return null;
    return { type: 'block', start: lead, end: close + 2, close };
  }
  if (content.startsWith('//', lead)) {
    const match = /^(?:[ \t]*\/\/[^\n]*(?:\n|$))+/.exec(content.slice(lineStart));
    return { type: 'line', start: lead, end: lineStart + match[0].length };
  }
  return null;
}

/** Inserts annotation lines inside an existing header; returns null if the header can't take them cleanly. */
function insertIntoHeader(content, header, inserts, eol) {
  const lines = (prefix) => inserts.map((i) => `${prefix}${i.label}: ${joinNames(i.names)}${eol}`).join('');
  if (header.type === 'line') {
    const atEnd = header.end === content.length && !content.endsWith('\n');
    const insertion = (atEnd ? eol : '') + lines('// ');
    return content.slice(0, header.end) + insertion + content.slice(header.end);
  }
  const closeLineStart = content.lastIndexOf('\n', header.close - 1) + 1;
  // A one-line block, or text before `*/` on its closing line, has no clean place for a new line.
  if (closeLineStart <= header.start || content.slice(closeLineStart, header.close).trim()) return null;
  const prevLineStart = content.lastIndexOf('\n', closeLineStart - 2) + 1;
  const prevPrefix = /^([ \t]*\*)(?!\/)/.exec(content.slice(prevLineStart, closeLineStart));
  const prefix = prevPrefix ? `${prevPrefix[1]} ` : `${content.slice(closeLineStart, header.close)}* `;
  return content.slice(0, closeLineStart) + lines(prefix) + content.slice(closeLineStart);
}

/** Inserts the line after an existing @Tests or @TestSuites comment line, using the same prefix. */
function insertNextToAnnotation(content, inserts, eol) {
  const match = /@(tests|testsuites)\s*:/i.exec(content);
  if (!match) return null;
  const lineStart = content.lastIndexOf('\n', match.index - 1) + 1;
  const prefix = content.slice(lineStart, match.index);
  if (!ANNOTATION_LINE_PREFIX.test(prefix)) return null;
  const lineEnd = content.indexOf('\n', match.index);
  const insertAt = lineEnd === -1 ? content.length : lineEnd + 1;
  const lead = lineEnd === -1 ? eol : '';
  const text = inserts.map((i) => `${prefix}${i.label}: ${joinNames(i.names)}${eol}`).join('');
  return content.slice(0, insertAt) + lead + text + content.slice(insertAt);
}

function insertAnnotations(content, inserts, eol, template, target) {
  const nextTo = insertNextToAnnotation(content, inserts, eol);
  if (nextTo !== null) return nextTo;
  if (template) {
    const header = findLeadingHeader(content);
    if (header) {
      const inHeader = insertIntoHeader(content, header, inserts, eol);
      if (inHeader !== null) return inHeader;
    } else {
      const values = { name: target.name, kind: target.kind, tests: '', suites: '' };
      for (const i of inserts) values[i.label === '@Tests' ? 'tests' : 'suites'] = joinNames(i.names);
      return renderTemplate(template, values, eol) + content;
    }
  }
  return inserts.map((i) => `// ${i.label}: ${joinNames(i.names)}${eol}`).join('') + content;
}

// ---------- header template ----------

const TEMPLATE_PLACEHOLDERS = new Set(['name', 'kind', 'tests', 'suites']);

/**
 * Reads and checks a header template: comment lines only, `{{tests}}` (and the
 * optional `{{suites}}`) alone at the end of an `@Tests:` / `@TestSuites:` line,
 * so apextestlist reads the names and nothing after them.
 */
function loadTemplate(file) {
  let raw;
  try {
    raw = stripBom(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`Cannot read header template ${file}: ${error.message}`);
  }
  const lines = raw.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const problems = [];
  const nonBlank = lines.filter((l) => l.trim());
  if (!nonBlank.length) problems.push('it is empty');
  const first = nonBlank[0]?.trim() ?? '';
  const type = first.startsWith('/*') ? 'block' : first.startsWith('//') ? 'line' : null;
  if (!type) problems.push('it must start with a /* or // comment');
  for (const [index, line] of lines.entries()) {
    const text = line.trim();
    if (text && !/^(\/\/|\/\*|\*)/.test(text)) problems.push(`line ${index + 1} is not a comment line`);
    for (const m of line.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
      if (!TEMPLATE_PLACEHOLDERS.has(m[1])) problems.push(`line ${index + 1}: unknown placeholder {{${m[1]}}}`);
    }
  }
  if (type === 'block') {
    const closeIndex = lines.findIndex((l) => l.includes('*/'));
    if (closeIndex === -1) problems.push('the /* comment is never closed with */');
    else if (lines.slice(closeIndex + 1).some((l) => l.trim())) problems.push('text follows the closing */');
  }
  const checkLine = (placeholder, label, required) => {
    const found = lines.filter((l) => l.includes(`{{${placeholder}}}`));
    if (!found.length && required) problems.push(`it needs a "${label}: {{${placeholder}}}" line`);
    if (found.length > 1) problems.push(`{{${placeholder}}} appears more than once`);
    const pattern = new RegExp(`${label}\\s*:\\s*\\{\\{${placeholder}\\}\\}\\s*$`, 'i');
    if (found.length === 1 && !pattern.test(found[0])) {
      problems.push(`"${found[0].trim()}" must end with "${label}: {{${placeholder}}}", with nothing after it`);
    }
  };
  checkLine('tests', '@Tests', true);
  checkLine('suites', '@TestSuites', false);
  if (problems.length) fail(`Header template ${file} has problems:\n  ${problems.join('\n  ')}`);
  return { lines, type };
}

function renderTemplate(template, values, eol) {
  const out = [];
  for (const line of template.lines) {
    // Leave out an annotation line with nothing to list; an empty @Tests: would add a blank test name.
    if (line.includes('{{tests}}') && !values.tests) continue;
    if (line.includes('{{suites}}') && !values.suites) continue;
    out.push(line.replace(/\{\{(name|kind|tests|suites)\}\}/g, (_, key) => values[key]));
  }
  return out.join(eol) + eol;
}

function normalizePlanEntry(key, value) {
  if (Array.isArray(value)) return { tests: value, suites: [] };
  if (value && typeof value === 'object') {
    return {
      tests: Array.isArray(value.tests) ? value.tests : [],
      suites: Array.isArray(value.suites) ? value.suites : [],
    };
  }
  fail(`Plan entry "${key}" must be an array of test names or { "tests": [...], "suites": [...] }`);
}

function apply(opts) {
  if (!opts.plan) fail('apply needs --plan <file>');
  let plan;
  try {
    plan = JSON.parse(stripBom(readFileSync(opts.plan, 'utf8')));
  } catch (error) {
    fail(`Cannot read plan ${opts.plan}: ${error.message}`);
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) fail('Plan must be a JSON object');

  const template = opts.headerTemplate ? loadTemplate(opts.headerTemplate) : null;
  const project = loadProject(opts);
  const suiteNames = new Set(project.suites.map((s) => s.name.toLowerCase()));
  const errors = [];
  const changes = [];

  for (const [rawKey, value] of Object.entries(plan)) {
    const entry = normalizePlanEntry(rawKey, value);
    const kindMatch = /^(class|trigger):(.+)$/i.exec(rawKey);
    const kind = kindMatch ? kindMatch[1].toLowerCase() : null;
    const name = (kindMatch ? kindMatch[2] : rawKey).trim();
    const matches = project.apex.filter(
      (a) => a.name.toLowerCase() === name.toLowerCase() && (!kind || a.kind === kind),
    );
    if (matches.length === 0) {
      errors.push(`${rawKey}: no class or trigger with that name`);
      continue;
    }
    if (matches.length > 1) {
      errors.push(
        `${rawKey}: matches ${matches.map((m) => m.file).join(' and ')}; prefix the key with "class:" or "trigger:"`,
      );
      continue;
    }
    const target = matches[0];
    if (target.isTest) {
      errors.push(`${rawKey}: is a test class; it runs on its own and needs no @Tests annotation`);
      continue;
    }
    const tests = entry.tests.map((t) => String(t).trim()).filter(Boolean);
    const suites = entry.suites.map((s) => String(s).trim()).filter(Boolean);
    const badNames = [...tests, ...suites].filter(
      (n) => !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(n),
    );
    if (badNames.length) {
      errors.push(`${rawKey}: invalid names ${badNames.join(', ')}`);
      continue;
    }
    if (!opts.allowUnknown) {
      const unknownTests = tests.filter((t) => !project.testsByLower.has(t.toLowerCase()));
      const unknownSuites = suites.filter((s) => !suiteNames.has(s.toLowerCase()));
      if (unknownTests.length || unknownSuites.length) {
        errors.push(
          `${rawKey}: not found locally: ${[...unknownTests, ...unknownSuites.map((s) => `suite ${s}`)].join(', ')} (use --allow-unknown for tests that only exist in the org)`,
        );
        continue;
      }
    }
    changes.push({ target, tests, suites });
  }

  if (errors.length) {
    process.stderr.write(`Plan has problems; no files were changed:\n  ${errors.join('\n  ')}\n`);
    process.exit(1);
  }

  const report = [];
  for (const { target, tests, suites } of changes) {
    const original = readFileSync(target.path, 'utf8');
    const bom = original.charCodeAt(0) === 0xfeff ? '﻿' : '';
    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    let content = stripBom(original);
    const t = mergeExisting(content, TEST_NAME_REGEX, tests);
    content = t.content;
    const s = mergeExisting(content, TEST_SUITE_NAME_REGEX, suites);
    content = s.content;
    const inserts = [];
    if (t.pending.length) inserts.push({ label: '@Tests', names: t.pending });
    if (s.pending.length) inserts.push({ label: '@TestSuites', names: s.pending });
    if (inserts.length) content = insertAnnotations(content, inserts, eol, template, target);
    const changed = t.added.length > 0 || s.added.length > 0;
    if (changed && !opts.dryRun) writeFileSync(target.path, bom + content, 'utf8');
    report.push({ file: target.file, addedTests: t.added, addedSuites: s.added, changed });
  }

  if (opts.json) {
    print(JSON.stringify({ dryRun: Boolean(opts.dryRun), files: report }, null, 2));
    return;
  }
  const lines = [];
  for (const r of report) {
    if (!r.changed) {
      lines.push(`unchanged  ${r.file}`);
      continue;
    }
    const parts = [];
    if (r.addedTests.length) parts.push(`@Tests += ${r.addedTests.join(', ')}`);
    if (r.addedSuites.length) parts.push(`@TestSuites += ${r.addedSuites.join(', ')}`);
    lines.push(`${opts.dryRun ? 'would update' : 'updated'}  ${r.file}  ${parts.join('; ')}`);
  }
  const count = report.filter((r) => r.changed).length;
  lines.push(`${count} file(s) ${opts.dryRun ? 'would change' : 'changed'}, ${report.length - count} unchanged.`);
  print(lines.join('\n'));
}

// ---------- audit ----------

function wildcardToRegex(pattern) {
  return new RegExp(
    `^${pattern
      .split('*')
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    'i',
  );
}

/** Minimal reader for the .test-dependencies.yml shape: `Test:` keys with `- Type:Member` items. */
function readTestDependencies(root) {
  const file = join(root, TEST_DEPENDENCIES_FILE);
  if (!existsSync(file)) return null;
  const map = new Map();
  const problems = [];
  let current = null;
  stripBom(readFileSync(file, 'utf8'))
    .split(/\r?\n/)
    .forEach((line, index) => {
      const text = line.replace(/\s+#.*$/, '').trimEnd();
      if (!text.trim() || text.trim().startsWith('#')) return;
      const key = /^([^\s-][^:]*):\s*$/.exec(text);
      const item = /^\s*-\s*['"]?([^'"]+?)['"]?\s*$/.exec(text);
      if (key) {
        current = key[1].trim();
        map.set(current, []);
      } else if (item && current) {
        map.get(current).push(item[1]);
        if (!METADATA_ENTRY_REGEX.test(item[1])) problems.push(`line ${index + 1}: "${item[1]}" is not Type:Member`);
      } else {
        problems.push(`line ${index + 1}: cannot read "${text.trim()}"`);
      }
    });
  return { map, problems };
}

/** Annotated files whose annotations aren't inside a leading header of the template's comment style. */
function headerProblems(targets, template) {
  const problems = [];
  for (const t of targets) {
    if (!t.tests.length && !t.suites.length) continue;
    const content = stripBom(readFileSync(t.path, 'utf8'));
    const header = findLeadingHeader(content);
    const first = /@(tests|testsuites)\s*:/i.exec(content);
    if (!header) problems.push({ file: t.file, issue: 'no leading header comment' });
    else if (header.type !== template.type) {
      problems.push({
        file: t.file,
        issue: `header is a ${header.type} comment; the template uses a ${template.type} comment`,
      });
    } else if (first.index < header.start || first.index >= header.end) {
      problems.push({ file: t.file, issue: 'annotation is outside the leading header' });
    }
  }
  return problems;
}

function audit(opts) {
  const template = opts.headerTemplate ? loadTemplate(opts.headerTemplate) : null;
  const project = loadProject(opts);
  const coverage = loadCoverage(opts.coverage);
  const suiteByLower = new Map(project.suites.map((s) => [s.name.toLowerCase(), s]));
  const targets = project.apex.filter((a) => !a.isTest);

  const unannotated = targets.filter((t) => !t.tests.length && !t.suites.length).map((t) => t.file);
  const unknownTests = [];
  const notTests = [];
  const unknownSuites = [];
  const broad = [];
  const coverageGaps = [];

  for (const t of project.apex) {
    for (const name of t.tests) {
      const key = name.toLowerCase();
      if (project.testsByLower.has(key)) continue;
      if (project.classesByLower.has(key)) notTests.push({ file: t.file, name });
      else unknownTests.push({ file: t.file, name });
    }
    for (const name of t.suites) {
      if (!suiteByLower.has(name.toLowerCase())) unknownSuites.push({ file: t.file, name });
    }
    if (!t.isTest && t.tests.length > opts.maxTests) broad.push({ file: t.file, count: t.tests.length });
  }

  if (coverage) {
    for (const t of targets) {
      const covered = coverage.get(t.name.toLowerCase());
      if (!covered) {
        if (t.tests.length)
          coverageGaps.push({
            file: t.file,
            issue: 'no coverage rows in the org data',
            annotated: t.tests,
            missing: [],
          });
        continue;
      }
      const coveredLower = new Set([...covered].map((c) => c.toLowerCase()));
      const annotatedLower = new Set(t.tests.map((c) => c.toLowerCase()));
      const viaSuites = t.suites.flatMap((s) => suiteByLower.get(s.toLowerCase())?.classes ?? []);
      const suiteMatchers = viaSuites.map(wildcardToRegex);
      const isSelected = (test) => annotatedLower.has(test.toLowerCase()) || suiteMatchers.some((re) => re.test(test));
      const missing = [...covered].filter((c) => !isSelected(c)).sort();
      const stale = t.tests.filter((a) => !coveredLower.has(a.toLowerCase()));
      if (missing.length || stale.length) coverageGaps.push({ file: t.file, missing, stale });
    }
  }

  const suiteProblems = [];
  for (const s of project.suites) {
    for (const entry of s.classes) {
      const bare = entry.includes('.') ? entry.split('.').pop() : entry;
      const re = wildcardToRegex(bare);
      const found = entry.includes('*')
        ? project.tests.some((t) => re.test(t.name))
        : project.testsByLower.has(bare.toLowerCase());
      if (!found) suiteProblems.push({ file: s.file, name: entry });
    }
  }

  const deps = readTestDependencies(project.root);
  const depProblems = deps ? [...deps.problems] : [];
  if (deps) {
    for (const test of deps.map.keys()) {
      if (!project.testsByLower.has(test.toLowerCase())) depProblems.push(`"${test}" is not a local @isTest class`);
    }
  }

  const result = {
    projectRoot: project.root,
    coverageUsed: Boolean(coverage),
    counts: { classesAndTriggers: targets.length, testClasses: project.tests.length, suites: project.suites.length },
    unannotated,
    unknownTests,
    notTests,
    unknownSuites,
    suiteProblems,
    broad,
    coverageGaps,
    testDependencies: deps ? { tests: deps.map.size, problems: depProblems } : null,
    headerProblems: template ? headerProblems(targets, template) : null,
  };

  if (opts.json) {
    print(JSON.stringify(result, null, 2));
    return;
  }

  const lines = [];
  const section = (title, items, fmt) => {
    lines.push(`${title}: ${items.length}`);
    for (const item of items) lines.push(`  ${fmt(item)}`);
  };
  lines.push(`Project: ${result.projectRoot}`);
  lines.push(
    `Classes/triggers: ${result.counts.classesAndTriggers} | test classes: ${result.counts.testClasses} | suites: ${result.counts.suites} | coverage data: ${result.coverageUsed ? 'yes' : 'no'}`,
  );
  lines.push('');
  section('No @Tests or @TestSuites (no tests run when these change)', unannotated, (f) => f);
  section('@Tests names that are not local classes', unknownTests, (x) => `${x.file}: ${x.name}`);
  section('@Tests names that are classes without @isTest', notTests, (x) => `${x.file}: ${x.name}`);
  section('@TestSuites names with no local suite', unknownSuites, (x) => `${x.file}: ${x.name}`);
  section('Suite entries that match no local test class', suiteProblems, (x) => `${x.file}: ${x.name}`);
  section(`Annotations with more than ${opts.maxTests} tests`, broad, (x) => `${x.file}: ${x.count} tests`);
  if (coverage) {
    section('Differences from org coverage', coverageGaps, (x) =>
      x.issue
        ? `${x.file}: ${x.issue}; annotated ${x.annotated.join(', ')}`
        : `${x.file}: ${[
            x.missing.length ? `covering tests not annotated: ${x.missing.join(', ')}` : '',
            x.stale.length ? `annotated but no coverage: ${x.stale.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('; ')}`,
    );
  }
  if (template) {
    section(
      'Annotations not in a leading header like the template',
      result.headerProblems,
      (x) => `${x.file}: ${x.issue}`,
    );
  }
  if (deps) section(`${TEST_DEPENDENCIES_FILE} problems`, depProblems, (x) => x);
  else lines.push(`${TEST_DEPENDENCIES_FILE}: not present`);
  print(lines.join('\n'));
}

// ---------- main ----------

function print(text) {
  process.stdout.write(`${text}\n`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.command) {
    print(USAGE);
    return;
  }
  switch (opts.command) {
    case 'scan':
      scan(opts);
      break;
    case 'apply':
      apply(opts);
      break;
    case 'audit':
      audit(opts);
      break;
    default:
      fail(`Unknown command "${opts.command}". Use scan, apply, or audit.`);
  }
}

main();
