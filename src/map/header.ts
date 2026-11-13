'use strict';

import { TEST_NAME_REGEX, TEST_SUITE_NAME_REGEX } from '../utils/constants.js';
import { parseAnnotation } from './project.js';
import { HeaderTemplate, renderTemplate } from './template.js';
import { ApexFile } from './types.js';

export type AnnotationLabel = '@Tests' | '@TestSuites';

export type Insert = { label: AnnotationLabel; names: string[] };

export type Header = { type: 'block' | 'line'; start: number; end: number; close?: number };

const ANNOTATION_LINE_PREFIX = /^[ \t]*(\/\/|\*)[ \t]*$/;

function joinNames(names: string[]): string {
  return names.join(', ');
}

function annotationLines(prefix: string, inserts: Insert[], eol: string): string {
  return inserts.map((i) => `${prefix}${i.label}: ${joinNames(i.names)}${eol}`).join('');
}

/**
 * Adds names to the first existing annotation of this kind. When the file has
 * none, returns the names as `pending` so the caller can insert a new line.
 */
export function mergeExisting(
  content: string,
  label: AnnotationLabel,
  names: string[],
): { content: string; added: string[]; pending: string[] } {
  const regex = label === '@Tests' ? TEST_NAME_REGEX : TEST_SUITE_NAME_REGEX;
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
  const trailing = /[\s*]*$/.exec(captured)?.[0] ?? '';
  const start = first.index + first[0].length - captured.length;
  const merged = joinNames([...existing, ...added]);
  // Later lines of the same annotation are still read by apextestlist; their names are now on the first line too.
  return {
    content: content.slice(0, start) + merged + trailing + content.slice(start + captured.length),
    added,
    pending: [],
  };
}

/** Finds a leading `/* ... *\/` or `//` comment block before any code. */
export function findLeadingHeader(content: string): Header | null {
  const lead = /^\s*/.exec(content)?.[0].length ?? 0;
  const lineStart = content.lastIndexOf('\n', lead - 1) + 1;
  if (content.startsWith('/*', lead)) {
    const close = content.indexOf('*/', lead + 2);
    if (close === -1) return null;
    return { type: 'block', start: lead, end: close + 2, close };
  }
  if (content.startsWith('//', lead)) {
    const match = /^(?:[ \t]*\/\/[^\n]*(?:\n|$))+/.exec(content.slice(lineStart));
    return { type: 'line', start: lead, end: lineStart + (match?.[0].length ?? 0) };
  }
  return null;
}

/** Inserts annotation lines inside an existing header; returns null if the header can't take them cleanly. */
function insertIntoHeader(content: string, header: Header, inserts: Insert[], eol: string): string | null {
  if (header.type === 'line') {
    const atEnd = header.end === content.length && !content.endsWith('\n');
    const insertion = (atEnd ? eol : '') + annotationLines('// ', inserts, eol);
    return content.slice(0, header.end) + insertion + content.slice(header.end);
  }
  const close = header.close ?? header.end - 2;
  const closeLineStart = content.lastIndexOf('\n', close - 1) + 1;
  // A one-line block, or text before `*/` on its closing line, has no clean place for a new line.
  if (closeLineStart <= header.start || content.slice(closeLineStart, close).trim()) return null;
  const prevLineStart = content.lastIndexOf('\n', closeLineStart - 2) + 1;
  const prevPrefix = /^([ \t]*\*)(?!\/)/.exec(content.slice(prevLineStart, closeLineStart));
  const prefix = prevPrefix ? `${prevPrefix[1]} ` : `${content.slice(closeLineStart, close)}* `;
  return content.slice(0, closeLineStart) + annotationLines(prefix, inserts, eol) + content.slice(closeLineStart);
}

/** Inserts the lines after an existing @Tests or @TestSuites comment line, using the same prefix. */
function insertNextToAnnotation(content: string, inserts: Insert[], eol: string): string | null {
  const match = /@(tests|testsuites)\s*:/i.exec(content);
  if (!match) return null;
  const lineStart = content.lastIndexOf('\n', match.index - 1) + 1;
  const prefix = content.slice(lineStart, match.index);
  if (!ANNOTATION_LINE_PREFIX.test(prefix)) return null;
  const lineEnd = content.indexOf('\n', match.index);
  const insertAt = lineEnd === -1 ? content.length : lineEnd + 1;
  const lead = lineEnd === -1 ? eol : '';
  return content.slice(0, insertAt) + lead + annotationLines(prefix, inserts, eol) + content.slice(insertAt);
}

/**
 * Adds annotation lines a file doesn't have yet: next to an existing annotation,
 * inside the file's header (with a template), as the whole template for a file
 * without a header, or otherwise as `//` lines at the top.
 */
export function insertAnnotations(
  content: string,
  inserts: Insert[],
  eol: string,
  template: HeaderTemplate | null,
  target: Pick<ApexFile, 'name' | 'kind'>,
): string {
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
  return annotationLines('// ', inserts, eol) + content;
}
