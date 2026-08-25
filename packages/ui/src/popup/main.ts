/**
 * Toolbar popup.
 *
 * Replaces both previous popups: the AngularJS `popup.html` app and the
 * hand-rolled `popup/js/*.js` DOM version that had been split out of it.
 *
 * First paint reads the last snapshot the worker published to
 * `chrome.storage.local` (`delta.local.*`), so the menu does not wait on
 * service-worker boot. Worker RPC is the refresh/fallback (first run, and
 * apply / Options / Add condition still go through it).
 */

import { h, must, on, render } from '../lib/dom.js';
import { sanitizeHexColor } from '../lib/hex-color.js';
import { localizeDocument, profileDisplayName, t } from '../lib/i18n.js';
import {
  api,
  getState,
  openOptions,
  openSidePanel,
  refreshActivePage,
  requestHostAccess,
} from '../lib/messaging.js';
import { installShortcuts } from './shortcuts.js';

/** A profile as summarised by the background for display. */
interface AvailableProfile {
  name: string;
  profileType: string;
  color?: string;
  desc?: string;
  builtin?: boolean;
  validResultProfiles?: string[];
}

interface PopupState {
  availableProfiles?: Record<string, AvailableProfile>;
  currentProfileName?: string;
  isSystemProfile?: boolean;
  currentProfileCanAddRule?: boolean;
  proxyNotControllable?: string | null;
  refreshOnProfileChange?: boolean;
}

/** Keys `Options` publishes for the toolbar menu. */
const POPUP_STATE_KEYS = [
  'availableProfiles',
  'currentProfileName',
  'isSystemProfile',
  'currentProfileCanAddRule',
  'proxyNotControllable',
  'refreshOnProfileChange',
] as const;

/**
 * Worker state keys in `chrome.storage.local`. Same prefix as
 * `BrowserStorage` in the service worker (`packages/extension/src/sw.ts`).
 */
const STATE_PREFIX = 'delta.local.';

/** One letter per profile type, shown inside the colour swatch. */
const TYPE_INITIAL: Record<string, string> = {
  DirectProfile: 'D',
  SystemProfile: 'S',
  FixedProfile: 'F',
  PacProfile: 'P',
  VirtualProfile: 'V',
  SwitchProfile: 'A',
  RuleListProfile: 'L',
  SwitchyRuleListProfile: 'L',
  AutoProxyRuleListProfile: 'L',
};

const TYPE_ORDER: Record<string, number> = {
  DirectProfile: 0,
  SystemProfile: 0,
  FixedProfile: 1,
  PacProfile: 2,
  VirtualProfile: 3,
  SwitchProfile: 4,
  RuleListProfile: 5,
  SwitchyRuleListProfile: 5,
  AutoProxyRuleListProfile: 5,
};

let state: PopupState = {};
let uiBound = false;

/**
 * Read the last-published menu snapshot without waking or waiting on the
 * service worker. Returns null when no snapshot has been written yet.
 */
