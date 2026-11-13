'use strict';

import { apply } from './apply.js';
import { audit } from './audit.js';
import { list } from './list.js';
import { scan } from './scan.js';
import { Io, MapError, MapOptions } from './types.js';

export const USAGE = `Usage: apex-test-map <scan|apply|audit|list> [options]

Maps Apex classes and triggers to the tests that cover them, writes the
// @Tests: annotations apextestlist reads, and audits them.

Common options:
  --project <dir>                  Folder inside the Salesforce DX project (default:
                                   the cwd); the nearest sfdx-project.json is used
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

list options (the tests sf apextests list would select):
  --manifest <file>                Only classes/triggers in this package.xml
  --ignore-missing-tests           Drop tests that aren't in any package directory
  --filter-by-metadata             Select from .test-dependencies.yml (needs --manifest)
`;

const COMMANDS: Record<string, (opts: MapOptions, io: Io) => Promise<void>> = { scan, apply, audit, list };

export function parseArgs(argv: string[]): MapOptions {
  const hasCommand = argv.length > 0 && !argv[0].startsWith('-');
  const opts: MapOptions = {
    command: hasCommand ? argv[0] : undefined,
    ignore: [],
    only: null,
    maxTests: 10,
    json: false,
    missingOnly: false,
    dryRun: false,
    allowUnknown: false,
    ignoreMissingTests: false,
    filterByMetadata: false,
    help: false,
  };
  for (let i = hasCommand ? 1 : 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new MapError(`Missing value for ${arg}`);
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
      case '--header-template':
        opts.headerTemplate = next();
        break;
      case '--manifest':
        opts.manifest = next();
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
        if (!Number.isFinite(opts.maxTests) || opts.maxTests < 1)
          throw new MapError('--max-tests must be a positive number');
        break;
      case '--json':
        opts.json = true;
        break;
      case '--missing-only':
        opts.missingOnly = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--allow-unknown':
        opts.allowUnknown = true;
        break;
      case '--ignore-missing-tests':
        opts.ignoreMissingTests = true;
        break;
      case '--filter-by-metadata':
        opts.filterByMetadata = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new MapError(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

const defaultIo: Io = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/**
 * Runs apex-test-map with command-line arguments and returns the exit code:
 * 0 on success, 1 when a plan is rejected, 2 for usage or input errors.
 */
export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  try {
    const opts = parseArgs(argv);
    if (opts.help || !opts.command) {
      io.out(USAGE);
      return 0;
    }
    const command = COMMANDS[opts.command];
    if (!command) throw new MapError(`Unknown command "${opts.command}". Use scan, apply, audit, or list.`);
    await command(opts, io);
    return 0;
  } catch (error) {
    if (error instanceof MapError) {
      io.err(error.exitCode === 1 ? `${error.message}\n` : `apex-test-map: ${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  }
}
