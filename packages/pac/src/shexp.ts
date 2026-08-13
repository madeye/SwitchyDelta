/** Shell-expression (glob) to regular-expression translation. */

const REGEXP_META_CHARS: ReadonlySet<number> = new Set(
  Array.from('\\[^$.|?*+(){}/', (c) => c.charCodeAt(0)),
);

const CHAR_SLASH = 47; // /
const CHAR_BACKSLASH = 92; // \
const CHAR_ASTERISK = 42; // *
const CHAR_QUESTION = 63; // ?

/** Patterns longer than this are treated as never-matching. */
export const MAX_REGEXP_SOURCE_LENGTH = 2048;
/** Wildcard patterns longer than this are treated as never-matching. */
export const MAX_SHEXP_LENGTH = 1024;

const NEVER_MATCH = /(?!)/;

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

function escapeRegExpLiteral(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (REGEXP_META_CHARS.has(code)) out += '\\';
    out += text[i];
  }
  return out;
}

/**
 * Translate a shell wildcard pattern into regular expression source.
 *
 * Interior `*` before a literal is emitted as a first-occurrence loop rather
 * than `.*`, so `*a*a*…*b` cannot backtrack quadratically. Leading/trailing
 * `.*` are kept so host-wildcard post-processing (`^` → `(?:^|\.)`, strip
 * `.*$`) still sees the same shape.
 */
export function shExp2RegExp(pattern: string, options?: ShExpOptions): string {
  const trimAsterisk = options?.trimAsterisk ?? false;
  if (pattern.length > MAX_SHEXP_LENGTH) {
    // `^(?!)` survives the host-wildcard first-char replace; `(?!)` is used
    // when anchors are already being dropped (trimAsterisk).
    return trimAsterisk ? '(?!)' : '^(?!)';
  }

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
      while (i + 1 < end && pattern.charCodeAt(i + 1) === CHAR_ASTERISK) i++;
      let j = i + 1;
      while (j < end) {
        const next = pattern.charCodeAt(j);
        if (next === CHAR_ASTERISK || next === CHAR_QUESTION) break;
        j++;
      }
      if (j > i + 1) {
        const lit = escapeRegExpLiteral(pattern.substring(i + 1, j));
        regex += `(?:(?!${lit}).)*${lit}`;
        i = j - 1;
      } else {
        regex += '.*';
      }
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
 * when the source is invalid, too long, or uses nested/catastrophic
 * quantifiers. User-authored patterns reach this directly.
 */
export function safeRegExp(source: string): RegExp {
  if (source.length > MAX_REGEXP_SOURCE_LENGTH || hasCatastrophicConstruct(source)) {
    return NEVER_MATCH;
  }
  try {
    return new RegExp(source);
  } catch {
    return NEVER_MATCH;
  }
}

/**
 * True when `source` has nested unbounded quantifiers, a quantified empty
 * alternative, or overlapping alternatives under an unbounded quantifier
 * (e.g. `(a+)+`, `(a|)*`, `(a|ab)+`).
 */
function hasCatastrophicConstruct(source: string): boolean {
  let i = 0;
  let unsafe = false;

  const peek = (): string => source[i] ?? '';

  const parseQuantifier = (): { unbounded: boolean } | null => {
    const c = peek();
    if (c === '*' || c === '+') {
      i++;
      if (peek() === '?') i++;
      return { unbounded: true };
    }
    if (c === '?') {
      i++;
      if (peek() === '?') i++;
      return { unbounded: false };
    }
    if (c === '{') {
      const start = i;
      i++;
      while (i < source.length && source[i] !== '}') i++;
      if (i >= source.length) {
        i = start;
        return null;
      }
      const body = source.slice(start + 1, i);
      i++;
      if (peek() === '?') i++;
      const comma = body.indexOf(',');
      if (comma < 0) return { unbounded: false };
      if (comma === body.length - 1) return { unbounded: true };
      const min = Number(body.slice(0, comma));
      const max = Number(body.slice(comma + 1));
      if (Number.isFinite(min) && Number.isFinite(max) && max - min >= 64) {
        return { unbounded: true };
      }
      return { unbounded: false };
    }
    return null;
  };

  const parseClass = (): void => {
    i++;
    if (peek() === '^') i++;
    if (peek() === ']') i++;
    while (i < source.length) {
      const c = source[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === ']') {
        i++;
        return;
      }
      i++;
    }
  };

  const parseGroupKind = (): void => {
    if (peek() !== '?') return;
    i++;
    const c = peek();
    if (c === ':' || c === '=' || c === '!') {
      i++;
      return;
    }
    if (c === '<') {
      i++;
      const d = peek();
      if (d === '=' || d === '!') {
        i++;
        return;
      }
      while (i < source.length && source[i] !== '>') i++;
      if (peek() === '>') i++;
    }
  };

  const parseAlternation = (endAt: ')' | ''): { hasQuantifier: boolean; alts: string[] } => {
    const alts: string[] = [];
    let altStart = i;
    let hasQuantifier = false;

    const finishAlt = (): void => {
      alts.push(source.slice(altStart, i));
    };

    while (i < source.length) {
      const c = source[i]!;
      if (endAt === ')' && c === ')') break;
      if (c === '|') {
        finishAlt();
        i++;
        altStart = i;
        continue;
      }
      if (c === '\\') {
        i += 2;
        const q = parseQuantifier();
        if (q) hasQuantifier = true;
        continue;
      }
      if (c === '[') {
        parseClass();
        const q = parseQuantifier();
        if (q) hasQuantifier = true;
        continue;
      }
      if (c === '(') {
        i++;
        parseGroupKind();
        const inner = parseAlternation(')');
        if (peek() === ')') i++;
        const q = parseQuantifier();
        if (inner.hasQuantifier) hasQuantifier = true;
        if (q) {
          hasQuantifier = true;
          if (q.unbounded && inner.hasQuantifier) unsafe = true;
          if (q.unbounded && inner.alts.some((alt) => alt.length === 0)) unsafe = true;
          if (q.unbounded && inner.alts.length > 1 && altsOverlap(inner.alts)) unsafe = true;
        }
        continue;
      }
      i++;
      const q = parseQuantifier();
      if (q) hasQuantifier = true;
    }
    finishAlt();
    return { hasQuantifier, alts };
  };

  parseAlternation('');
  return unsafe;
}

function altsOverlap(alts: string[]): boolean {
  for (let i = 0; i < alts.length; i++) {
    const a = alts[i]!;
    if (a.length === 0) continue;
    for (let j = 0; j < alts.length; j++) {
      if (i === j) continue;
      const b = alts[j]!;
      if (b.length === 0) continue;
      if (b.startsWith(a) || a.startsWith(b)) return true;
    }
  }
  return false;
}