export async function readPublishedPopupState(): Promise<PopupState | null> {
  const area = chrome.storage?.local;
  if (!area?.get) return null;
  try {
    const keys = POPUP_STATE_KEYS.map((key) => STATE_PREFIX + key);
    const items = (await area.get(keys)) as Record<string, unknown>;
    const snapshot: PopupState = {};
    for (const key of POPUP_STATE_KEYS) {
      const full = STATE_PREFIX + key;
      if (Object.prototype.hasOwnProperty.call(items, full)) {
        (snapshot as Record<string, unknown>)[key] = items[full];
      }
    }
    if (!snapshot.availableProfiles || typeof snapshot.availableProfiles !== 'object') {
      return null;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function applyState(next: PopupState): void {
  state = next;

  if (state.proxyNotControllable) {
    showNotControllable(state.proxyNotControllable);
  } else {
    must('#om-not-controllable').hidden = true;
  }

  renderProfiles();
  updateAddRule();

  if (!uiBound) {
    uiBound = true;
    bindListClicks();
    bindActions();
    installShortcuts();
    // Fire-and-forget so the profile list never waits on the permission check.
    void maybeOfferHostPermission();
  }

  maybeFocus();
}

function maybeFocus(): void {
  const active = document.activeElement;
  // Snapshot then RPC re-render replaces the profile list; the node we
  // focused on first paint is disconnected. Restore keyboard focus unless
  // the user has already moved to another still-mounted menu item.
  if (
    active instanceof HTMLElement &&
    active.isConnected &&
    active.classList.contains('om-item')
  ) {
    return;
  }
  const current = document.querySelector<HTMLElement>('.om-item[aria-current="true"]');
  const item = current ?? document.querySelector<HTMLElement>('.om-item');
  item?.focus();
}

/**
 * Page entry used by `popup.html` and by the popup-open vitest suite.
 *
 * Paints from storage as soon as a snapshot exists, then refreshes from the
 * worker. A hung RPC must not undo a successful snapshot paint; a rejected
 * RPC only shows the error surface when there was no snapshot to fall back on.
 */
export async function bootPopup(): Promise<void> {
  localizeDocument();

  const snapshot = await readPublishedPopupState();
  if (snapshot) applyState(snapshot);

  try {
    const fresh = (await getState([...POPUP_STATE_KEYS])) as PopupState;
    applyState(fresh);
  } catch (err) {
    if (!snapshot) showError(err);
  }
}

function sortedProfiles(): AvailableProfile[] {
  const profiles = Object.values(state.availableProfiles ?? {});
  return profiles
    .filter((p) => !p.name.startsWith('_'))
    .sort((a, b) => {
      const orderA = TYPE_ORDER[a.profileType] ?? 99;
      const orderB = TYPE_ORDER[b.profileType] ?? 99;
      if (orderA !== orderB) return orderA - orderB;
      return a.name.localeCompare(b.name);
    });
}

function renderProfiles(): void {
  const list = must('#om-profiles');
  const profiles = sortedProfiles();

  render(
    list,
    profiles.map((profile) => {
      const isCurrent =
        profile.name === state.currentProfileName ||
        (state.isSystemProfile && profile.profileType === 'SystemProfile');

      return h(
        'li',
        {},
        h(
          'button',
          {
            type: 'button',
            // `om-custom` marks the digit-shortcut targets — the old
            // template's `.custom-profile`. Digits 1-9 pick the first nine;
            // the `?` help overlay reveals the bindings (shortcuts.ts).
            class: profile.builtin ? 'om-item' : 'om-item om-custom',
            dataset: { profile: profile.name },
            'aria-current': isCurrent ? 'true' : 'false',
            title: profile.desc ?? '',
          },
          h(
            'span',
            {
              class: 'om-swatch',
              style: { background: sanitizeHexColor(profile.color) ?? '#cccccc' },
              'aria-hidden': 'true',
            },
            TYPE_INITIAL[profile.profileType] ?? '?',
          ),
          h('span', { class: 'om-name', text: profileDisplayName(profile.name) }),
        ),
      );
    }),
  );
}

function bindListClicks(): void {
  on(must('#om-profiles'), 'click', '.om-item', (_event, target) => {
    const name = target.dataset['profile'];
    if (name) void applyProfile(name);
  });
}

function updateAddRule(): void {
  must<HTMLButtonElement>('#om-add-rule').hidden = !state.currentProfileCanAddRule;
}

function bindActions(): void {
  const addRule = must<HTMLButtonElement>('#om-add-rule');
  addRule.addEventListener('click', () => {
    // Shortcuts still `.click()` this node while it is hidden (`a` / `+` /
    // `=`). The original only bound this handler when the current profile
    // could add a rule; keep that guard now that the listener is always on.
    if (!state.currentProfileCanAddRule) return;
    // The full condition editor lives on the options page; the current
    // tab's host rides along so the editor pre-fills the new rule with it.
    // Close only once openOptions has settled: window.close() tears down
    // this context, and the tab query/create still pending inside
    // openOptions dies with it.
    void (async () => {
      let suffix = '';
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const url = tab?.url ?? '';
        // Only schemes a PAC script would see; hostname is '' for the rest.
        if (/^(https?|ftp|ws|wss):/i.test(url)) {
          const host = new URL(url).hostname;
          if (host) suffix = '?addRuleHost=' + encodeURIComponent(host);
        }
      } catch {
        // No readable tab URL: open the editor without a prefill.
      }
      await openOptions(
        '#/profile/' + encodeURIComponent(state.currentProfileName ?? '') + suffix,
      );
    })().finally(() => window.close());
  });

  // Settings open in the side panel, falling back to a tab where the panel is
  // unavailable. openSidePanel must run before any await, or the user gesture
  // that authorises it is gone.
  must('#om-options').addEventListener('click', () => {
    if (openSidePanel()) {
      window.close();
    } else {
      void openOptions().finally(() => window.close());
    }
  });
}

async function applyProfile(name: string): Promise<void> {
  try {
    if (state.refreshOnProfileChange === false) {
      // Same as the original: no need to wait when we will not reload the tab.
      api.applyProfileNoReply(name);
    } else {
      // A slow apply in the worker used to keep this await — and the menu —
      // stuck with no feedback. Give it a few seconds; if the worker is still
      // busy, close anyway. The apply carries on without us, only the reload
      // of the active tab is skipped.
      const applied = await Promise.race([
        api.applyProfile(name).then(() => true),
        new Promise<false>((resolve) => {
          setTimeout(() => resolve(false), 4000);
        }),
      ]);
      if (applied) await refreshActivePage();
    }
  } catch (err) {
    showError(err);
    return;
  }
  window.close();
}

/**
 * Proxy credentials only take effect once the optional `<all_urls>` host
 * permission is granted, since webRequest events are gated by host access.
 * Offer the grant whenever the permission is missing — even with no
 * credentials configured yet, so auth works the moment one is added.
 */
async function maybeOfferHostPermission(): Promise<void> {
  let hostAccess: boolean;
  try {
    hostAccess = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  } catch {
    return;
  }
  if (hostAccess) return;

  const notice = must('#om-auth-permission');
  notice.hidden = false;
  must('#om-auth-grant').addEventListener('click', () => {
    // requestHostAccess must be called synchronously inside the click gesture.
    void requestHostAccess().then((granted) => {
      if (granted) notice.hidden = true;
    });
  });
}

function showNotControllable(reason: string): void {
  const notice = must('#om-not-controllable');
  notice.hidden = false;
  must('#om-not-controllable-title').textContent = t('popup_proxyNotControllable_' + reason);
  // Only some reasons have a specific detail string; fall back to the generic
  // one like the original template did.
  must('#om-not-controllable-detail').textContent =
    chrome.i18n.getMessage('popup_proxyNotControllableDetails_' + reason) ||
    t('popup_proxyNotControllableDetails');
}

function showError(err: unknown): void {
  const el = must('#om-error');
  el.hidden = false;
  el.textContent = err instanceof Error ? err.message : String(err);
}

if (import.meta.env.MODE !== 'test') void bootPopup();
