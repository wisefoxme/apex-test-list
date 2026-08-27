'use strict';

/**
 * Minimal in-house XML parser. Handles the narrow subset of well-formed XML
 * used by Salesforce metadata files consumed by this plugin (package
 * manifests and test suite files): nested elements, comments, processing
 * instructions, self-closing tags, and basic entity-decoded text content.
 */

export interface XmlElement {
  name: string;
  children: XmlElement[];
  text: string;
}

// The tag alternative has no separate "whitespace before attributes" check:
// [^<>]* already includes whitespace, so an optional leading \s would only
// ever be satisfied via a redundant backtrack into the tag-name class.
const TOKEN_REGEX = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/?[a-zA-Z_][\w.:-]*[^<>]*\/?>/g;
// Stryker disable next-line Regex: TAG_NAME_REGEX only ever runs on a `token`
// that is itself a full TOKEN_REGEX match, which always starts with '<' and
// (once comments/PIs are excluded above) can never contain another '<', so
// the leading '^' anchor can never change which substring matches.
const TAG_NAME_REGEX = /^<\/?([a-zA-Z_][\w.:-]*)/;

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function parseXml(xml: string): XmlElement {
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const pushText = (raw: string): void => {
    if (!raw.trim() || stack.length === 0) return;
    stack[stack.length - 1].text += decodeEntities(raw);
  };

  TOKEN_REGEX.lastIndex = 0;
  while ((match = TOKEN_REGEX.exec(xml)) !== null) {
    pushText(xml.slice(lastIndex, match.index));
    lastIndex = TOKEN_REGEX.lastIndex;

    const token = match[0];
    if (token.startsWith('<!--') || token.startsWith('<?')) {
      continue;
    }

    // TOKEN_REGEX already constrains every non-comment/PI token to this exact
    // tag-name pattern, so the exec() below is guaranteed to match.
    const name = TAG_NAME_REGEX.exec(token)![1];

    if (token.startsWith('</')) {
      const current = stack.pop();
      if (!current || current.name !== name) {
        throw new Error(`Invalid XML: mismatched closing tag "${token}"`);
      }
      // Stryker disable next-line ConditionalExpression: in well-formed,
      // single-root XML the true root's own closing/self-closing token is
      // always the last one processed, so it always overwrites any earlier,
      // premature assignment here regardless of this guard.
      if (stack.length === 0) {
        root = current;
      }
      continue;
    }

    const element: XmlElement = { name, children: [], text: '' };
    if (stack.length > 0) {
      stack[stack.length - 1].children.push(element);
    }

    if (token.endsWith('/>')) {
      // Stryker disable next-line ConditionalExpression: same reasoning as the
      // closing-tag branch above — the last root-setting assignment always wins.
      if (stack.length === 0) root = element;
    } else {
      stack.push(element);
    }
  }

  if (stack.length > 0) {
    throw new Error(`Invalid XML: unclosed tag "<${stack[stack.length - 1].name}>"`);
  }
  if (!root) {
    throw new Error('Invalid XML: no root element found');
  }

  return root;
}

export function findChildren(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((child) => child.name === name);
}

export function findChild(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((child) => child.name === name);
}
