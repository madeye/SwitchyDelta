import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ContentTypeRejectedError,
  HttpNotFoundError,
  NetworkError,
} from '@switchydelta/target';

import {
  fetchLimits,
  fetchUrl,
  isNonPublicHostname,
  looksLikeHtml,
} from '../src/fetch-url.js';

const defaults = { ...fetchLimits };

afterEach(() => {
  Object.assign(fetchLimits, defaults);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function textResponse(
  body: string,
  contentType = 'text/plain',
  init: { status?: number; url?: string; headers?: Record<string, string> } = {},
): Response {
  const headers = new Headers(init.headers);
  if (contentType && !headers.has('content-type')) headers.set('content-type', contentType);
  const response = new Response(body, { status: init.status ?? 200, headers });
  if (init.url) {
    Object.defineProperty(response, 'url', { value: init.url });
  }
  return response;
}

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response> | Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(impl(url, init));
    }),
  );
}

describe('looksLikeHtml', () => {
  it('is case-insensitive and matches structural tags', () => {
    expect(looksLikeHtml('<!DOCTYPE html>')).toBe(true);
    expect(looksLikeHtml('<HTML LANG="en">')).toBe(true);
    expect(looksLikeHtml('<Head><Title>x</Title></Head>')).toBe(true);
    expect(looksLikeHtml('<script>alert(1)</script>')).toBe(true);
    expect(looksLikeHtml('||example.com')).toBe(false);
    expect(looksLikeHtml('function FindProxyForURL(url, host) { return "DIRECT"; }')).toBe(false);
  });
});

describe('isNonPublicHostname', () => {
  it('flags loopback, RFC1918, link-local, and metadata', () => {
    expect(isNonPublicHostname('127.0.0.1')).toBe(true);
    expect(isNonPublicHostname('10.1.2.3')).toBe(true);
    expect(isNonPublicHostname('172.16.0.1')).toBe(true);
    expect(isNonPublicHostname('192.168.1.1')).toBe(true);
    expect(isNonPublicHostname('169.254.169.254')).toBe(true);
    expect(isNonPublicHostname('localhost')).toBe(true);
    expect(isNonPublicHostname('foo.localhost')).toBe(true);
    expect(isNonPublicHostname('[::1]')).toBe(true);
    expect(isNonPublicHostname('::1')).toBe(true);
    expect(isNonPublicHostname('metadata.google.internal')).toBe(true);
    expect(isNonPublicHostname('[::ffff:127.0.0.1]')).toBe(true);
    expect(isNonPublicHostname('127.1')).toBe(true);
  });

  it('allows public hosts', () => {
    expect(isNonPublicHostname('example.com')).toBe(false);
    expect(isNonPublicHostname('8.8.8.8')).toBe(false);
    expect(isNonPublicHostname('172.32.0.1')).toBe(false);
  });
});

describe('fetchUrl', () => {
  it('rejects non-http(s) URLs without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchUrl('file:///etc/passwd')).rejects.toBeInstanceOf(NetworkError);
    await expect(fetchUrl('data:text/plain,hi')).rejects.toBeInstanceOf(NetworkError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects loopback and metadata URLs without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchUrl('http://127.0.0.1/x')).rejects.toMatchObject({
      message: 'Refused to fetch a non-public host',
    });
    await expect(fetchUrl('http://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(
      NetworkError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a redirect hop to a private host', async () => {
    stubFetch((url) => {
      if (url === 'https://lists.example/list.txt') {
        return new Response(null, {
          status: 302,
          headers: { Location: 'http://127.0.0.1/secret' },
        });
      }
      return textResponse('should-not-fetch');
    });
    await expect(fetchUrl('https://lists.example/list.txt')).rejects.toMatchObject({
      message: 'Refused to fetch a non-public host',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses an opaque-redirect final URL on a private host', async () => {
    stubFetch((_url, init) => {
      if (init?.redirect === 'manual') {
        return { type: 'opaqueredirect', status: 0, ok: false, url: '', headers: new Headers() } as Response;
      }
      const followed = textResponse('meta');
      Object.defineProperty(followed, 'url', { value: 'http://169.254.169.254/latest' });
      return followed;
    });
    await expect(fetchUrl('https://lists.example/list.txt')).rejects.toMatchObject({
      message: 'Refused to fetch a non-public host',
    });
  });

  it('passes an AbortSignal so a stalling server cannot hang the worker', async () => {
    let signal: AbortSignal | undefined;
    stubFetch((_url, init) => {
      signal = init?.signal;
      return textResponse('||example.com\n');
    });
    await fetchUrl('https://lists.example/list.txt');
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts a body past the byte cap', async () => {
    fetchLimits.maxBytes = 32;
    stubFetch(() => {
      const chunk = new Uint8Array(16);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    await expect(fetchUrl('https://lists.example/list.txt')).rejects.toMatchObject({
      message: 'Response exceeded size limit',
    });
  });

  it('rejects HTML error pages even when the catch-all hint would accept them', async () => {
    stubFetch(() =>
      textResponse('<!DOCTYPE html><html><body>404</body></html>', 'application/octet-stream'),
    );
    await expect(
      fetchUrl('https://lists.example/list.txt', false, [
        '!text/html',
        '!application/xhtml+xml',
        'text/plain',
        '*',
      ]),
    ).rejects.toBeInstanceOf(ContentTypeRejectedError);
  });

  it('rejects uppercase HTML served as text/html', async () => {
    stubFetch(() => textResponse('<HTML><HEAD></HEAD><BODY>nope</BODY></HTML>', 'text/html'));
    await expect(
      fetchUrl('https://lists.example/list.txt', false, ['!text/html', 'text/plain', '*']),
    ).rejects.toBeInstanceOf(ContentTypeRejectedError);
  });

  it('accepts a rule list that is not HTML', async () => {
    stubFetch(() => textResponse('||example.com\n@@||ok.example\n', 'text/plain'));
    await expect(
      fetchUrl('https://lists.example/list.txt', false, [
        '!text/html',
        '!application/xhtml+xml',
        'text/plain',
        '*',
      ]),
    ).resolves.toContain('||example.com');
  });

  it('maps an aborted fetch to a timeout NetworkError', async () => {
    fetchLimits.timeoutMs = 20;
    stubFetch((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error('missing AbortSignal'));
          return;
        }
        if (signal.aborted) {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    });
    await expect(fetchUrl('https://lists.example/list.txt')).rejects.toMatchObject({
      message: 'Request timed out',
    });
  });

  it('rejects a Content-Length over the byte cap before reading', async () => {
    fetchLimits.maxBytes = 8;
    stubFetch(() =>
      new Response('0123456789', {
        status: 200,
        headers: { 'content-type': 'text/plain', 'content-length': '64' },
      }),
    );
    await expect(fetchUrl('https://lists.example/list.txt')).rejects.toMatchObject({
      message: 'Response exceeded size limit',
    });
  });

  it('maps 404 to HttpNotFoundError', async () => {
    stubFetch(() => textResponse('missing', 'text/plain', { status: 404 }));
    await expect(fetchUrl('https://lists.example/missing.txt')).rejects.toBeInstanceOf(
      HttpNotFoundError,
    );
  });
});
