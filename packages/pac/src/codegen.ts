/**
 * Minimal JavaScript code emitter for generated PAC scripts.
 *
 * This replaces the UglifyJS 2 AST that the CoffeeScript implementation used to
 * build, compress and mangle. Because we control every byte of the generated
 * output we can emit already-compact code directly, which makes a
 * general-purpose minifier unnecessary and removes uglify-js (1.4 MB) from the
 * extension entirely.
 *
 * Expressions carry their precedence so parentheses are inserted only where
 * they are actually required.
 */

export const Prec = {
  Lowest: 0,
  Conditional: 3,
  LogicalOr: 4,
  LogicalAnd: 5,
  Equality: 9,
  Relational: 10,
  Additive: 12,
  Multiplicative: 13,
  Unary: 15,
  Call: 17,
  Member: 18,
  Primary: 20,
} as const;

export interface Expr {
  readonly code: string;
  readonly prec: number;
}

const BINARY_PREC: Record<string, number> = {
  '||': Prec.LogicalOr,
  '&&': Prec.LogicalAnd,
  '===': Prec.Equality,
  '!==': Prec.Equality,
  '==': Prec.Equality,
  '!=': Prec.Equality,
  '<': Prec.Relational,
  '<=': Prec.Relational,
  '>': Prec.Relational,
  '>=': Prec.Relational,
  '+': Prec.Additive,
  '-': Prec.Additive,
  '*': Prec.Multiplicative,
  '/': Prec.Multiplicative,
  '%': Prec.Multiplicative,
};

/** Wrap `e` in parentheses when its precedence is looser than `min`. */
function paren(e: Expr, min: number): string {
  return e.prec < min ? `(${e.code})` : e.code;
}

export function raw(code: string, prec: number = Prec.Primary): Expr {
  return { code, prec };
}

/**
 * Emit a JavaScript string literal containing only printable ASCII.
 *
 * PAC scripts are handed to the browser's proxy resolver as bytes with no
 * declared encoding, so every non-ASCII character is escaped. This folds in the
 * separate `ascii()` post-processing pass the old generator needed.
 */
export function str(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    switch (c) {
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += '\\\\';
        break;
      case 0x0a:
        out += '\\n';
        break;
      case 0x0d:
        out += '\\r';
        break;
      case 0x09:
        out += '\\t';
        break;
      default:
        if (c < 0x20 || c > 0x7e) {
          out += '\\u' + c.toString(16).padStart(4, '0');
        } else {
          out += value[i];
        }
    }
  }
  return out + '"';
}

export function string(value: string): Expr {
  return raw(str(value));
}

export function num(value: number): Expr {
  // Negative literals are wrapped so that `a-` + `-1` cannot glue into the
  // decrement operator `--`. Primary prec keeps the parens in place.
  return value < 0 ? raw(`(${String(value)})`, Prec.Primary) : raw(String(value));
}

export const TRUE: Expr = raw('true');
export const FALSE: Expr = raw('false');

export function bool(value: boolean): Expr {
  return value ? TRUE : FALSE;
}

export function ref(name: string): Expr {
  return raw(name);
}

/** A regular expression literal. Source is assumed slash-escaped already. */
export function regexp(re: RegExp): Expr {
  const source = re.source === '' ? '(?:)' : re.source;
  return raw(`/${source}/${re.flags}`);
}

export function member(object: Expr, property: string): Expr {
  return raw(`${paren(object, Prec.Member)}.${property}`, Prec.Member);
}

export function index(object: Expr, property: Expr): Expr {
  return raw(`${paren(object, Prec.Member)}[${property.code}]`, Prec.Member);
}

export function call(callee: Expr, args: Expr[] = []): Expr {
  const list = args.map((a) => a.code).join(',');
  return raw(`${paren(callee, Prec.Call)}(${list})`, Prec.Call);
}

export function construct(callee: Expr, args: Expr[] = []): Expr {
  const list = args.map((a) => a.code).join(',');
  return raw(`new ${paren(callee, Prec.Member)}(${list})`, Prec.Call);
}

export function binary(op: string, left: Expr, right: Expr): Expr {
  const prec = BINARY_PREC[op];
  if (prec === undefined) throw new Error(`Unsupported operator: ${op}`);
  // Left-associative: the right operand needs tighter binding to stay unwrapped.
  return raw(`${paren(left, prec)}${op}${paren(right, prec + 1)}`, prec);
}

export function unary(op: string, operand: Expr): Expr {
  // Word operators such as `typeof` need a separating space.
  const sep = /[a-z]$/.test(op) ? ' ' : '';
  return raw(`${op}${sep}${paren(operand, Prec.Unary)}`, Prec.Unary);
}

export function conditional(test: Expr, consequent: Expr, alternate: Expr): Expr {
  return raw(
    `${paren(test, Prec.Conditional + 1)}?${paren(consequent, Prec.Conditional)}:${paren(
      alternate,
      Prec.Conditional,
    )}`,
    Prec.Conditional,
  );
}

/**
 * A function expression. `body` is raw statement text.
 *
 * Precedence is reported as Lowest so that any use in expression position gets
 * parenthesised, which also keeps it out of statement-start position where it
 * would be parsed as a declaration.
 */
export function func(params: string[], body: string): Expr {
  return raw(`function(${params.join(',')}){${body}}`, Prec.Lowest);
}

// --- Statements -------------------------------------------------------------

export function ret(value: Expr): string {
  return `return ${value.code};`;
}

export function ifThen(test: Expr, consequent: string): string {
  return `if(${test.code}){${consequent}}`;
}

export function varDecl(name: string, value: Expr): string {
  return `var ${name}=${value.code};`;
}

export function exprStmt(value: Expr): string {
  return `${value.code};`;
}

export function doWhile(body: string, test: Expr): string {
  return `do{${body}}while(${test.code});`;
}

/**
 * A switch statement. A case with `test: null` is emitted as `default`.
 */
export function switchStmt(
  discriminant: Expr,
  cases: Array<{ test: Expr | null; body: string }>,
): string {
  const body = cases
    .map((c) => (c.test === null ? `default:${c.body}` : `case ${c.test.code}:${c.body}`))
    .join('');
  return `switch(${discriminant.code}){${body}}`;
}

// --- Convenience builders used across condition/profile compilation ---------

/** `subject.test(/regexp/)` — i.e. `/regexp/.test(subject)`. */
export function regexTest(subject: string, re: RegExp): Expr {
  return call(member(regexp(re), 'test'), [ref(subject)]);
}

/** `a && b && ...`, collapsing the trivial cases. */
export function and(parts: Expr[]): Expr {
  if (parts.length === 0) return TRUE;
  return parts.reduce((acc, p) => binary('&&', acc, p));
}

/** `a || b || ...`, collapsing the trivial cases. */
export function or(parts: Expr[]): Expr {
  if (parts.length === 0) return FALSE;
  return parts.reduce((acc, p) => binary('||', acc, p));
}
