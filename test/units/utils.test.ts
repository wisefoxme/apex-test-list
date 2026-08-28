import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConcurrencyThreshold } from '../../src/utils/concurrencyThreshold.js';
import { createQueue } from '../../src/utils/concurrentQueue.js';
import { formatList } from '../../src/utils/formatters.js';
import { getRepoRoot } from '../../src/utils/getRepoRoot.js';
import { validateTests } from '../../src/utils/validateTests.js';
import { findChild, parseXml } from '../../src/utils/xmlParser.js';
import { parseYaml } from '../../src/utils/yamlParser.js';

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

  it('finds sfdx-project.json by traversing parent directories', async () => {
    const tempBase = await mkdtemp(join(tmpdir(), 'repo-root-'));
    const subDir = join(tempBase, 'src', 'deep');
    await mkdir(subDir, { recursive: true });
    await writeFile(join(tempBase, 'sfdx-project.json'), '{}');
    vi.spyOn(process, 'cwd').mockReturnValue(subDir);
    try {
      const { repoRoot } = await getRepoRoot();
      expect(repoRoot).toBe(tempBase);
    } finally {
      await rm(tempBase, { recursive: true });
    }
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

  it('finds file in second directory when absent from first', async () => {
    const dir1 = await mkdtemp(join(tmpdir(), 'val1-'));
    const dir2 = await mkdtemp(join(tmpdir(), 'val2-'));
    await writeFile(join(dir2, 'SomeTest.cls'), '');
    try {
      const { validatedTests, warnings } = await validateTests(['SomeTest'], [dir1, dir2]);
      expect(validatedTests).toEqual(['SomeTest']);
      expect(warnings).toEqual([]);
    } finally {
      await rm(dir1, { recursive: true });
      await rm(dir2, { recursive: true });
    }
  });
});

describe('getConcurrencyThreshold', () => {
  it('returns Math.min of availableParallelism and 6', () => {
    const result = getConcurrencyThreshold();
    expect(result).toBe(Math.min(availableParallelism(), 6));
  });
});

describe('createQueue', () => {
  it('resolves once every task completes', async () => {
    const processed: number[] = [];
    const q = createQueue<number>((task, cb) => {
      processed.push(task);
      cb();
    }, 2);

    await q.push([1, 2, 3]);
    expect(processed.sort()).toEqual([1, 2, 3]);
  });

  it('resolves immediately when pushed an empty array', async () => {
    const q = createQueue<number>((_task, cb) => cb(), 2);
    await expect(q.push([])).resolves.toBeUndefined();
  });

  it('rejects when a worker reports an error', async () => {
    const q = createQueue<number>((task, cb) => {
      cb(task === 2 ? new Error('boom') : undefined);
    }, 2);

    await expect(q.push([1, 2, 3])).rejects.toThrow('boom');
  });

  it('accepts a single non-array task', async () => {
    const processed: number[] = [];
    const q = createQueue<number>((task, cb) => {
      processed.push(task);
      cb();
    }, 1);

    await q.push(5);
    expect(processed).toEqual([5]);
  });

  it('ignores late callbacks that arrive after the queue has already settled', async () => {
    const started: number[] = [];
    const q = createQueue<number>((task, cb) => {
      started.push(task);
      if (task === 1) {
        // deferred (not synchronous) so task 2 also gets dispatched in the
        // same synchronous pass before either callback fires
        Promise.resolve().then(() => cb(new Error('first')));
      } else if (task === 2) {
        setTimeout(() => cb(), 0);
      } else {
        cb();
      }
    }, 2);

    await expect(q.push([1, 2, 3])).rejects.toThrow('first');
    // let the deferred, post-settlement callback for task 2 fire and hit the guard
    await new Promise((resolve) => setTimeout(resolve, 10));
    // task 3 must never start: the queue must actually record itself as
    // settled, not just resolve the promise once, or a late callback would
    // wake runNext() and dispatch the remaining task
    expect(started).toEqual([1, 2]);
  });

  it('never runs more tasks concurrently than the configured concurrency', async () => {
    let active = 0;
    let maxActive = 0;
    const q = createQueue<number>((_task, cb) => {
      active++;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => {
        active--;
        cb();
      }, 5);
    }, 2);

    await q.push([1, 2, 3, 4, 5]);
    expect(maxActive).toBe(2);
  });

  it('does not resolve until every dispatched task has actually completed', async () => {
    const callbacks: Array<() => void> = [];
    const q = createQueue<number>((_task, cb) => {
      callbacks.push(cb);
    }, 3);

    const pushPromise = q.push([1, 2, 3]);
    let resolved = false;
    pushPromise.then(() => {
      resolved = true;
    });

    // concurrency (3) >= task count, so all 3 dispatch synchronously
    expect(callbacks).toHaveLength(3);

    callbacks[0]();
    callbacks[1]();
    await Promise.resolve(); // flush microtasks
    expect(resolved).toBe(false);

    callbacks[2]();
    await pushPromise;
    expect(resolved).toBe(true);
  });

  it('never invokes the worker more times than there are tasks', async () => {
    // concurrency (5) deliberately exceeds the task count (3), and the
    // worker defers its callback so the initial synchronous dispatch loop
    // gets a chance to over-run the task list before any task completes
    let calls = 0;
    const q = createQueue<number>((_task, cb) => {
      calls++;
      setTimeout(cb, 0);
    }, 5);

    await q.push([1, 2, 3]);
    expect(calls).toBe(3);
  });
});

