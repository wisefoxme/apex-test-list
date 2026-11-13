'use strict';

import { parseAnnotation } from './project.js';
import { HeaderTemplate, renderTemplate } from './template.js';
import { ApexFile } from './types.js';

export type AnnotationLabel = '@Tests' | '@TestSuites';

export type Insert = { label: AnnotationLabel; names: string[] };

/** A block header ends at its `*\/` (`close`); a line header ends after its last `//` line (`end`). */
export type Header = { type: 'block'; start: number; close: number } | { type: 'line'; start: number; end: number };

const ANNOTATION_LINE_PREFIX = /^[ \t]*(\/\/|\*)[ \t]*$/;

const LEADING_LINE_COMMENTS = /^\s*(?:[ \t]*\/\/[^\n]*(?:\n|$))+/;

function joinNames(names: string[]): string {
  return names.join(', ');
}

function annotationLines(prefix: string, inserts: Insert[], eol: string): string {
  return inserts.map((i) => `${prefix}${i.label}: ${joinNames(i.names)}${eol}`).join('');
}

/**
 * Adds names to the first existing annotation that `regex` finds. When the file
 * has none, returns the new names as `pending` so the caller can insert a line.
 */
export function mergeExisting(
  content: string,
  regex: RegExp,
  names: string[],
): { content: string; added: string[]; pending: string[] } {
  const existing = parseAnnotation(content, regex);
  const seen = new Set(existing.map((n) => n.toLowerCase()));
  const added = names.filter((n) => {
    const key = n.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Nothing new: leave the annotation exactly as written, even if it isn't comma-separated.
  if (!added.length) return { content, added, pending: [] };

  const first = new RegExp(regex.source, 'i').exec(content);
  if (!first) return { content, added, pending: added };
  const captured = first[1];
  const trailing = captured.slice(captured.replace(/[\s*]+$/, '').length);
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
  const start = content.length - content.trimStart().length;
  if (content.startsWith('/*', start)) {
    // Search after the opening `/*`, so `/*/` doesn't count as a close.
    const close = content.indexOf('*/', start + 2);
    return close === -1 ? null : { type: 'block', start, close };
  }
  const lines = LEADING_LINE_COMMENTS.exec(content);
  return lines ? { type: 'line', start, end: lines[0].length } : null;
}

/** Whether a position falls inside the header comment. */
export function isInHeader(header: Header, position: number): boolean {
  return position < (header.type === 'block' ? header.close : header.end);
}

/** Inserts annotation lines inside an existing header; returns null if the header can't take them cleanly. */
function insertIntoHeader(content: string, header: Header, inserts: Insert[], eol: string): string | null {
  if (header.type === 'line') {
    // A file that ends inside its comment block needs a line break before the new lines.
    const needsBreak = !content.slice(0, header.end).endsWith('\n');
    const insertion = (needsBreak ? eol : '') + annotationLines('// ', inserts, eol);
    return content.slice(0, header.end) + insertion + content.slice(header.end);
  }
  const closeLineStart = content.lastIndexOf('\n', header.close) + 1;
  // Text before `*/` on its line (including a one-line `/* ... */`) leaves no clean place for a new line.
  if (content.slice(closeLineStart, header.close).trim()) return null;
  const prevLine = content.slice(content.lastIndexOf('\n', closeLineStart - 2) + 1, closeLineStart);
  const prevPrefix = /^([ \t]*\*)(?!\/)/.exec(prevLine);
  const prefix = prevPrefix ? `${prevPrefix[1]} ` : `${content.slice(closeLineStart, header.close)}* `;
  return content.slice(0, closeLineStart) + annotationLines(prefix, inserts, eol) + content.slice(closeLineStart);
}

/** Inserts the lines after an existing @Tests or @TestSuites comment line, using the same prefix. */
function insertNextToAnnotation(content: string, inserts: Insert[], eol: string): string | null {
  const match = /@(tests|testsuites)\s*:/i.exec(content);
  if (!match) return null;
  const prefix = content.slice(content.lastIndexOf('\n', match.index) + 1, match.index);
  if (!ANNOTATION_LINE_PREFIX.test(prefix)) return null;
  const lineEnd = content.indexOf('\n', match.index);
  if (lineEnd === -1) return `${content}${eol}${annotationLines(prefix, inserts, eol)}`;
  return content.slice(0, lineEnd + 1) + annotationLines(prefix, inserts, eol) + content.slice(lineEnd + 1);
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
    if (!header) {
      const values = { name: target.name, kind: target.kind, tests: '', suites: '' };
      for (const i of inserts) values[i.label === '@Tests' ? 'tests' : 'suites'] = joinNames(i.names);
      return renderTemplate(template, values, eol) + content;
    }
    const inHeader = insertIntoHeader(content, header, inserts, eol);
    if (inHeader !== null) return inHeader;
  }
  return annotationLines('// ', inserts, eol) + content;
}
