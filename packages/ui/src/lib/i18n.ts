/**
 * Message lookup.
 *
 * Translations stay in the existing gettext catalogues under `omega-locales`,
 * compiled to `_locales/<lang>/messages.json` at build time, so `chrome.i18n`
 * remains the source of truth and no translation work is lost.
 */

/** Look up a message, falling back to the key so missing strings are visible. */
export function t(key: string, substitutions?: string | string[]): string {
  const message = chrome.i18n.getMessage(key, substitutions);
  return message || key;
}

/**
 * The display name of a profile.
 *
 * Only the built-in profiles are translated (`profile_direct`,
 * `profile_system`); user-created profiles show their literal name.
 */
export function profileDisplayName(name: string): string {
  return chrome.i18n.getMessage('profile_' + name) || name;
}

/**
 * Replace `data-i18n` placeholders in static markup.
 *
 * `data-i18n="key"` sets text content; `data-i18n-attr="title:key"` sets an
 * attribute. Running this once on load keeps the HTML free of English strings
 * without a template runtime.
 */
export function localizeDocument(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = el.dataset['i18n'];
    if (key) el.textContent = t(key);
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-attr]')) {
    for (const pair of (el.dataset['i18nAttr'] ?? '').split(',')) {
      const [attr, key] = pair.split(':');
      if (attr && key) el.setAttribute(attr.trim(), t(key.trim()));
    }
  }
}
