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
import { api, callBackground, localState, requestHostAccess } from '../lib/messaging.js';
import { colorFor, listProfiles } from '../lib/profile-view.js';
import { deepEqual } from '../lib/equal.js';
import {
  renderAbout,
  renderGeneral,
  renderIo,
  renderNewProfile,
  renderProfile,
  renderUi,
} from './views.js';
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
    must('#om-status').textContent = t('options_saveSuccess');
    // Settle the permission prompt after the save so a denial does not block it.
    void hostAccess;
  } catch (err) {
    must('#om-status').textContent = err instanceof Error ? err.message : String(err);
  }
}

// --- Routing ----------------------------------------------------------------

type View = (container: HTMLElement, param: string) => void;

const routes: Array<[RegExp, View]> = [
  [/^#\/ui$/, renderUi],
  [/^#\/general$/, renderGeneral],
  [/^#\/io$/, renderIo],
  [/^#\/about$/, renderAbout],
  [/^#\/new$/, renderNewProfile],
  [/^#\/profile\/(.*)$/, renderProfile],
];

function route(): void {
  const hash = location.hash || '#/about';
  const container = must('#om-view');

  for (const [pattern, view] of routes) {
    const match = pattern.exec(hash);
    if (match) {
      container.replaceChildren();
      view(container, decodeURIComponent(match[1] ?? ''));
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

// --- Boot -------------------------------------------------------------------

async function main(): Promise<void> {
  localizeDocument();

  try {
    pristine = await api.getAll();
  } catch (err) {
    must('#om-view').textContent = err instanceof Error ? err.message : String(err);
    return;
  }
  options = snapshot(pristine);

  renderProfileNav();

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
}

void main();
