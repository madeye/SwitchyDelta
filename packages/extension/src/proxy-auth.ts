/**
 * Proxy authentication for the MV3 service worker.
 *
 * The worker is torn down and restarted at will, and a proxy auth challenge is
 * one of the events that wakes it. Two things follow, and they shape this whole
 * file:
 *
 *  - The `onAuthRequired` listener has to be registered synchronously during
 *    worker startup, before anything is loaded from storage. A listener
 *    attached at the end of an async boot is registered too late to see the
 *    event that caused the wake-up.
 *  - The credentials themselves therefore cannot live only in memory. They are
 *    written to storage whenever a profile is applied and read back on demand.
 *
 * Hence the module-level singleton: startup registers the listener on it, and
 * the later async boot fills in the credentials on the same object.
 */

import { Profiles } from '@switchydelta/pac';
import type {
  FixedProfile,
  Profile,
  ProxyAuth as ProxyCredentials,
  ProxyServer,
} from '@switchydelta/pac';
import type { Logger } from '@switchydelta/target';

const STORAGE_KEY = 'omegaProxyAuth';

/** One candidate credential for a challenge. Fallbacks carry no `config`. */
interface AuthEntry {
  config?: ProxyServer;
  auth: ProxyCredentials;
  name: string;
}

/** What gets persisted; must stay plain JSON. */
interface AuthPayload {
  proxies: Record<string, AuthEntry[] | undefined>;
  fallbacks: AuthEntry[];
}

/** Credentials in the shape a `{user, pass}`-era options file may still hold. */
interface LegacyAuth {
  username?: string;
  password?: string;
  user?: string;
  pass?: string;
}

type AreaName = 'session' | 'local';

function storageArea(name: AreaName): chrome.storage.StorageArea | undefined {
  if (typeof chrome === 'undefined' || !chrome.storage) return undefined;
  return chrome.storage[name];
}

/** See {@link ProxyAuth.shared}. */
let sharedInstance: ProxyAuth | null = null;

export class ProxyAuth {
  /**
   * The single instance the worker registers its listener on.
   *
   * Everything must go through this: a second instance would register a second
   * listener holding a different credential map, and which of the two answered
   * a challenge would depend on registration order.
   */
  static shared(log?: Logger | null): ProxyAuth {
    const instance = sharedInstance ?? new ProxyAuth(log);
    if (log) instance.log = log;
    return instance;
  }

  log: Logger | null;
  listening = false;

  /** Per-request state, keyed by requestId; see {@link _credentialsFor}. */
  private _requests: Record<string, { authTries: number } | undefined> = {};
  private _proxies: Record<string, AuthEntry[] | undefined> = {};
  private _fallbacks: AuthEntry[] = [];
  private _hydrated = false;
  private _hydratePromise: Promise<void> | null = null;

  constructor(log?: Logger | null) {
    this.log = log ?? null;
    sharedInstance = this;
  }

  /**
   * Register the auth listeners. Idempotent, because startup and the first
   * `applyProfile` both call it and neither knows about the other.
   */
  listen(): void {
    if (this.listening) return;
    if (!chrome.webRequest) {
      this.log?.error('Proxy auth disabled! No webRequest permission.');
      return;
    }
    if (!chrome.webRequest.onAuthRequired) {
      this.log?.error('Proxy auth disabled! onAuthRequired not available.');
      return;
    }

    const handler = (
      details: chrome.webRequest.WebAuthenticationChallengeDetails,
      asyncCallback?: (response: chrome.webRequest.BlockingResponse) => void,
    ) => this.authHandler(details, asyncCallback);

    // asyncBlocking is the MV3 form (it needs the webRequestAuthProvider
    // permission) and is the only one that allows answering a challenge after
    // an await. Older hosts only understand blocking, and reject the unknown
    // extraInfoSpec by throwing.
    try {
      chrome.webRequest.onAuthRequired.addListener(handler, { urls: ['<all_urls>'] }, [
        'asyncBlocking',
      ]);
    } catch (err) {
      this.log?.error('asyncBlocking onAuthRequired failed; trying blocking.', err);
      chrome.webRequest.onAuthRequired.addListener(handler, { urls: ['<all_urls>'] }, [
        'blocking',
      ]);
    }

    chrome.webRequest.onCompleted.addListener((details) => this._requestDone(details), {
      urls: ['<all_urls>'],
    });
    chrome.webRequest.onErrorOccurred.addListener((details) => this._requestDone(details), {
      urls: ['<all_urls>'],
    });
    this.listening = true;

    // Warm the credentials from the last applyProfile so that the common case
    // does not have to wait for storage inside the challenge handler.
    void this._hydrate();
  }

