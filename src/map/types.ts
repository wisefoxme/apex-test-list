'use strict';

/** Where apex-test-map writes its output; the bin passes process.stdout/stderr. */
export type Io = {
  out: (text: string) => void;
  err: (text: string) => void;
};

export type MapOptions = {
  command?: string;
  /** Folder inside the Salesforce DX project; defaults to the current working directory. */
  project: string;
  ignore: string[];
  coverage?: string;
  plan?: string;
  only: Set<string> | null;
  maxTests: number;
  json: boolean;
  missingOnly: boolean;
  dryRun: boolean;
  allowUnknown: boolean;
  headerTemplate?: string;
  manifest?: string;
  ignoreMissingTests: boolean;
  filterByMetadata: boolean;
  help: boolean;
};

/** An error apex-test-map reports to the user and exits with. */
export class MapError extends Error {
  public readonly exitCode: number;

  public constructor(message: string, options: { exitCode?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'MapError';
    this.exitCode = options.exitCode ?? 2;
  }
}

export type ApexKind = 'class' | 'trigger';

export type ApexFile = {
  name: string;
  kind: ApexKind;
  /** Path relative to the project root, with forward slashes. */
  file: string;
  path: string;
  isTest: boolean;
  tests: string[];
  suites: string[];
  /** Lowercased identifiers in the code, without comments and strings. */
  tokens: Set<string>;
  sObject?: string;
  hasDml: boolean;
};

export type Suite = {
  name: string;
  file: string;
  classes: string[];
  error?: string;
};

export type Project = {
  root: string;
  pkgDirs: string[];
  apex: ApexFile[];
  suites: Suite[];
  tests: ApexFile[];
  testsByLower: Map<string, ApexFile>;
  classesByLower: Map<string, ApexFile>;
};

/** Lowercased class or trigger name → names of the test classes that covered it. */
export type Coverage = Map<string, Set<string>>;
