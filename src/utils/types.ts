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
};

export type TestMetadataMap = Record<string, string[]>;
