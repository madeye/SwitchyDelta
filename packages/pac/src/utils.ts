/** Revision stamps and analysis caching. */

export const Revision = {
  /** Monotonic-ish revision derived from wall clock, hex encoded. */
  fromTime(time?: number | Date): string {
    const date = time !== undefined ? new Date(time) : new Date();
    return date.getTime().toString(16);
  },

  /**
   * Order two revisions. Longer strings are newer, otherwise lexicographic —
   * which works because the values are fixed-radix hex timestamps.
   */
  compare(a: string | null | undefined, b: string | null | undefined): number {
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    if (a.length > b.length) return 1;
    if (a.length < b.length) return -1;
    if (a > b) return 1;
    if (a < b) return -1;
    return 0;
  },
} as const;

/**
 * Memoises a derived value against an object, invalidated by a tag.
 *
 * The CoffeeScript version stored the cache in a non-enumerable property on the
 * object itself, using `Object.defineProperty` to keep it out of JSON. A
 * WeakMap gives the same lifetime without mutating caller-owned objects, so
 * profiles can be persisted or structured-cloned without stripping fields.
 */
export class AttachedCache<T extends object, V> {
  readonly #store = new WeakMap<T, { tag: unknown; value: V }>();
  readonly #tagFn: (obj: T) => unknown;

  constructor(tagFn: (obj: T) => unknown) {
    this.#tagFn = tagFn;
  }

  tag(obj: T): unknown {
    return this.#tagFn(obj);
  }

  get(obj: T, otherwise: V | (() => V)): V {
    const tag = this.#tagFn(obj);
    const cached = this.#store.get(obj);
    if (cached !== undefined && cached.tag === tag) {
      return cached.value;
    }
    const value = typeof otherwise === 'function' ? (otherwise as () => V)() : otherwise;
    this.#store.set(obj, { tag, value });
    return value;
  }

  drop(obj: T): void {
    this.#store.delete(obj);
  }
}

/**
 * Cheap check for whether a host is an IP literal rather than a domain name.
 * Exact parsing is deliberately avoided: this only needs to be right for hosts
 * that reach it from a URL.
 */
export function isIp(domain: string): boolean {
  if (domain.indexOf(':') > 0) return true; // IPv6
  const lastCharCode = domain.charCodeAt(domain.length - 1);
  return lastCharCode >= 48 && lastCharCode <= 57; // trailing digit => IPv4
}

/**
 * Hostname of a URL, with any IPv6 brackets removed.
 *
 * The WHATWG `URL` keeps brackets in `hostname` (`[::1]`) whereas the Node
 * `url.parse` this replaces stripped them. Matching stays on the legacy
 * (bracket-free) form because conditions compare against PAC's `host`
 * argument, which is also unbracketed.
 */
export function hostnameOf(url: string): string {
  const parsed = tryParseUrl(url);
  if (parsed === null) return '';
  return unbracket(parsed.hostname);
}

export function unbracket(host: string): string {
  if (host.charCodeAt(0) === 0x5b /* [ */ && host.charCodeAt(host.length - 1) === 0x5d /* ] */) {
    return host.substring(1, host.length - 1);
  }
  return host;
}

export function tryParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
