'use strict';

import { readFile } from 'node:fs/promises';

import { stripBom } from './project.js';
import { MapError } from './types.js';

export type HeaderTemplate = { lines: string[]; type: 'block' | 'line' };

export type TemplateValues = { name: string; kind: string; tests: string; suites: string };

const TEMPLATE_PLACEHOLDERS = new Set(['name', 'kind', 'tests', 'suites']);

function checkTemplate(lines: string[]): { problems: string[]; type: HeaderTemplate['type'] | null } {
  const problems: string[] = [];
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

  const checkLine = (placeholder: string, label: string, required: boolean): void => {
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
  return { problems, type };
}

/**
 * Reads and checks a header template: comment lines only, `{{tests}}` (and the
 * optional `{{suites}}`) alone at the end of an `@Tests:` / `@TestSuites:` line,
 * so apextestlist reads the names and nothing after them.
 */
export async function loadTemplate(file: string): Promise<HeaderTemplate> {
  let raw: string;
  try {
    raw = stripBom(await readFile(file, 'utf8'));
  } catch (error) {
    throw new MapError(`Cannot read header template ${file}: ${(error as Error).message}`, { cause: error });
  }
  const lines = raw.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const { problems, type } = checkTemplate(lines);
  if (problems.length || !type) throw new MapError(`Header template ${file} has problems:\n  ${problems.join('\n  ')}`);
  return { lines, type };
}

export function renderTemplate(template: HeaderTemplate, values: TemplateValues, eol: string): string {
  const out: string[] = [];
  for (const line of template.lines) {
    // Leave out an annotation line with nothing to list; an empty @Tests: would add a blank test name.
    if (line.includes('{{tests}}') && !values.tests) continue;
    if (line.includes('{{suites}}') && !values.suites) continue;
    out.push(line.replace(/\{\{(name|kind|tests|suites)\}\}/g, (_, key: keyof TemplateValues) => values[key]));
  }
  return out.join(eol) + eol;
}
