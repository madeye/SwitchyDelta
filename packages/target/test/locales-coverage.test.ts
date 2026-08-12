/**
 * Catalogue coverage + placeholder safety for delta-locales.
 * Drives the shipped PO parser from scripts/build-locales.mjs.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractPlaceholders,
  parsePo,
} from '../../../scripts/build-locales.mjs';

const localesRoot = resolve(__dirname, '../../../delta-locales');

function listLocaleDirs(): string[] {
  return readdirSync(localesRoot)
    .filter((d) => d !== 'en_US' && statSync(join(localesRoot, d)).isDirectory())
    .sort();
}

function loadLocale(dir: string): Record<string, string> {
  return parsePo(
    readFileSync(join(localesRoot, dir, 'LC_MESSAGES', 'delta-web.po'), 'utf8'),
  );
}

describe('delta-locales catalogue coverage', () => {
  const en = loadLocale('en_US');
  const enKeys = Object.keys(en).filter((k) => k !== '');

  it('english source has the expected catalogue size', () => {
    expect(enKeys.length).toBeGreaterThan(300);
    expect(en.popup_proxyAuthPermission).toBeTruthy();
    expect(en.popup_proxyAuthPermissionGrant).toBeTruthy();
  });

  it('every non-en_US locale has a non-empty msgstr for every en_US msgid', () => {
    const failures: string[] = [];
    for (const loc of listLocaleDirs()) {
      const msgs = loadLocale(loc);
      for (const key of enKeys) {
        if (!(key in msgs)) {
          failures.push(`${loc}: missing ${key}`);
          continue;
        }
        const tr = msgs[key];
        const enStr = en[key];
        // Bare empty is always a gap.
        if (tr === '') {
          failures.push(`${loc}: empty ${key}`);
          continue;
        }
        // Single-space (or other whitespace-only) is the intentional-empty
        // convention used only when English is also space-only
        // (e.g. condition_group_default). It must not fake coverage for real
        // English strings — the compiler turns " " into "" at ship time.
        if (enStr.trim() !== '' && tr.trim() === '') {
          failures.push(`${loc}: whitespace-only ${key}`);
        }
      }
    }
    expect(failures, failures.slice(0, 20).join('\n')).toEqual([]);
  });

  it('filled msgstr placeholders match the english source set', () => {
    const rejects: string[] = [];
    for (const loc of listLocaleDirs()) {
      const msgs = loadLocale(loc);
      for (const key of enKeys) {
        const tr = msgs[key];
        if (!tr) continue;
        const enPh = extractPlaceholders(en[key]).join('|');
        const trPh = extractPlaceholders(tr).join('|');
        if (enPh !== trPh) {
          rejects.push(`${loc}/${key}: en=[${enPh}] tr=[${trPh}]`);
        }
      }
    }
    expect(rejects, rejects.slice(0, 20).join('\n')).toEqual([]);
  });

  it('parsePo is the same parser the locale compiler uses (auth keys round-trip)', () => {
    // Structural check: the auth keys exist in en and survive parsePo.
    const builtLike = parsePo(
      readFileSync(join(localesRoot, 'en_US', 'LC_MESSAGES', 'delta-web.po'), 'utf8'),
    );
    expect(builtLike.popup_proxyAuthPermission).toContain('authenticated proxies');
    expect(builtLike.popup_proxyAuthPermissionGrant).toBe('Grant access');
  });
});
