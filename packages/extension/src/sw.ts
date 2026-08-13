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

import { watchActiveTab } from './active-tab-icon.js';
import { ChromeOptions } from './chrome-options.js';
import { ChromeStorage } from './chrome-storage.js';
import { ProxyAuth } from './proxy-auth.js';
import { ProxySettings } from './proxy-settings.js';
import { authorizeSender, dispatchRpc, stripAuthFromResult } from './rpc.js';

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
const STATE_PREFIX = 'delta.local.';
const LEGACY_STATE_PREFIX = 'omega.local.';
const state = new BrowserStorage(STATE_PREFIX);
const proxySettings = new ProxySettings();

/**
 * One-shot rename of worker state keys `omega.local.*` → `delta.local.*`.
 * Profile options live under unprefixed keys and are untouched.
 */
async function migrateLegacyStatePrefix(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  try {
    const all = await chrome.storage.local.get(null);
    const moves: Record<string, unknown> = {};
    const remove: string[] = [];
    for (const [key, value] of Object.entries(all ?? {})) {
      if (!key.startsWith(LEGACY_STATE_PREFIX)) continue;
      const next = STATE_PREFIX + key.slice(LEGACY_STATE_PREFIX.length);
      if (!(next in (all ?? {}))) moves[next] = value;
      remove.push(key);
    }
    if (Object.keys(moves).length) await chrome.storage.local.set(moves);
    if (remove.length) await chrome.storage.local.remove(remove);
  } catch {
    // Boot continues with empty state if migration fails.
  }
}

async function boot(): Promise<Options> {
  await migrateLegacyStatePrefix();

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
  // The popup only needs the profile list, which `uiReady` publishes. `ready`
  // additionally waits for the startup profile to reach the browser, and
  // `chrome.proxy.settings.set` is slow (a large rule-list PAC) or outright
  // stalled (another extension holding the setting) often enough that waiting
  // on it here is what left the menu blank.
  await options.uiReady;
  void options.ready.catch((err: unknown) => {
    Log.error('Options apply failed', err);
  });
  return options;
}

const ready = boot().catch((err: unknown) => {
  Log.error('Service worker boot failed', err);
  throw err;
});

// Paint the action icon for the restored profile on every worker start.
void ready.then(() => options?.currentProfileChanged('boot'));

/**
 * Still the first turn (module evaluation is synchronous), so these events
 * can wake the worker: tab switches and navigations retint the icon when the
 * current profile is an auto switch. The callback boots the options first;
 * for static profiles a session-storage flag short-circuits before boot.
 */
watchActiveTab(() => {
  void ready.then(() => options?.updateIconForActiveTab());
});

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
 * The UI sends `{method, args}` and expects `{result}` or `{error}`. Methods
 * are dispatched through the allowlist in `rpc.ts`, not by reflecting on
 * `ChromeOptions`.
 */
chrome.runtime.onMessage.addListener((request, sender, respond) => {
  const { method, args = [], noReply } = (request ?? {}) as {
    method?: string;
    args?: unknown[];
    noReply?: boolean;
  };
  if (!method) return false;

  const authz = authorizeSender(sender);
  if (!authz.allowed) {
    if (!noReply) respond({ error: encodeError(new Error('Unauthorized')) });
    return !noReply;
  }

  void (async () => {
    try {
      await ready;
      const target = options;
      if (!target) throw new Error('Options are not ready');

      // Everything the popup calls must be answerable from `uiReady` alone.
      // The rest of the RPC surface reads or writes the applied profile, so it
      // still waits for the boot-time apply to settle. `applyProfile` is safe
      // to let through early because applies reach the browser in call order,
      // so the user's pick lands after the startup one it overtakes rather
      // than being reverted by it (see Options#applyProfile).
      if (method !== 'getState' && method !== 'setState' && method !== 'applyProfile') {
        await target.ready;
      }

      let result: unknown = await dispatchRpc(method, { options: target, state }, args);

      if (noReply) return;
      // updateProfile resolves to a map that may contain Errors per profile.
      if (method === 'updateProfile' && result && typeof result === 'object') {
        const encoded: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
          encoded[key] = encodeError(value);
        }
        result = encoded;
      }
      if (!authz.trustedPage) result = stripAuthFromResult(result);
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
