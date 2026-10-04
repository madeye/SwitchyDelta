/**
 * Options page shell: routing, the working copy of options, and saving.
 *
 * The AngularJS version deep-diffed the whole options object with jsondiffpatch
 * and sent the resulting delta to the background, which immediately reduced it
 * back to a map of changed top-level keys. Options is a flat bag at the top
 * level, so this compares top-level keys directly and sends that map — same
 * result, no diff library in the bundle.
 */

import { must, on, render } from '../lib/dom.js';
import { localizeDocument, profileDisplayName, t } from '../lib/i18n.js';
import {
  api,
  callBackground,
  getState,
  localState,
  requestHostAccess,
} from '../lib/messaging.js';
import { colorFor, listProfiles, sanitizeFallbackProxySchemes } from '../lib/profile-view.js';
import { deepEqual } from '../lib/equal.js';
import {
  renderAbout,
  renderGeneral,
  renderIo,
  renderNewProfile,
  renderProfile,
  renderUi,
} from './views.js';
import { maybeShowFirstRunGuide } from './guide.js';
import type { OptionsBag } from '@switchydelta/pac';

/** The saved state, used to decide what actually changed. */
let pristine: OptionsBag = {};
/** The live, edited copy bound to the form controls. */
export let options: OptionsBag = {};

/**
 * Clone the options bag for dirty tracking. Unlike structuredClone this
 * shares strings between the copies — rule-list texts are the bulk of the bag
 * and every edit path assigns a new string rather than mutating — while
 * object and array nodes still get distinct identities, which the in-place
 * edits and deepEqual comparisons rely on. The bag is JSON-shaped by
 * construction (it round-trips chrome.storage), so no other types occur.
 */
function snapshot<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(snapshot) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as object)) out[key] = snapshot(entry);
  return out as T;
}

export function isDirty(): boolean {
  return changedKeys().length > 0;
}

export function markDirty(): void {
  const dirty = isDirty();
  must<HTMLButtonElement>('#om-apply').disabled = !dirty;
  must<HTMLButtonElement>('#om-revert').disabled = !dirty;
  // As in the original, the enabled Apply/Discard buttons are the unsaved-
  // changes indicator; there is no catalogue string for a status line.
  must('#om-status').textContent = '';
}

function changedKeys(): string[] {
  const keys = new Set([...Object.keys(pristine), ...Object.keys(options)]);
  return [...keys].filter((key) => !deepEqual(pristine[key], options[key]));
}

/** Adopt a background-refreshed value for one key without marking it dirty. */
export function adoptOptionsKey(key: string, value: unknown): void {
  pristine[key] = snapshot(value);
  options[key] = snapshot(value);
  markDirty();
}

export async function applyChanges(): Promise<void> {
  const changes: Record<string, unknown> = {};
  for (const key of changedKeys()) {
    changes[key] = options[key];
  }
  if (Object.keys(changes).length === 0) return;

  // Start the optional host grant before any await so the call stays inside
  // the Apply click gesture. Without `<all_urls>`, onAuthRequired never
  // fires; asked even with no credentials configured yet, so auth works the
  // moment one is added. Resolves silently when already granted.
  const hostAccess = requestHostAccess();

  try {
    // `undefined` marks a removed key, matching the storage layer's convention.
    await callBackground('applyChanges', changes);
    pristine = snapshot(options);
    markDirty();
    // Renames, deletions and new profiles change what can be activated.
    renderActiveProfile();
    must('#om-status').textContent = t('options_saveSuccess');
    // Settle the permission prompt after the save so a denial does not block it.
    void hostAccess;
  } catch (err) {
    must('#om-status').textContent = err instanceof Error ? err.message : String(err);
  }
}

// --- Routing ----------------------------------------------------------------

type View = (container: HTMLElement, param: string, query?: URLSearchParams) => void;

/**
 * A view-installed veto on leaving the current route. The switch profile's
 * source editor registers one so touched, unparseable text blocks navigation
 * instead of being silently discarded — the ported form of the original
 * controller's `$stateChangeStart` + `event.preventDefault()` guard. The
 * router clears it whenever a new view renders.
 */
