'use strict';

/**
 * Minimal in-house YAML parser covering the narrow subset used by this
 * plugin's test-metadata-dependencies file: a flat mapping of scalar keys
 * to either a scalar value or a block sequence of scalars. Not a general
 * YAML implementation.
 */

function parseScalar(raw: string): unknown {
  const text = raw.trim();

  if (text === '' || text === '~' || /^null$/i.test(text)) return null;
  if (/^true$/i.test(text)) return true;
  if (/^false$/i.test(text)) return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
  ) {
    return text.slice(1, -1);
  }

  return text;
}

// No trailing $: rawLine is always a single line (already split on '\n'), and
// `.` never matches '\n', so `(.*)` already extends to the end of the string.
const TOP_LEVEL_KEY_REGEX = /^(\S[^:]*):\s*(.*)/;
const LIST_ITEM_REGEX = /^[ \t]+-\s?(.*)/;

/**
 * Strip a YAML line comment (` #` through end-of-string) from a raw value
 * fragment, but do not truncate a `#` that appears inside a quoted string.
 */
function stripInlineComment(raw: string): string {
  // If the value is a quoted string, leave it untouched.
  const trimmed = raw.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return raw;
  }
  // Remove ` #...` (space + hash) or a leading `#` (whole value is a comment).
  const commentIdx = raw.search(/(^|\s)#/);
  return commentIdx === -1 ? raw : raw.slice(0, commentIdx).trimEnd();
}

export function parseYaml(content: string): unknown {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentList: unknown[] | null = null;
  let sawKey = false;

  const commitPending = (): void => {
    if (currentKey !== null) {
      result[currentKey] = currentList ?? null;
    }
    currentKey = null;
    currentList = null;
  };

  // A blank (or whitespace-only) line matches neither LIST_ITEM_REGEX (no
  // dash) nor TOP_LEVEL_KEY_REGEX (no non-whitespace first character), so it
  // is already skipped by the "not a key, not a list item" fallthrough below
  // — no separate blank-line check needed.
  for (const rawLine of lines) {
    // Skip comment-only lines (first non-whitespace character is `#`).
    if (/^\s*#/.test(rawLine)) {
      continue;
    }

    // Skip YAML document markers.
    if (/^---/.test(rawLine)) {
      continue;
    }

    const listMatch = LIST_ITEM_REGEX.exec(rawLine);
    // Stryker disable next-line ConditionalExpression: commitPending() always
    // resets currentList before a new key can pick it up, so a list item seen
    // while currentKey is null can never leak into the result either way.
    if (listMatch && currentKey !== null) {
      currentList = currentList ?? [];
      currentList.push(parseScalar(stripInlineComment(listMatch[1])));
      continue;
    }

    // A line indented with space/tab can never match TOP_LEVEL_KEY_REGEX below
    // (it requires a non-whitespace first character), so it already falls
    // through to the "not a key" branch on its own — no separate guard needed.

    const keyMatch = TOP_LEVEL_KEY_REGEX.exec(rawLine);
    if (!keyMatch) {
      continue;
    }

    commitPending();
    sawKey = true;
    const key = keyMatch[1].trim();
    const inline = stripInlineComment(keyMatch[2]);

    // TOP_LEVEL_KEY_REGEX's `\s*` already consumes any whitespace right after
    // the colon, so `inline` can never be non-empty and whitespace-only.
    if (inline.trim()) {
      result[key] = parseScalar(inline);
    } else {
      currentKey = key;
    }
  }

  commitPending();

  // parseScalar() trims internally, so pre-trimming content here is redundant.
  return sawKey ? result : parseScalar(content);
}
