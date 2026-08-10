/**
 * MV3 service worker entry point.
 *
 * Responsibilities in this build, and nothing more:
 *   - proxy authentication (the only context where onAuthRequired can live)
 *   - scheduled PAC / rule-list downloads, via chrome.alarms
 *   - applying the selected profile to chrome.proxy.settings
 *   - answering RPC from the options page and popup
 *
 * The worker is event-driven and is expected to be suspended when idle. Nothing
 * here may assume it stays resident.
 */

import { BrowserStorage, OptionsSync, Options, Log } from '@switchydelta/target';
import type { StorageItems } from '@switchydelta/target';

import { ChromeOptions } from './chrome-options.js';
import { ChromeStorage } from './chrome-storage.js';
import { ProxyAuth } from './proxy-auth.js';
import { ProxySettings } from './proxy-settings.js';

/**
 * Registered before anything async runs.
 *
 * MV3 delivers the event that woke the worker only if its listener was
 * registered in the first turn of the event loop. Deferring this until boot()
 * resolves would drop the auth challenge that started the worker.
 */
ProxyAuth.shared(Log).listen();

/** An Error flattened for structured cloning back to the UI. */
function encodeError(value: unknown): unknown {
  if (!(value instanceof Error)) return value;
  return {
    _error: 'error',
    name: value.name,
    message: value.message,
    stack: value.stack,
    original: (value as Error & { original?: unknown }).original,
  };
}

let options: ChromeOptions | undefined;
const state = new BrowserStorage('omega.local.');

async function boot(): Promise<Options> {
  const storage = new ChromeStorage('local');

  // Sync is optional: it is absent when the browser has sync storage disabled.
  let sync: OptionsSync | null = null;
  if (chrome.storage.sync) {
    sync = new OptionsSync(new ChromeStorage('sync'));
    sync.transformValue = Options.transformValueForSync;
    // Read the persisted preference before Options.init runs, so a first push
    // cannot overwrite remote state that the user has not opted into syncing.
    const { syncOptions } = await state.get({ syncOptions: '' });
    sync.enabled = syncOptions === 'sync';
  }

  options = new ChromeOptions(null, storage, state, Log, sync, new ProxySettings());
  await options.ready;
  return options;
}

const ready = boot().catch((err: unknown) => {
  Log.error('Service worker boot failed', err);
  throw err;
});

/**
 * RPC dispatcher.
 *
 * The UI sends `{method, args}` and expects `{result}` or `{error}`.
 */
chrome.runtime.onMessage.addListener((request, _sender, respond) => {
  const { method, args = [], noReply } = (request ?? {}) as {
    method?: string;
    args?: unknown[];
    noReply?: boolean;
  };
  if (!method) return false;

  void (async () => {
    try {
      await ready;
      const target = options;
      if (!target) throw new Error('Options are not ready');

      let result: unknown;
      if (method === 'getState') {
        result = await state.get(args[0] as string | string[] | StorageItems);
      } else if (method === 'setState') {
        result = await state.set(args[0] as StorageItems);
      } else {
        const fn = (target as unknown as Record<string, unknown>)[method];
        if (typeof fn !== 'function') throw new Error(`No such method: ${method}`);
        result = await (fn as (...a: unknown[]) => unknown).apply(target, args);
      }

      if (noReply) return;
      // updateProfile resolves to a map that may contain Errors per profile.
      if (method === 'updateProfile' && result && typeof result === 'object') {
        const encoded: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(result)) {
          encoded[key] = encodeError(value);
        }
        result = encoded;
      }
      respond({ result });
    } catch (error) {
      if (!noReply) respond({ error: encodeError(error) });
    }
  })();

  // Keeps the message channel open for the async response.
  return !noReply;
});

/** Reapply the current profile when the browser starts cold. */
chrome.runtime.onStartup?.addListener(() => {
  void ready.then(() => options?.applyProfile(options.currentProfile()?.name ?? 'system'));
});
