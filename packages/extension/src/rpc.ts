/**
 * Explicit RPC surface of the service worker.
 *
 * Method names are mapped to functions — never looked up by reflection on
 * `ChromeOptions` — so a compromised page cannot reach `fetchUrl`, `upgrade`,
 * or other worker-only hooks. Callers must be this extension (`sender.id`);
 * when `sender.origin` is present it must be an extension-page origin.
 * Profile `auth` is stripped from replies unless the sender is a trusted
 * extension page (popup / options / side panel).
 */

import type { Profile } from '@switchydelta/pac';
import type { BrowserStorage, StorageItems } from '@switchydelta/target';

import type { ChromeOptions } from './chrome-options.js';

export interface RpcContext {
  options: ChromeOptions;
  state: BrowserStorage;
}

type RpcHandler = (ctx: RpcContext, args: unknown[]) => unknown;

/**
 * Origin of this extension's pages (`chrome-extension://<id>` or
 * `moz-extension://<uuid>`). Derived from `getURL` so Firefox's internal
 * UUID matches `sender.origin`. `URL.origin` is not used: Node (and some
 * hosts) treat these as non-special schemes and would report `"null"`.
 */
export function extensionPageOrigin(): string {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      const base = chrome.runtime.getURL('');
      return base.endsWith('/') ? base.slice(0, -1) : base;
    }
  } catch {
    // Tests, or a runtime without getURL: fall through to the Chrome form.
  }
  return `chrome-extension://${chrome.runtime.id}`;
}

function isExtensionPageUrl(url: string, extOrigin: string): boolean {
  return url === extOrigin || url.startsWith(`${extOrigin}/`);
}

export interface SenderAuthorization {
  allowed: boolean;
  /** Popup, options page, or side panel — may receive profile `auth`. */
  trustedPage: boolean;
}

/**
 * Gate an `onMessage` sender.
 *
 * `sender.id` must be this extension. A present `origin` must be the
 * extension-page origin: content scripts share `sender.id` but carry the
 * tab's origin. `url` is used the same way when present.
 */
export function authorizeSender(sender: chrome.runtime.MessageSender): SenderAuthorization {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
    return { allowed: false, trustedPage: false };
  }
  if (sender.id !== chrome.runtime.id) {
    return { allowed: false, trustedPage: false };
  }

  const extOrigin = extensionPageOrigin();
  if (sender.origin != null && sender.origin !== '' && sender.origin !== extOrigin) {
    return { allowed: false, trustedPage: false };
  }
  if (sender.url != null && sender.url !== '' && !isExtensionPageUrl(sender.url, extOrigin)) {
    return { allowed: false, trustedPage: false };
  }

  const trustedPage =
    sender.origin === extOrigin ||
    (typeof sender.url === 'string' && isExtensionPageUrl(sender.url, extOrigin));
  return { allowed: true, trustedPage };
}

function isProfileLike(value: Record<string, unknown>): boolean {
  return typeof value['profileType'] === 'string' && typeof value['name'] === 'string';
}

/** Deep-clone `value`, dropping `auth` on profile-shaped objects. */
export function stripAuthFromResult(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripAuthFromResult);
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const dropAuth = isProfileLike(input);
  for (const [key, child] of Object.entries(input)) {
    if (dropAuth && key === 'auth') continue;
    output[key] = stripAuthFromResult(child);
  }
  return output;
}

export const RPC_METHODS: Record<string, RpcHandler> = {
  getState: (ctx, args) => ctx.state.get(args[0] as string | string[] | StorageItems),
  setState: (ctx, args) => ctx.state.set(args[0] as StorageItems),

  getAll: (ctx) => ctx.options.getAll(),
  patch: (ctx, args) => ctx.options.patch(args[0] as never),
  reset: (ctx, args) => ctx.options.reset(args[0] as never),
  applyChanges: (ctx, args) => ctx.options.applyChanges(args[0] as StorageItems),

  applyProfile: (ctx, args) => ctx.options.applyProfile(args[0] as string),
  addProfile: (ctx, args) => ctx.options.addProfile(args[0] as Profile),
  renameProfile: (ctx, args) => ctx.options.renameProfile(args[0] as string, args[1] as string),
  replaceRef: (ctx, args) => ctx.options.replaceRef(args[0] as string, args[1] as string),
  setDefaultProfile: (ctx, args) =>
    ctx.options.setDefaultProfile(args[0] as string, args[1] as string),

  addTempRule: (ctx, args) => ctx.options.addTempRule(args[0] as string, args[1] as string),
  addCondition: (ctx, args) => ctx.options.addCondition(args[0] as never, args[1] as string),

  updateProfile: (ctx, args) =>
    ctx.options.updateProfile(
      args[0] as string | string[] | null | undefined,
      args[1] as boolean | undefined,
    ),
  pacForProfile: (ctx, args) => ctx.options.pacForProfile(args[0] as string),

  setOptionsSync: (ctx, args) =>
    ctx.options.setOptionsSync(args[0] as boolean, args[1] as { force?: boolean } | undefined),
  resetOptionsSync: (ctx) => ctx.options.resetOptionsSync(),
  proxyAuthStatus: (ctx) => ctx.options.proxyAuthStatus(),

  // e2e introspection; not part of the UI messaging layer.
  lastActionIconPaint: (ctx) => ctx.options.lastActionIconPaint(),
  sampleActionIcon: (ctx, args) =>
    ctx.options.sampleActionIcon(
      args[0] as string,
      args[1] as string | undefined,
      args[2] as number | undefined,
    ),
};

export async function dispatchRpc(
  method: string,
  ctx: RpcContext,
  args: unknown[],
): Promise<unknown> {
  const handler = RPC_METHODS[method];
  if (!handler) throw new Error(`No such method: ${method}`);
  return handler(ctx, args);
}