let navigationGuard: (() => boolean) | null = null;

export function setNavigationGuard(guard: (() => boolean) | null): void {
  navigationGuard = guard;
}

/** The hash of the view currently on screen, for reverting vetoed navigation. */
let currentHash = '';
/** Set while the router restores the hash itself, so route() skips one event. */
let revertingHash = false;

const routes: Array<[RegExp, View]> = [
  [/^#\/ui$/, renderUi],
  [/^#\/general$/, renderGeneral],
  [/^#\/io$/, renderIo],
  [/^#\/about$/, renderAbout],
  [/^#\/new$/, renderNewProfile],
  [/^#\/profile\/(.*)$/, renderProfile],
];

function route(): void {
  if (revertingHash) {
    // This event is the router undoing a vetoed navigation; the view on
    // screen (including any editor state) must stay untouched.
    revertingHash = false;
    return;
  }
  const rawHash = location.hash || '#/about';
  // One-shot query parameters (e.g. the popup's `?addRuleHost=…`) ride on the
  // fragment. Routes match on the path alone, and the query is stripped from
  // the address bar so a reload or revisit does not repeat the action.
  const queryAt = rawHash.indexOf('?');
  const hash = queryAt < 0 ? rawHash : rawHash.slice(0, queryAt);
  const query = queryAt < 0 ? undefined : new URLSearchParams(rawHash.slice(queryAt + 1));
  if (currentHash && hash !== currentHash && navigationGuard && !navigationGuard()) {
    revertingHash = true;
    location.hash = currentHash;
    return;
  }
  navigationGuard = null;
  if (queryAt >= 0) history.replaceState(null, '', location.pathname + location.search + hash);
  const container = must('#om-view');

  for (const [pattern, view] of routes) {
    const match = pattern.exec(hash);
    if (match) {
      currentHash = hash;
      container.replaceChildren();
      view(container, decodeURIComponent(match[1] ?? ''), query);
      localizeDocument(container);
      highlightNav(hash);
      localState.set('lastUrl', hash);
      return;
    }
  }

  location.hash = '#/about';
}

function highlightNav(hash: string): void {
  for (const link of document.querySelectorAll<HTMLAnchorElement>('.om-sidebar .om-item')) {
    link.setAttribute('aria-current', link.getAttribute('href') === hash ? 'page' : 'false');
  }
}

function renderProfileNav(): void {
  const nav = must('#om-nav-profiles');
  render(
    nav,
    listProfiles(options).map((profile) => {
      const link = document.createElement('a');
      link.className = 'om-item';
      link.href = '#/profile/' + encodeURIComponent(profile.name);
      // The first-run guide points at profiles by type, as the original's
      // `.nav-profile[data-profile-type=...]` markup allowed.
      link.dataset['profileType'] = profile.profileType;

      const swatch = document.createElement('span');
      swatch.className = 'om-swatch';
      swatch.style.background = colorFor(profile, options);

      const label = document.createElement('span');
      label.textContent = profileDisplayName(profile.name);

      link.append(swatch, label);
      const li = document.createElement('li');
      li.append(link);
      return li;
    }),
  );

  const newLink = document.createElement('a');
  newLink.className = 'om-item om-item-new';
  newLink.href = '#/new';
  newLink.textContent = t('options_newProfile');
  const li = document.createElement('li');
  li.append(newLink);
  nav.append(li);
}

// --- Active profile switcher (side panel) -----------------------------------
//
// At panel width the profile chips only open editors, and the popup that
// normally switches the proxy is a separate surface the panel covers the need
// for. This dropdown activates a profile without leaving the panel. It lists
// the *saved* profiles — an unsaved one does not exist for the worker yet.

const STATE_PREFIX = 'delta.local.';
const ACTIVE_STATE_KEYS = ['currentProfileName', 'isSystemProfile'];
let activeProfileName = '';

function renderActiveProfile(): void {
  const select = must('#om-active-select') as HTMLSelectElement;
  const names = ['direct', 'system', ...listProfiles(pristine).map((profile) => profile.name)];
  // A temp-rule or otherwise hidden current profile still has to show up,
  // or the control would silently claim the first entry is active.
  if (activeProfileName && !names.includes(activeProfileName)) names.push(activeProfileName);

  render(
    select,
    names.map((name) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = profileDisplayName(name);
      option.selected = name === activeProfileName;
      return option;
    }),
  );

  const active = pristine['+' + activeProfileName] as Parameters<typeof colorFor>[0] | undefined;
  must('#om-active-swatch').style.background = active
    ? colorFor(active, pristine)
    : activeProfileName === 'system'
      ? '#000000'
      : '#aaaaaa';
}

async function refreshActiveProfile(): Promise<void> {
  try {
    const state = await getState(ACTIVE_STATE_KEYS);
    activeProfileName = state['isSystemProfile']
      ? 'system'
      : String(state['currentProfileName'] ?? '');
  } catch {
    // Worker unreachable: keep showing the last known profile.
  }
  renderActiveProfile();
}

function bindActiveProfile(): void {
  const select = must('#om-active-select') as HTMLSelectElement;
  select.addEventListener('change', () => {
    const name = select.value;
    select.disabled = true;
    api
      .applyProfile(name)
      .catch((err: unknown) => {
        must('#om-status').textContent = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        select.disabled = false;
        void refreshActiveProfile();
      });
  });

  // The popup, a keyboard shortcut or startup can switch profiles behind the
  // panel's back; the worker publishes that to storage.
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    if (ACTIVE_STATE_KEYS.some((key) => STATE_PREFIX + key in changes)) {
      void refreshActiveProfile();
    }
  });
}

/**
 * The narrow layout stacks a sticky toolbar under the sticky chip header,
 * whose height depends on how many rows the profile chips wrap onto.
 */
function trackSidebarHeight(): void {
  const sidebar = must('.om-sidebar');
  const apply = () => {
    document.body.style.setProperty('--om-sidebar-h', sidebar.offsetHeight + 'px');
  };
  apply();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(apply).observe(sidebar);
}

// --- Boot -------------------------------------------------------------------

async function main(): Promise<void> {
  localizeDocument();

  try {
    pristine = await api.getAll();
  } catch (err) {
    must('#om-view').textContent = err instanceof Error ? err.message : String(err);
    return;
  }
  sanitizeFallbackProxySchemes(pristine);
  options = snapshot(pristine);

  renderProfileNav();
  bindActiveProfile();
  void refreshActiveProfile();
  trackSidebarHeight();

  must('#om-apply').addEventListener('click', () => void applyChanges());
  must('#om-revert').addEventListener('click', () => location.reload());

  // Escape hatch out of the side panel for the wider screens (rule tables in
  // particular are unusable at panel width).
  must('#om-open-tab').addEventListener('click', () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('options.html') + location.hash });
  });

  // External links (About privacy/FAQ/license, help text) cannot navigate
  // inside the side panel / options page; open them in a normal browser tab.
  document.addEventListener('click', (event) => {
    const anchor = (event.target as Element | null)?.closest?.('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href || !/^https?:\/\//i.test(href)) return;
    event.preventDefault();
    void chrome.tabs.create({ url: href });
  });

  // Any control carrying data-option writes straight into the working copy.
  on(document, 'change', '[data-option]', (_event, target) => {
    const key = target.dataset['option'];
    if (!key) return;
    const input = target as HTMLInputElement;
    options[key] =
      input.type === 'checkbox'
        ? input.checked
        : input.type === 'number'
          ? Number(input.value)
          : input.value;
    markDirty();
  });

  window.addEventListener('hashchange', route);
  window.addEventListener('beforeunload', (event) => {
    if (changedKeys().length > 0) event.preventDefault();
  });

  if (!location.hash) {
    location.hash = localState.get('lastUrl') ?? '#/about';
  }
  route();
  markDirty();

  // First-run welcome + walkthrough (the original ran this once from the
  // first options-change callback).
  void maybeShowFirstRunGuide();
}

void main();