describe('parseXml', () => {
  it('parses a self-closing root element', () => {
    const root = parseXml('<Foo/>');
    expect(root.name).toBe('Foo');
    expect(root.children).toEqual([]);
  });

  it('parses a nested self-closing element', () => {
    const root = parseXml('<Foo><Bar/></Foo>');
    expect(root.children).toHaveLength(1);
    expect(root.children[0].name).toBe('Bar');
  });

  it('throws on a closing tag with no matching open tag', () => {
    expect(() => parseXml('</a>')).toThrow('mismatched closing tag');
  });

  it('throws on a mismatched closing tag', () => {
    expect(() => parseXml('<a><b></c></a>')).toThrow('mismatched closing tag');
  });

  it('throws on an unclosed tag', () => {
    expect(() => parseXml('<a><b></b>')).toThrow('unclosed tag');
  });

  it('findChild returns undefined when no matching child exists', () => {
    const root = parseXml('<a><b/></a>');
    expect(findChild(root, 'c')).toBeUndefined();
  });

  it('decodes each XML entity to its correct character', () => {
    const root = parseXml('<a>&lt;&gt;&quot;&apos;&amp;</a>');
    expect(root.text).toBe(`<>"'&`);
  });

  it('throws the specific "no root element found" message on unparsable input', () => {
    expect(() => parseXml('<<< not valid xml >>>')).toThrow('no root element found');
  });

  it('ignores whitespace-only text between sibling tags', () => {
    const root = parseXml('<a>   <b/></a>');
    expect(root.text).toBe('');
  });

  it('ignores non-blank text found outside any element', () => {
    const root = parseXml('lead<a></a>');
    expect(root.name).toBe('a');
    expect(root.text).toBe('');
  });

  it('skips a comment containing both whitespace and non-whitespace characters', () => {
    const root = parseXml('<a><!-- a longer comment --><b/></a>');
    expect(root.text).toBe('');
    expect(root.children).toHaveLength(1);
  });

  it('skips a processing instruction with multi-character content', () => {
    const root = parseXml('<a><?target multi word instruction?><b/></a>');
    expect(root.text).toBe('');
    expect(root.children).toHaveLength(1);
  });

  it('parses a tag with attributes as a single token', () => {
    const root = parseXml('<Package xmlns="http://soap.sforce.com/2006/04/metadata"><types/></Package>');
    expect(root.name).toBe('Package');
    expect(root.children).toHaveLength(1);
    expect(root.children[0].name).toBe('types');
  });
});

