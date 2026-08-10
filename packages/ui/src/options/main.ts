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
import { api, callBackground, localState } from '../lib/messaging.js';
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
  pristine[key] = structuredClone(value);
  options[key] = structuredClone(value);
  markDirty();
}

export async function applyChanges(): Promise<void> {
  const changes: Record<string, unknown> = {};
  for (const key of changedKeys()) {
    changes[key] = options[key];
  }
  if (Object.keys(changes).length === 0) return;

  try {
    // `undefined` marks a removed key, matching the storage layer's convention.
    await callBackground('applyChanges', changes);
    pristine = structuredClone(options);
    markDirty();
    must('#om-status').textContent = t('options_saveSuccess');
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
  options = structuredClone(pristine);

  renderProfileNav();

  must('#om-apply').addEventListener('click', () => void applyChanges());
  must('#om-revert').addEventListener('click', () => location.reload());

  // Escape hatch out of the side panel for the wider screens (rule tables in
  // particular are unusable at panel width).
  must('#om-open-tab').addEventListener('click', () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('options.html') + location.hash });
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
