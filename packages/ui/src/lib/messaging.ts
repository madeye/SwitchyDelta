/**
 * Typed RPC client for talking to the MV3 service worker.
 *
 * Replaces the AngularJS `deltaTarget` factory and the parallel plain-JS
 * `DeltaTargetPopup` shim with one implementation shared by both pages.
 *
 * The wire format is fixed by the background dispatcher: a request is
 * `{method, args}` and the reply is `{result}` or `{error}`. Errors cannot
 * cross `chrome.runtime.sendMessage` intact, so they travel as plain objects
 * and are rebuilt here.
 */

import type { OptionsBag, Profile } from '@switchydelta/pac';

/** An Error flattened for structured cloning across the message channel. */
interface EncodedError {
  _error: 'error';
  name?: string;
  message?: string;
  stack?: string;
  original?: unknown;
}

function isEncodedError(value: unknown): value is EncodedError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { _error?: unknown })._error === 'error'
  );
}

/** Rebuild a real Error from the background's flattened representation. */
export function decodeError(value: unknown): unknown {
  if (!isEncodedError(value)) return value;
  const err = new Error(value.message ?? 'Unknown error');
  if (value.name) err.name = value.name;
  if (value.stack) err.stack = value.stack;
  if (value.original !== undefined) {
    (err as Error & { original?: unknown }).original = value.original;
  }
  return err;
}

interface BackgroundResponse<T> {
  result?: T;
  error?: unknown;
}

/** Invoke a method on the background page and await its result. */
export async function callBackground<T = unknown>(
  method: string,
  ...args: unknown[]
): Promise<T> {
  const response = (await chrome.runtime.sendMessage({
    method,
    args,
  })) as BackgroundResponse<T> | undefined;

  if (response?.error !== undefined) {
    throw decodeError(response.error);
  }
  return response?.result as T;
}

/**
 * Invoke a method without waiting for a reply.
 *
 * Used where the page is about to close and awaiting the round trip would
 * lose the call.
 */
export function callBackgroundNoReply(method: string, ...args: unknown[]): void {
  void chrome.runtime.sendMessage({ method, args, noReply: true });
}

// --- State ------------------------------------------------------------------

export type StateValues = Record<string, unknown>;

/** Read one or more ephemeral state keys from the service worker. */
export async function getState(keys: string | string[] | StateValues): Promise<StateValues> {
  return callBackground<StateValues>('getState', keys);
}

export async function setState(values: StateValues): Promise<void> {
  await callBackground('setState', values);
}

/**
 * Page-local memory, deliberately NOT shared with the service worker.
 *
 * The options page uses this to reopen on the screen you left; it is a
 * property of this tab, not of the extension.
 */
const LOCAL_PREFIX = 'delta.local.';
/** Pre-rename prefix; read as a fallback then rewritten on next set. */
const LEGACY_LOCAL_PREFIX = 'omega.local.';

export const localState = {
  get(key: string): string | null {
    const current = localStorage.getItem(LOCAL_PREFIX + key);
    if (current !== null) return current;
    const legacy = localStorage.getItem(LEGACY_LOCAL_PREFIX + key);
    if (legacy === null) return null;
    try {
      localStorage.setItem(LOCAL_PREFIX + key, legacy);
      localStorage.removeItem(LEGACY_LOCAL_PREFIX + key);
    } catch {
      // Quota / private mode: still return the legacy value.
    }
    return legacy;
  },
  set(key: string, value: string): void {
    localStorage.setItem(LOCAL_PREFIX + key, value);
    try {
      localStorage.removeItem(LEGACY_LOCAL_PREFIX + key);
    } catch {
      // Ignore.
    }
  },
};

// --- Options ----------------------------------------------------------------

export interface PageInfo {
  url: string;
  domain: string;
  tempRuleProfileName?: string;
}

export const api = {
  getAll: () => callBackground<OptionsBag>('getAll'),
  patch: (delta: unknown) => callBackground<OptionsBag>('patch', delta),
  reset: (options: unknown) => callBackground<OptionsBag>('reset', options),

  applyProfile: (name: string) => callBackground('applyProfile', name),
  applyProfileNoReply: (name: string) => callBackgroundNoReply('applyProfile', name),

  addProfile: (profile: Profile) => callBackground<Profile>('addProfile', profile),
  renameProfile: (from: string, to: string) => callBackground('renameProfile', from, to),
  replaceRef: (from: string, to: string) => callBackground('replaceRef', from, to),
  setDefaultProfile: (profileName: string, defaultProfileName: string) =>
    callBackground('setDefaultProfile', profileName, defaultProfileName),

  addTempRule: (domain: string, profileName: string) =>
    callBackground('addTempRule', domain, profileName),
  addCondition: (condition: unknown, profileName: string) =>
    callBackground('addCondition', condition, profileName),

  updateProfile: (name?: string, bypassCache?: boolean) =>
    callBackground<Record<string, unknown>>('updateProfile', name, bypassCache),

  getPageInfo: (info: { tabId?: number; url?: string }) =>
    callBackground<PageInfo | null>('getPageInfo', info),

  setOptionsSync: (enabled: boolean, args?: { force?: boolean }) =>
    callBackground('setOptionsSync', enabled, args),
  resetOptionsSync: () => callBackground('resetOptionsSync'),

  proxyAuthStatus: () =>
    callBackground<{ hasCredentials: boolean; hostAccess: boolean }>('proxyAuthStatus'),
};

/**
 * Ask for the optional `<all_urls>` host permission that proxy authentication
 * needs. Must be called synchronously from a user gesture.
 */
export function requestHostAccess(): Promise<boolean> {
  return chrome.permissions.request({ origins: ['<all_urls>'] });
}

// --- Tabs -------------------------------------------------------------------

const INTERNAL_URL = /^(chrome|about|moz-|edge|chrome-extension):/;

export function isInternalUrl(url: string | undefined): boolean {
  return !!url && INTERNAL_URL.test(url);
}

/** The active tab, or undefined when it is a page we cannot act on. */
export async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

export async function refreshActivePage(): Promise<void> {
  const tab = await getActiveTab();
  if (!tab?.id || isInternalUrl(tab.url)) return;
  await chrome.tabs.reload(tab.id, { bypassCache: true });
}

/**
 * Show the settings in Chrome's side panel.
 *
 * Must be called synchronously from a user gesture — the API rejects
 * otherwise, and awaiting anything first loses the gesture. Returns false when
 * the panel is unavailable so the caller can fall back to a tab.
 */
export function openSidePanel(): boolean {
  if (!chrome.sidePanel?.open) return false;
  try {
    // windowId is resolved by Chrome from the calling context.
    void chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
    return true;
  } catch {
    return false;
  }
}

/** Focus the existing options tab if there is one, otherwise open it. */
export async function openOptions(hash = ''): Promise<void> {
  const url = chrome.runtime.getURL('options.html');
  const tabs = await chrome.tabs.query({ url });
  const existing = tabs[0];
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true, url: url + hash });
    if (existing.windowId !== undefined) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url: url + hash });
}

export function openManage(): void {
  void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
}

export function openShortcutConfig(): void {
  void chrome.tabs.create({ url: 'chrome://extensions/configureCommands' });
}
