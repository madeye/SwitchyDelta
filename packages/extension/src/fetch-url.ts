/**
 * Downloading of PAC scripts and rule lists.
 *
 * Replaces the `xhr` package with `fetch`, which is available in the MV3
 * service worker and removes the dependency along with its
 * `request`-style error shape.
 *
 * Only `http:` and `https:` URLs are fetched. Redirects that land on
 * loopback, RFC1918, link-local, or cloud-metadata hosts are refused so a
 * hostile list URL cannot be used to probe the user's network. Responses
 * are stream-read with a byte cap and the request is aborted on timeout.
 */

import {
  ContentTypeRejectedError,
  HttpError,
  HttpNotFoundError,
  HttpServerError,
  NetworkError,
} from '@switchydelta/target';

interface Response_ {
  contentType: string;
  body: string;
}

/** Tunable limits; tests shrink these so they need not wait or buffer megabytes. */
export const fetchLimits = {
  timeoutMs: 30_000,
  maxBytes: 2 * 1024 * 1024,
  maxRedirects: 5,
};

/** Controllers of in-flight {@link fetchUrl} calls, so a profile switch can cancel a hung download. */
const inFlight = new Set<AbortController>();

/**
 * Abort every in-flight rule-list / PAC download.
 *
 * A hung gfwlist fetch (blocked host, missing permission, dead proxy) otherwise
 * keeps the worker's `chrome.proxy.settings.set` and the popup RPC behind it.
 */
export function abortInFlightFetches(): void {
  for (const controller of inFlight) {
    try {
      controller.abort();
    } catch {
      // Already aborted or the host rejected abort().
    }
  }
  inFlight.clear();
}

/**
 * The media type without its parameters, lowercased.
 *
 * The CoffeeScript version compared the raw header against the hint, so
 * `text/html; charset=utf-8` never equalled `text/html`. Since servers almost
 * always send a charset, the "response must not be HTML" guard silently never
 * fired and HTML error pages were accepted as rule lists.
 */
function mediaType(header: string | null): string {
  return (header ?? '').split(';')[0]!.trim().toLowerCase();
}

const HTML_MARKERS =
  /<!doctype\b|<\/?(?:html|head|body|script|style|meta|title|link)\b/i;

/**
 * Cheap sniff for an HTML document or error page.
 *
 * Case-insensitive, and matches opening or closing structural tags — not just
 * `<!DOCTYPE` / `</html>` / `</body>`. Only the first 8 KiB is inspected so a
 * huge PAC cannot trip this by accident later in the file.
 */
export function looksLikeHtml(body: string): boolean {
  return HTML_MARKERS.test(body.slice(0, 8192));
}

function parseDottedIPv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,10}$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0) return null;
    nums.push(n);
  }
  if (parts.length === 4) {
    if (nums.some((n) => n > 255)) return null;
    return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
  }
  if (parts.length === 1) {
    const n = nums[0]!;
    if (n > 0xffffffff) return null;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }
  if (parts.length === 2) {
    if (nums[0]! > 255 || nums[1]! > 0xffffff) return null;
    const rest = nums[1]!;
    return [nums[0]!, (rest >>> 16) & 255, (rest >>> 8) & 255, rest & 255];
  }
  if (nums[0]! > 255 || nums[1]! > 255 || nums[2]! > 0xffff) return null;
  const rest = nums[2]!;
  return [nums[0]!, nums[1]!, (rest >>> 8) & 255, rest & 255];
}