  private _payload(): AuthPayload {
    return { proxies: this._proxies, fallbacks: this._fallbacks };
  }

  private _applyPayload(data: AuthPayload | null | undefined): boolean {
    if (!data) return false;
    this._proxies = data.proxies || {};
    this._fallbacks = data.fallbacks || [];
    return true;
  }

  /**
   * Write to both session and local storage.
   *
   * Session storage covers worker restarts within a browser session and is
   * never written to disk. Local storage covers a full browser restart, where
   * the first proxied request can easily beat `Options.init` to re-applying the
   * profile — without it, that request would get no credentials at all.
   */
  private _persist(): void {
    const payload = { [STORAGE_KEY]: this._payload() };
    for (const areaName of ['session', 'local'] as const) {
      const area = storageArea(areaName);
      if (!area) continue;
      try {
        void Promise.resolve(area.set(payload)).catch(() => undefined);
      } catch {
        // A storage area that throws synchronously is unusable; the in-memory
        // credentials still work for as long as this worker lives.
      }
    }
  }

  private async _getFromArea(areaName: AreaName): Promise<AuthPayload | null> {
    const area = storageArea(areaName);
    if (!area) return null;
    try {
      const items = await area.get(STORAGE_KEY);
      if (chrome.runtime?.lastError) return null;
      return (items?.[STORAGE_KEY] as AuthPayload | undefined) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Load persisted credentials once, preferring session storage.
   *
   * Concurrent callers share one read: several challenges can arrive back to
   * back on the same wake-up.
   */
  private _hydrate(): Promise<void> {
    if (this._hydrated) return Promise.resolve();
    if (this._hydratePromise) return this._hydratePromise;

    this._hydratePromise = (async () => {
      try {
        let data = await this._getFromArea('session');
        if (!data) {
          data = await this._getFromArea('local');
          // Mirror local into session so later wake-ups in this browser session
          // take the cheap path and stop touching disk.
          const session = data ? storageArea('session') : undefined;
          if (session) {
            try {
              void Promise.resolve(session.set({ [STORAGE_KEY]: data })).catch(() => undefined);
            } catch {
              // Ignore; the local copy is still authoritative.
            }
          }
        }
        this._applyPayload(data);
      } catch {
        // Never let a storage failure hold a challenge open forever; without
        // credentials the request simply fails to authenticate.
      } finally {
        this._hydrated = true;
        this._hydratePromise = null;
      }
    })();
    return this._hydratePromise;
  }

  private _keyForProxy(proxy: { host?: string; port: number | undefined }): string {
    const host = (proxy.host || '').toLowerCase();
    return `${host}:${String(proxy.port)}`;
  }

  /**
   * The keys a challenge may be stored under.
   *
   * Chromium reports IPv6 challengers in bracketed form (`[::1]`) while the
   * profile stores the bare address, so both spellings are tried.
   */
  private _keysForChallenger(challenger: { host?: string; port: number | undefined }): string[] {
    const host = (challenger.host || '').toLowerCase();
    const port = challenger.port;
    const keys = [`${host}:${String(port)}`];
    if (host.length >= 2 && host[0] === '[' && host[host.length - 1] === ']') {
      keys.push(`${host.substring(1, host.length - 1)}:${String(port)}`);
    }
    return keys;
  }

  /** Rebuild the credential map from the profiles the current profile uses. */
  setProxies(profiles: Profile[]): void {
    this._proxies = {};
    this._fallbacks = [];

    for (const profile of profiles) {
      // Only FixedProfile carries `auth`, but the check stays value-based so
      // that an unexpected profile type with credentials is still honoured.
      const profileAuth = (profile as FixedProfile).auth;
      if (!profileAuth) continue;

      for (const scheme of Profiles.schemes) {
        const proxy = (profile as FixedProfile)[scheme.prop];
        if (!proxy) continue;
        const auth = profileAuth[scheme.prop];
        if (!auth?.username) continue;
        const key = this._keyForProxy(proxy);
        let list = this._proxies[key];
        if (!list) {
          list = [];
          this._proxies[key] = list;
        }
        list.push({
          config: proxy,
          auth: { username: auth.username, password: auth.password ?? '' },
          name: profile.name + '.' + scheme.prop,
        });
      }

      const fallback = profileAuth['all'];
      if (fallback?.username) {
        this._fallbacks.push({
          auth: { username: fallback.username, password: fallback.password ?? '' },
          name: profile.name + '.all',
        });
      }
    }

    this._hydrated = true;
    this._persist();
  }

  private _normalizeAuth(auth: LegacyAuth | null | undefined): ProxyCredentials | null {
    if (!auth) return null;
    const username = auth.username ?? auth.user;
    if (username == null) return null;
    return { username, password: auth.password ?? auth.pass ?? '' };
  }

  /**
   * Pick the credentials for one challenge.
   *
   * Chromium re-fires `onAuthRequired` for the same requestId when the
   * credentials are rejected, so `authTries` walks the candidates registered
   * for the challenged proxy and then the profile-wide fallbacks, one per
   * attempt, instead of replying with the same rejected password forever.
   */
  private _credentialsFor(
    details: chrome.webRequest.WebAuthenticationChallengeDetails,
  ): chrome.webRequest.BlockingResponse {
    if (!details.isProxy) return {};
    let req = this._requests[details.requestId];
    if (!req) {
      req = { authTries: 0 };
      this._requests[details.requestId] = req;
    }

    let list: AuthEntry[] | undefined;
    let key: string | undefined;
    for (const k of this._keysForChallenger(details.challenger)) {
      if (this._proxies[k]) {
        list = this._proxies[k];
        key = k;
        break;
      }
    }
    key ??= this._keyForProxy(details.challenger);
    list ??= this._proxies[key];

    const listLen = list ? list.length : 0;
    const entry =
      req.authTries < listLen
        ? list?.[req.authTries]
        : this._fallbacks[req.authTries - listLen];
    this.log?.log('ProxyAuth', key, req.authTries, entry?.name);

    if (!entry) return {};
    const credentials = this._normalizeAuth(entry.auth);
    if (!credentials) return {};
    req.authTries++;
    return { authCredentials: credentials };
  }

  /**
   * @param asyncCallback present only when registered with `asyncBlocking`.
   */
  authHandler(
    details: chrome.webRequest.WebAuthenticationChallengeDetails,
    asyncCallback?: (response: chrome.webRequest.BlockingResponse) => void,
  ): chrome.webRequest.BlockingResponse | undefined {
    const respond = (
      result: chrome.webRequest.BlockingResponse,
    ): chrome.webRequest.BlockingResponse | undefined => {
      if (typeof asyncCallback === 'function') {
        asyncCallback(result);
        return undefined;
      }
      return result;
    };

    if (!details.isProxy) return respond({});

    // Fast path: credentials are already in memory.
    if (this._hydrated) return respond(this._credentialsFor(details));

    // The worker has just woken up. Only asyncBlocking lets us answer after
    // reading storage; in plain blocking mode there is nothing to wait with.
    if (typeof asyncCallback === 'function') {
      void this._hydrate().then(
        () => {
          respond(this._credentialsFor(details));
        },
        () => {
          respond({});
        },
      );
      return undefined;
    }

    return respond(this._credentialsFor(details));
  }

  private _requestDone(details: { requestId: string }): void {
    delete this._requests[details.requestId];
  }
}

export default ProxyAuth;
