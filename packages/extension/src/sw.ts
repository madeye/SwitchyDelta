/**
 * MV3 service worker entry point.
 *
 * Responsibilities in this build, and nothing more:
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
import { ProxySettings } from './proxy-settings.js';

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
const proxySettings = new ProxySettings();

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

  options = new ChromeOptions(null, storage, state, Log, sync, proxySettings);
  await options.ready;
  return options;
}

const ready = boot().catch((err: unknown) => {
  Log.error('Service worker boot failed', err);
  throw err;
});

// Paint the action icon for the restored profile on every worker start.
void ready.then(() => options?.currentProfileChanged('boot'));

/**
 * Track who controls the proxy setting.
 *
 * Another extension or an enterprise policy can take the setting away, in
 * which case our writes succeed silently but change nothing — the popup
 * notice and the red "=" badge are the only way the user learns why nothing
 * happens. Registered at the top level so the event can wake the worker.
 */
let externalProfileTimer: ReturnType<typeof setTimeout> | undefined;
function handleProxyChange(details: chrome.types.ChromeSettingGetResultDetails): void {
  void (async () => {
    await ready;
    const target = options;
    if (!target || !details) return;

    const notControllableBefore = target.proxyNotControllable();
    let internal = false;
    let noRevert = false;
    switch (details.levelOfControl) {
      case 'controlled_by_other_extensions':
      case 'not_controllable':
        target.setProxyNotControllable(
          details.levelOfControl === 'not_controllable' ? 'policy' : 'app',
        );
        noRevert = true;
        break;
      default:
        target.setProxyNotControllable(null);
    }

    if (details.levelOfControl === 'controlled_by_this_extension') {
      internal = true;
      // Our own writes are only interesting when control was just regained.
      if (!notControllableBefore) return;
    }
    Log.log('external proxy change', details.levelOfControl);

    const parsed = proxySettings.parseExternalProfile(details, await target.getAll());
    clearTimeout(externalProfileTimer);
    externalProfileTimer = setTimeout(() => {
      if (parsed) target.setExternalProfile(parsed, { noRevert, internal });
    }, 500);
  })();
}
chrome.proxy.settings.onChange.addListener(handleProxyChange);
void ready.then(() => chrome.proxy.settings.get({}, handleProxyChange));

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
