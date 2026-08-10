/** Shell-expression (glob) to regular-expression translation. */

const REGEXP_META_CHARS: ReadonlySet<number> = new Set(
  Array.from('\\[^$.|?*+(){}/', (c) => c.charCodeAt(0)),
);

const CHAR_SLASH = 47; // /
const CHAR_BACKSLASH = 92; // \
const CHAR_ASTERISK = 42; // *
const CHAR_QUESTION = 63; // ?

/**
 * Escape forward slashes that are not already escaped, so the pattern is safe
 * to embed in a `/.../` regular expression literal.
 */
export function escapeSlash(pattern: string): string {
  let escaped = false;
  let start = 0;
  let result = '';
  for (let i = 0; i < pattern.length; i++) {
    const code = pattern.charCodeAt(i);
    if (code === CHAR_SLASH && !escaped) {
      result += pattern.substring(start, i);
      result += '\\';
      start = i;
    }
    escaped = code === CHAR_BACKSLASH && !escaped;
  }
  return result + pattern.substring(start);
}

export interface ShExpOptions {
  /**
   * Strip leading and trailing asterisks and drop the corresponding `^`/`$`
   * anchors, yielding a substring match.
   */
  trimAsterisk?: boolean;
}

/** Translate a shell wildcard pattern into regular expression source. */
export function shExp2RegExp(pattern: string, options?: ShExpOptions): string {
  const trimAsterisk = options?.trimAsterisk ?? false;
  let start = 0;
  let end = pattern.length;

  if (trimAsterisk) {
    while (start < end && pattern.charCodeAt(start) === CHAR_ASTERISK) start++;
    while (start < end && pattern.charCodeAt(end - 1) === CHAR_ASTERISK) end--;
    if (end - start === 1 && pattern.charCodeAt(start) === CHAR_ASTERISK) {
      return '';
    }
  }

  let regex = start === 0 ? '^' : '';
  for (let i = start; i < end; i++) {
    const code = pattern.charCodeAt(i);
    if (code === CHAR_ASTERISK) {
      regex += '.*';
    } else if (code === CHAR_QUESTION) {
      regex += '.';
    } else {
      if (REGEXP_META_CHARS.has(code)) regex += '\\';
      regex += pattern[i];
    }
  }
  if (end === pattern.length) regex += '$';

  return regex;
}

/**
 * Compile a regular expression, falling back to a never-matching expression
 * when the source is invalid. User-authored patterns reach this directly.
 */
export function safeRegExp(source: string): RegExp {
  try {
    return new RegExp(source);
  } catch {
    return /(?!)/;
  }
}
