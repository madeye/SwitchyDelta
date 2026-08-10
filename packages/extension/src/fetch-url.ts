/**
 * Downloading of PAC scripts and rule lists.
 *
 * Replaces the `xhr` package with `fetch`, which is available in the MV3
 * service worker and removes the dependency along with its
 * `request`-style error shape.
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

async function request(url: string): Promise<Response_> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'omit', redirect: 'follow' });
  } catch (e) {
    // fetch only rejects for transport-level failures.
    throw new NetworkError(e);
  }

  if (!response.ok) {
    const detail = { statusCode: response.status };
    if (response.status === 404) throw new HttpNotFoundError(detail);
    if (response.status >= 500 && response.status < 600) throw new HttpServerError(detail);
    throw new HttpError(detail);
  }

  return {
    contentType: mediaType(response.headers.get('content-type')),
    body: await response.text(),
  };
}

type HintHandler = (res: Response_, hint: string) => string | undefined;

function looksLikeHtml(body: string): boolean {
  return (
    body.indexOf('<!DOCTYPE') >= 0 ||
    body.indexOf('<!doctype') >= 0 ||
    body.indexOf('</html>') >= 0 ||
    body.indexOf('</body>') >= 0
  );
}

const rejectHtml: HintHandler = (res, hint) => {
  if (res.contentType !== hint.substring(1)) return undefined;
  // Other content is sometimes served as text/html, so only reject when the
  // body really does look like markup.
  if (looksLikeHtml(res.body)) {
    throw new ContentTypeRejectedError('Response must not be HTML.');
  }
  return undefined;
};

const hintHandlers: Record<string, HintHandler> = {
  '*': (res) => res.body,

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
  return res.contentType === hint ? res.body : undefined;
};

function bodyForHints(res: Response_, typeHints?: string[]): string {
  if (!typeHints || typeHints.length === 0) return res.body;

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
 * Cache busting appends a throwaway query parameter, and only when the URL has
 * no query of its own, so that servers reading their own parameters are not
 * disturbed. If that request fails the original URL is tried, since some
 * servers reject unexpected parameters outright.
 */
export async function fetchUrl(
  destUrl: string,
  bypassCache?: boolean,
  typeHints?: string[],
): Promise<string> {
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