describe('parseYaml', () => {
  it('parses a flat mapping of scalar keys to lists', () => {
    expect(parseYaml('Foo:\n  - Bar\n  - Baz\n')).toEqual({ Foo: ['Bar', 'Baz'] });
  });

  it('ignores an indented line that is not a list item', () => {
    expect(parseYaml('Foo:\n  - Bar\n  not-a-list-item\nBaz:\n  - Qux\n')).toEqual({
      Foo: ['Bar'],
      Baz: ['Qux'],
    });
  });

  it('parses inline scalar values', () => {
    expect(parseYaml('count: 3\nflag: true\nother: false\nname: hello')).toEqual({
      count: 3,
      flag: true,
      other: false,
      name: 'hello',
    });
  });

  it('returns a single-character scalar as-is', () => {
    expect(parseYaml('key: x')).toEqual({ key: 'x' });
  });

  it('trims surrounding whitespace from a scalar value', () => {
    expect(parseYaml('key:   42   ')).toEqual({ key: 42 });
  });

  it('trims surrounding whitespace from a key', () => {
    const result = parseYaml('Foo   : value') as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(['Foo']);
    expect(result.Foo).toBe('value');
  });

  it('parses "null", "", and "~" as the null value', () => {
    expect(parseYaml('null')).toBeNull();
    expect(parseYaml('')).toBeNull();
    expect(parseYaml('~')).toBeNull();
  });

  it('does not treat a string merely containing "null" as null', () => {
    expect(parseYaml('nullish')).toBe('nullish');
    expect(parseYaml('thisisnull')).toBe('thisisnull');
  });

  it('requires the full word for true/false, not just a prefix or suffix', () => {
    expect(parseYaml('key: nottrue')).toEqual({ key: 'nottrue' });
    expect(parseYaml('key: truely')).toEqual({ key: 'truely' });
    expect(parseYaml('key: notfalse')).toEqual({ key: 'notfalse' });
    expect(parseYaml('key: falsey')).toEqual({ key: 'falsey' });
  });

  it('parses decimal numbers', () => {
    expect(parseYaml('key: 3.14')).toEqual({ key: 3.14 });
  });

  it('does not coerce a string merely containing digits into a number', () => {
    expect(parseYaml('key: abc123')).toEqual({ key: 'abc123' });
    expect(parseYaml('key: 123abc')).toEqual({ key: '123abc' });
  });

  it('returns an unterminated quote as a literal string', () => {
    expect(parseYaml('key: "open')).toEqual({ key: '"open' });
    expect(parseYaml("key: 'noclose")).toEqual({ key: "'noclose" });
  });

  it('does not strip a quote character that only appears at one end', () => {
    expect(parseYaml('key: no"')).toEqual({ key: 'no"' });
    expect(parseYaml("key: no'")).toEqual({ key: "no'" });
  });

  it('strips matching double quotes', () => {
    expect(parseYaml('key: "double"')).toEqual({ key: 'double' });
  });

  it('strips matching single quotes', () => {
    expect(parseYaml("key: 'single'")).toEqual({ key: 'single' });
  });

  it('strips quotes from a minimal two-character quoted pair', () => {
    expect(parseYaml('key: ""')).toEqual({ key: '' });
  });

  it('does not strip a lone quote character (too short to be a pair)', () => {
    expect(parseYaml("key: '")).toEqual({ key: "'" });
    expect(parseYaml('key: "')).toEqual({ key: '"' });
  });

  it('sets a key with no value and no list items to null', () => {
    expect(parseYaml('Foo:\n')).toEqual({ Foo: null });
  });

  it('normalizes CRLF line endings', () => {
    expect(parseYaml('Foo:\r\n  - Bar\r\n')).toEqual({ Foo: ['Bar'] });
  });

  it('defers list items when the key line has only trailing whitespace after the colon', () => {
    expect(parseYaml('Foo:    \n  - Bar\n')).toEqual({ Foo: ['Bar'] });
  });

  it('parses a list item with no space after the dash', () => {
    expect(parseYaml('Foo:\n  -NoSpace\n')).toEqual({ Foo: ['NoSpace'] });
  });

  it('does not treat a key line as a list item just because it contains " - " later in the value', () => {
    expect(parseYaml('Prev:\n  - Item\nFoo: bar - baz\n')).toEqual({
      Prev: ['Item'],
      Foo: 'bar - baz',
    });
  });

  it('does not treat an indented, unsupported "key: value" line as a top-level key', () => {
    expect(parseYaml('Foo:\n  - Bar\n  nested: value\n  - Baz\n')).toEqual({
      Foo: ['Bar', 'Baz'],
    });
  });

  it('skips a top-level comment line that contains a colon', () => {
    expect(parseYaml('# threshold: 0.65\nMyTest:\n  - ApexClass:MyClass\n')).toEqual({
      MyTest: ['ApexClass:MyClass'],
    });
  });

  it('skips a top-level comment line without a colon', () => {
    expect(parseYaml('# just a note\nMyTest:\n  - ApexClass:MyClass\n')).toEqual({
      MyTest: ['ApexClass:MyClass'],
    });
  });

  it('strips an inline comment after a key', () => {
    expect(parseYaml('MyTest: # note\n  - ApexClass:MyClass\n')).toEqual({
      MyTest: ['ApexClass:MyClass'],
    });
  });

  it('strips an inline comment after a list item', () => {
    expect(parseYaml('MyTest:\n  - ApexClass:MyClass # note\n')).toEqual({
      MyTest: ['ApexClass:MyClass'],
    });
  });

  it('skips an indented comment inside a block sequence', () => {
    expect(parseYaml('MyTest:\n  # internal comment\n  - ApexClass:MyClass\n')).toEqual({
      MyTest: ['ApexClass:MyClass'],
    });
  });

  it('ignores a leading document marker', () => {
    expect(parseYaml('---\nMyTest:\n  - ApexClass:MyClass\n')).toEqual({
      MyTest: ['ApexClass:MyClass'],
    });
  });
});
