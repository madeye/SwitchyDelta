/**
 * Keyboard shortcuts for the popup.
 *
 * Ported from the shortcut layer of `omega-web/src/coffee/popup.coffee`
 * (everything above `PopupCtrl`). The original matched legacy `event.keyCode`
 * numbers; this port matches `event.key`. Letter shortcuts stay
 * case-insensitive, which is what the keyCode matching gave users for free.
 *
 * The old template tagged each shortcut-triggering anchor with a
 * `data-shortcut` attribute; the popup DOM in `main.ts` has no such tags, so
 * `actionTargets` below maps each action name onto the element that now
 * triggers it.
 */

import { all, h } from '../lib/dom.js';

/** Focus-moving handler for the j/k and arrow keys. */
type NavHandler = (activeIndex: number, items: HTMLElement[]) => void;

/** A shortcut is a named action, a 1-based custom-profile digit, or a NavHandler. */
type Shortcut = string | number | NavHandler;

function moveUp(activeIndex: number, items: HTMLElement[]): void {
  const i = activeIndex - 1;
  // Deliberately no wrap-around at the top: the original guarded `i >= 0`
  // precisely because jQuery's .eq(-1) would otherwise wrap to the last item.
  if (i >= 0) items[i]?.focus();
}

function moveDown(activeIndex: number, items: HTMLElement[]): void {
  // Indexing past the end finds nothing, so there is no wrap-around at the
  // bottom either. With no item focused (activeIndex -1) this lands on the
  // first item, as before.
  items[activeIndex + 1]?.focus();
}

/**
 * `event.key` -> shortcut. Same table as the original's keyCode map, plus
 * digits 1-9 for the custom profiles. The `=`/`+` aliases for addRule kept
 * their intended meaning: the original listed keyCodes 43 and 61, which only
 * ever matched on Firefox — Chrome reports the =/+ key as 187 on keydown.
 */
const shortcutKeys: Record<string, Shortcut> = {
  ArrowUp: moveUp,
  ArrowDown: moveDown,
  j: moveDown,
  k: moveUp,
  '0': '+direct',
  s: '+system',
  '/': 'help',
  '?': 'help',
  e: 'external',
  a: 'addRule',
  '+': 'addRule',
  '=': 'addRule',
  // The original also bound `t` to the temp-rule dropdown. That popup menu was
  // not ported (see MIGRATION.md, "Scope of the service worker"), so the key
  // is unbound here rather than mapped to a target that no longer exists —
  // otherwise it would be silently swallowed by the preventDefault below.
  o: 'option',
  r: 'requestInfo',
};

for (let i = 1; i <= 9; i++) shortcutKeys[String(i)] = i;

/**
 * Where each named action lives in the current popup DOM.
 *
 * `external` and `requestInfo` have no element in this build — the
 * external-profile and request-monitor surfaces were dropped (see
 * MIGRATION.md, "Scope of the service worker") — so those keys resolve to
 * nothing and do nothing, exactly as the original behaved while the anchor
 * was absent. The temp-rule dropdown was dropped too (its `t` key is unbound
 * above), but unlike the other two the backend capability survives:
 * `Options.addTempRule` is still a live RPC.
 */
const actionTargets: Record<string, string> = {
  '+direct': '.om-item[data-profile="direct"]',
  '+system': '.om-item[data-profile="system"]',
  addRule: '#om-add-rule',
  option: '#om-options',
};

function actionTarget(action: string): HTMLElement | null {
  const selector = actionTargets[action];
  return selector ? document.querySelector<HTMLElement>(selector) : null;
}

/**
 * The custom profiles in DOM order; digits 1-9 pick the first nine. Replaces
 * `.custom-profile:not(.ng-hide) > a`. The list is rendered once before
 * shortcuts are installed and never changes, so a live query is equivalent to
 * the original's memoised jQuery set.
 */
function customProfileItems(): HTMLElement[] {
  return all<HTMLElement>('.om-item.om-custom:not([hidden])');
}

/** Show (or refresh) the key hint on one shortcut-triggering element. */
function showHelp(element: HTMLElement, key: string): void {
  let span = element.querySelector<HTMLElement>('.shortcut-help');
  if (!span) {
    span = h('span', { class: 'om-key shortcut-help' });
    element.append(span);
  }
  span.textContent = key;
}

/** The `?` / `/` overlay: a key hint next to every shortcut-triggering element. */
function showShortcutHelp(): void {
  const keys: Record<string, string> = {
    '+direct': '0',
    '+system': 'S',
    external: 'E',
    addRule: 'A',
    option: 'O',
    requestInfo: 'R',
  };
  for (const [action, key] of Object.entries(keys)) {
    const element = actionTarget(action);
    if (element) showHelp(element, key);
  }
  customProfileItems().forEach((element, i) => {
    if (i <= 8) showHelp(element, String(i + 1));
  });
}

/**
 * Install the document-level keydown handler. Call after the profile list has
 * rendered, so the focus fallback below can find the current profile.
 */
export function installShortcuts(): void {
  document.addEventListener('keydown', (event) => {
    // The original matched bare keyCodes, so chords fired too: Cmd+A (select
    // all) triggered "add condition", Ctrl+S switched to the system profile.
    // Fixed in the port by ignoring modified keys.
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    // keyCode matching ignored Shift on letters; keep Shift+J/K/S etc.
    // working by falling back to the lowercased key.
    const handler = shortcutKeys[event.key] ?? shortcutKeys[event.key.toLowerCase()];
    if (handler === undefined) return;

    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;

    if (typeof handler === 'string') {
      if (handler === 'help') {
        showShortcutHelp();
      } else {
        actionTarget(handler)?.click();
      }
    } else if (typeof handler === 'number') {
      customProfileItems()[handler - 1]?.click();
    } else {
      // Navigate over every visible menu item — profiles and actions alike —
      // as `.popup-menu-nav > li:not(.ng-hide) > a` did. Start from the
      // focused item, falling back to the active (current) profile.
      const items = all<HTMLElement>('.om-item:not([hidden])');
      const from = target?.closest<HTMLElement>('.om-item') ?? null;
      let index = from ? items.indexOf(from) : -1;
      if (index === -1) {
        const current = document.querySelector<HTMLElement>('.om-item[aria-current="true"]');
        index = current ? items.indexOf(current) : -1;
      }
      handler(index, items);
    }

    // The original jQuery handler returned false for every mapped key.
    event.preventDefault();
  });
}
