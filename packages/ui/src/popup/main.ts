/**
 * Toolbar popup.
 *
 * Replaces both previous popups: the AngularJS `popup.html` app and the
 * hand-rolled `popup/js/*.js` DOM version that had been split out of it.
 *
 * The popup holds no state of its own — it reads a snapshot from the service
 * worker, renders it, and closes as soon as the user picks something.
 */

import { h, must, on, render } from '../lib/dom.js';
import { localizeDocument, profileDisplayName, t } from '../lib/i18n.js';
import { installShortcuts } from './shortcuts.js';
import {
  api,
  getState,
  openOptions,
  openSidePanel,
  refreshActivePage,
  requestHostAccess,
} from '../lib/messaging.js';

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

async function main(): Promise<void> {
  localizeDocument();

  try {
    state = (await getState([
      'availableProfiles',
      'currentProfileName',
      'isSystemProfile',
      'currentProfileCanAddRule',
      'proxyNotControllable',
      'refreshOnProfileChange',
    ])) as PopupState;
  } catch (err) {
    showError(err);
    return;
  }

  if (state.proxyNotControllable) {
    showNotControllable(state.proxyNotControllable);
  }

  renderProfiles();
  wireActions();
  installShortcuts();

  // Fire-and-forget so the profile list never waits on the permission check.
  void maybeOfferHostPermission();

  // Focus the current profile so keyboard use starts from a sensible place.
  const current = document.querySelector<HTMLElement>('.om-item[aria-current="true"]');
  (current ?? document.querySelector<HTMLElement>('.om-item'))?.focus();
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
              style: { background: profile.color ?? '#cccccc' },
              'aria-hidden': 'true',
            },
            TYPE_INITIAL[profile.profileType] ?? '?',
          ),
          h('span', { class: 'om-name', text: profileDisplayName(profile.name) }),
        ),
      );
    }),
  );

  on(list, 'click', '.om-item', (_event, target) => {
    const name = target.dataset['profile'];
    if (name) void applyProfile(name);
  });
}

function wireActions(): void {
  const addRule = must<HTMLButtonElement>('#om-add-rule');
  if (state.currentProfileCanAddRule) {
    addRule.hidden = false;
    addRule.addEventListener('click', () => {
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
  }

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
    await api.applyProfile(name);
    if (state.refreshOnProfileChange !== false) {
      await refreshActivePage();
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

void main();
