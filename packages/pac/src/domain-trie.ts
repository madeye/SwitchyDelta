/**
 * Domain label trie for host wildcard matching.
 *
 * Ported from meow-rs `meow-trie::DomainTrie` (reverse-label prefix tree).
 *
 * Pattern forms on insert:
 *   example.com    exact host
 *   *.example.com  one label under example.com
 *   .example.com   one or more labels under example.com
 *   +.example.com  one or more labels (star + dot), not the apex
 *
 * Labels are matched from the TLD leftward. Values are first-insert-wins;
 * `searchMin` folds the minimum value across all matching patterns, which for
 * rule indices yields the earliest matching rule.
 */

const CHAR_DOT = 46;

interface TrieNode<V> {
  children: Map<string, TrieNode<V>>;
  exact: V | undefined;
  star: V | undefined;
  dot: V | undefined;
}

type NodeKind = 'exact' | 'star' | 'dot';

function newNode<V>(): TrieNode<V> {
  return { children: new Map(), exact: undefined, star: undefined, dot: undefined };
}

export class DomainTrie<V> {
  #root: TrieNode<V> = newNode<V>();
  #size = 0;

  isEmpty(): boolean {
    return this.#size === 0;
  }

  size(): number {
    return this.#size;
  }

  /**
   * Insert a pattern. Returns false when the pattern is empty or degenerate,
   * in which case the caller must keep the rule on the linear match path.
   */
  insert(domain: string | null | undefined, data: V): boolean {
    const pattern = (domain ?? '').trim().toLowerCase();
    if (pattern.length === 0) return false;

    if (pattern.startsWith('+.')) {
      const rest = pattern.substring(2);
      if (rest.length === 0) return false;
      this.#insertInto(rest, data, 'star');
      this.#insertInto(rest, data, 'dot');
      this.#size += 2;
      return true;
    }

    if (pattern.startsWith('*.')) {
      const rest = pattern.substring(2);
      if (rest.length === 0) return false;
      this.#insertInto(rest, data, 'star');
      this.#size += 1;
      return true;
    }

    if (pattern.charCodeAt(0) === CHAR_DOT) {
      const rest = pattern.substring(1);
      if (rest.length === 0) return false;
      this.#insertInto(rest, data, 'dot');
      this.#size += 1;
      return true;
    }

    this.#insertInto(pattern, data, 'exact');
    this.#size += 1;
    return true;
  }

  #insertInto(baseDomain: string, value: V, kind: NodeKind): void {
    let node = this.#root;
    const labels = baseDomain.split('.');
    // Walk TLD -> subdomain.
    for (let i = labels.length - 1; i >= 0; i--) {
      const label = labels[i]!;
      if (label.length === 0) continue;
      let child = node.children.get(label);
      if (child === undefined) {
        child = newNode<V>();
        node.children.set(label, child);
      }
      node = child;
    }
    if (node[kind] === undefined) {
      node[kind] = value;
    }
  }

  /** Most-specific match: exact beats star beats a deeper dot. */
  search(domain: string): V | undefined {
    if (this.#size === 0) return undefined;
    const query = normalizeQuery(domain);
    if (query === null) return undefined;

    const labels = query.split('.');
    const n = labels.length;
    let node = this.#root;
    let best: V | undefined;

    for (let d = 0; d < n; d++) {
      const child = node.children.get(labels[n - 1 - d]!);
      if (child === undefined) break;
      node = child;
      const remaining = n - d - 1;
      if (remaining === 0) {
        if (node.exact !== undefined) return node.exact;
      } else if (remaining === 1) {
        if (node.star !== undefined) best = node.star;
        else if (node.dot !== undefined) best = node.dot;
      } else if (node.dot !== undefined) {
        best = node.dot;
      }
    }
    return best;
  }

  /**
   * Minimum value across every matching pattern. With rule indices as values
   * this is the earliest matching rule, i.e. first-match-wins.
   */
  searchMin(domain: string): V | undefined {
    if (this.#size === 0) return undefined;
    const query = normalizeQuery(domain);
    if (query === null) return undefined;

    const labels = query.split('.');
    const n = labels.length;
    let node = this.#root;
    let best: V | undefined;

    for (let d = 0; d < n; d++) {
      const child = node.children.get(labels[n - 1 - d]!);
      if (child === undefined) break;
      node = child;
      const remaining = n - d - 1;
      if (remaining === 0) {
        best = foldMin(best, node.exact);
      } else {
        if (remaining === 1) best = foldMin(best, node.star);
        best = foldMin(best, node.dot);
      }
    }
    return best;
  }
}

function normalizeQuery(domain: string | null | undefined): string | null {
  let query = (domain ?? '').trim();
  if (query.length === 0) return null;
  while (query.length > 0 && query.charCodeAt(query.length - 1) === CHAR_DOT) {
    query = query.substring(0, query.length - 1);
  }
  if (query.length === 0) return null;
  return query.toLowerCase();
}

function foldMin<V>(best: V | undefined, candidate: V | undefined): V | undefined {
  if (candidate === undefined) return best;
  if (best === undefined) return candidate;
  // Values are compared with the natural ordering of whatever V is; for the
  // rule-index case that V is always a number.
  return (best as unknown as number) <= (candidate as unknown as number) ? best : candidate;
}