function isBlockedIPv4(octets: [number, number, number, number]): boolean {
  const a = octets[0];
  const b = octets[1];
  if (a === 0) return true;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function parseIPv6(host: string): number[] | null {
  const lower = host.toLowerCase();
  if (lower.includes('.')) {
    const lastColon = lower.lastIndexOf(':');
    if (lastColon < 0) return null;
    const v4 = parseDottedIPv4(lower.slice(lastColon + 1));
    if (!v4) return null;
    const head = lower.slice(0, lastColon + 1);
    const hexTail =
      ((v4[0]! << 8) | v4[1]!).toString(16) + ':' + ((v4[2]! << 8) | v4[3]!).toString(16);
    return parseIPv6(head + hexTail);
  }
  const sides = lower.split('::');
  if (sides.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (side === '') return [];
    const groups = side.split(':');
    const out: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  if (sides.length === 1) {
    const groups = parseSide(sides[0]!);
    if (!groups || groups.length !== 8) return null;
    return groups;
  }
  const left = parseSide(sides[0]!);
  const right = parseSide(sides[1]!);
  if (!left || !right) return null;
  const fill = 8 - left.length - right.length;
  if (fill < 0) return null;
  return [...left, ...Array<number>(fill).fill(0), ...right];
}

function isBlockedIPv6(groups: number[]): boolean {
  if (groups.every((g, i) => (i === 7 ? g === 1 : g === 0))) return true;
  if (groups.every((g) => g === 0)) return true;
  if ((groups[0]! & 0xffc0) === 0xfe80) return true;
  if ((groups[0]! & 0xfe00) === 0xfc00) return true;
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    return isBlockedIPv4([
      groups[6]! >> 8,
      groups[6]! & 0xff,
      groups[7]! >> 8,
      groups[7]! & 0xff,
    ]);
  }
  return false;
}

/** True for loopback, RFC1918, link-local, ULA, and well-known metadata hosts. */
export function isNonPublicHostname(host: string): boolean {
  let raw = host.toLowerCase();
  if (raw.endsWith('.')) raw = raw.slice(0, -1);
  const unbracketed =
    raw.charCodeAt(0) === 0x5b /* [ */ && raw.charCodeAt(raw.length - 1) === 0x5d /* ] */
      ? raw.slice(1, -1)
      : raw;
  if (unbracketed === 'localhost' || unbracketed.endsWith('.localhost')) return true;
  if (
    unbracketed === 'metadata.google.internal' ||
    unbracketed === 'metadata.goog' ||
    unbracketed.endsWith('.metadata.google.internal')
  ) {
    return true;
  }
  const v4 = parseDottedIPv4(unbracketed);
  if (v4) return isBlockedIPv4(v4);
  if (unbracketed.includes(':')) {
    const v6 = parseIPv6(unbracketed);
    if (v6) return isBlockedIPv6(v6);
  }
  return false;
}

function assertAllowedUrl(urlString: string): URL {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new NetworkError(undefined, 'Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NetworkError(undefined, 'Only http(s) URLs are allowed');
  }
  if (isNonPublicHostname(url.hostname)) {
    throw new NetworkError(undefined, 'Refused to fetch a non-public host');
  }
  return url;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readBodyCapped(response: Response, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > fetchLimits.maxBytes) {
    throw new NetworkError(undefined, 'Response exceeded size limit');
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > fetchLimits.maxBytes) {
      throw new NetworkError(undefined, 'Response exceeded size limit');
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let received = 0;
  try {
    for (;;) {
      if (signal.aborted) {
        throw new NetworkError(signal.reason, 'Request aborted');
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > fetchLimits.maxBytes) {
        await reader.cancel();
        throw new NetworkError(undefined, 'Response exceeded size limit');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released by cancel().
    }
  }
}

async function fetchFollowing(urlString: string, signal: AbortSignal): Promise<Response> {
  let current = assertAllowedUrl(urlString).href;

  for (let hops = 0; hops <= fetchLimits.maxRedirects; hops++) {
    assertAllowedUrl(current);
    let response: Response;
    try {
      response = await fetch(current, {
        credentials: 'omit',
        redirect: 'manual',
        signal,
      });
    } catch (e) {
      if (e instanceof NetworkError) throw e;
      if (e instanceof DOMException && e.name === 'AbortError') {
        throw new NetworkError(e, 'Request timed out');
      }
      throw new NetworkError(e);
    }

    // Page/worker fetch with redirect: 'manual' yields an opaque-redirect
    // filtered response (no Location). Follow automatically and refuse a
    // non-public final URL. Node's undici exposes the real 3xx, so tests
    // (and any host that does the same) walk hops and can reject mid-chain.
    if (response.type === 'opaqueredirect') {
      let followed: Response;
      try {
        followed = await fetch(current, {
          credentials: 'omit',
          redirect: 'follow',
          signal,
        });
      } catch (e) {
        if (e instanceof NetworkError) throw e;
        if (e instanceof DOMException && e.name === 'AbortError') {
          throw new NetworkError(e, 'Request timed out');
        }
        throw new NetworkError(e);
      }
      assertAllowedUrl(followed.url || current);
      return followed;
    }

    if (!isRedirectStatus(response.status)) {
      if (response.url) assertAllowedUrl(response.url);
      return response;
    }

    const location = response.headers.get('location');
    if (!location) throw new NetworkError(undefined, 'Redirect missing Location');
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new NetworkError(undefined, 'Redirect to an invalid URL');
    }
    current = next.href;
  }
  throw new NetworkError(undefined, 'Too many redirects');
}

async function request(url: string): Promise<Response_> {
  const controller = new AbortController();
  inFlight.add(controller);
  const timer = setTimeout(() => controller.abort(), fetchLimits.timeoutMs);
  try {
    const response = await fetchFollowing(url, controller.signal);

    if (!response.ok) {
      const detail = { statusCode: response.status };
      if (response.status === 404) throw new HttpNotFoundError(detail);
      if (response.status >= 500 && response.status < 600) throw new HttpServerError(detail);
      throw new HttpError(detail);
    }

    return {
      contentType: mediaType(response.headers.get('content-type')),
      body: await readBodyCapped(response, controller.signal),
    };
  } finally {
    clearTimeout(timer);
    inFlight.delete(controller);
  }
}

type HintHandler = (res: Response_, hint: string) => string | undefined;

function rejectIfHtml(body: string): void {
  if (looksLikeHtml(body)) {
    throw new ContentTypeRejectedError('Response must not be HTML.');
  }
}

const rejectHtml: HintHandler = (res, hint) => {
  if (res.contentType !== hint.substring(1)) return undefined;
  // Other content is sometimes served as text/html, so only reject when the
  // body really does look like markup.
  rejectIfHtml(res.body);
  return undefined;
};

const hintHandlers: Record<string, HintHandler> = {
  '*': (res) => {
    rejectIfHtml(res.body);
    return res.body;
  },

  '!text/html': rejectHtml,
  '!application/xhtml+xml': rejectHtml,

  'application/x-ns-proxy-autoconfig': (res, hint) => {
    if (res.contentType === hint) return res.body;
    // PAC scripts are frequently served with the wrong Content-Type, so fall
    // back to looking for the entry point the script must define.
    return res.body.indexOf('FindProxyForURL') >= 0 ? res.body : undefined;
  },
};

/**
 * A hint is either a media type to accept or, prefixed with `!`, one to reject.
 * Hints are tried in order; the first to return a body wins.
 */
const defaultHintHandler: HintHandler = (res, hint) => {
  if (hint.startsWith('!')) {
    if (res.contentType === hint.substring(1)) {
      throw new ContentTypeRejectedError('Response Content-Type blacklisted: ' + res.contentType);
    }
    return undefined;
  }
  if (res.contentType !== hint) return undefined;
  rejectIfHtml(res.body);
  return res.body;
};

function bodyForHints(res: Response_, typeHints?: string[]): string {
  if (!typeHints || typeHints.length === 0) {
    rejectIfHtml(res.body);
    return res.body;
  }

  for (const hint of typeHints) {
    const handler = hintHandlers[hint] ?? defaultHintHandler;
    const result = handler(res, hint);
    if (result !== undefined) return result;
  }
  throw new ContentTypeRejectedError('Unrecognized Content-Type: ' + res.contentType);
}

/**
 * Fetch a URL, optionally defeating the HTTP cache.
 *
 * Only `http:` / `https:` are accepted. Cache busting appends a throwaway
 * query parameter, and only when the URL has no query of its own, so that
 * servers reading their own parameters are not disturbed. If that request
 * fails the original URL is tried, since some servers reject unexpected
 * parameters outright.
 */
export async function fetchUrl(
  destUrl: string,
  bypassCache?: boolean,
  typeHints?: string[],
): Promise<string> {
  assertAllowedUrl(destUrl);
  if (bypassCache && destUrl.indexOf('?') < 0) {
    const url = new URL(destUrl);
    url.searchParams.set('_', String(Date.now()));
    try {
      return bodyForHints(await request(url.href), typeHints);
    } catch {
      return bodyForHints(await request(destUrl), typeHints);
    }
  }
  return bodyForHints(await request(destUrl), typeHints);
}

export default fetchUrl;
