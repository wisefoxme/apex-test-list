'use strict';

export type SfdxProject = {
  packageDirectories: Array<{ path: string }>;
};

export type SearchResult = {
  classes: string[];
  testSuites: string[];
  warnings: string[];
};

export type ApextestsListResult = {
  tests: string[];
  command: string;
  manifestHasApex: boolean;
};

export type ListTestsOptions = {
  format?: string;
  manifest?: string;
  ignoreMissingTests?: boolean;
  ignoreDirs?: string[];
  noWarnings?: boolean;
  filterByMetadata?: boolean;
  warn?: (msg: string) => void;
  /** Folder inside the Salesforce DX project; defaults to the current working directory. */
  projectDir?: string;
};

export type TestMetadataMap = Record<string, string[]>;
