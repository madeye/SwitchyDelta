/**
 * Compile the gettext catalogues in delta-locales/ to Chrome's
 * _locales/<locale>/messages.json format.
 *
 * A port of the legacy grunt-po2crx task, so the output is byte-compatible
 * with what the old pipeline generated: the same `$(\d+:)?(\w+)\$` placeholder
 * rewriting, the same `_unused_<i>` fillers for gaps in explicit ordering, and
 * the single-space-means-empty convention.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Locale directories that need renaming for Chrome, which only accepts its
 * own fixed set of locale codes. Directories mapping to null are skipped
 * because Chrome has no matching code and errors out on unknown ones.
 */
const LOCALE_NAMES = {
  en_US: 'en',
  he_IL: 'iw', // Chrome uses the legacy Java code for Hebrew
  nb_NO: 'nb',
  pt: 'pt_PT',
  ach: null, // Acholi
  lzh: null, // Literary Chinese
  is: null, // Icelandic
  si: null, // Sinhala
  es_AR: null, // es exists separately; es_AR is not a Chrome locale
  zh_Hant: null, // zh_TW exists separately
};

/** Parse a PO file into {msgid: msgstr}, ignoring the header entry. */
export function parsePo(source) {
  const messages = {};
  let msgid = null;
  let current = null; // the string being accumulated, 'id' | 'str'
  let id = '';
  let str = '';

  const unquote = (line) =>
    line
      .slice(line.indexOf('"') + 1, line.lastIndexOf('"'))
      .replace(/\\([\\"ntr])/g, (_, c) => ({ '\\': '\\', '"': '"', n: '\n', t: '\t', r: '\r' })[c]);

  const flush = () => {
    if (msgid !== null && msgid !== '') messages[msgid] = str;
    msgid = null;
    id = '';
    str = '';
  };

  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('msgid ')) {
      flush();
      current = 'id';
      id = unquote(line);
      msgid = id;
    } else if (line.startsWith('msgstr')) {
      current = 'str';
      str = unquote(line);
    } else if (line.startsWith('"')) {
      if (current === 'id') {
        id += unquote(line);
        msgid = id;
      } else if (current === 'str') {
        str += unquote(line);
      }
    } else if (line === '' || line.startsWith('#')) {
      // comment or separator; entry is flushed when the next msgid starts
    }
  }
  flush();
  return messages;
}

/**
 * Placeholder tokens the runtime substitutes: $Name$, $1:Name$, %s/%d, {n}.
 * Exported so catalogue tests assert the same set the compiler/runtime care about.
 */
export function extractPlaceholders(message) {
  const set = new Set();
  for (const m of message.matchAll(/\$([^$]+)\$/g)) set.add('$' + m[1] + '$');
  for (const m of message.matchAll(/%[sd]/g)) set.add(m[0]);
  for (const m of message.matchAll(/\{n\}/g)) set.add(m[0]);
  return [...set].sort();
}

/** The grunt-po2crx message transform: extract $REF$ placeholders. */
export function toChromeMessage(message) {
  const refs = [];
  let matchCount = 0;
  const rewritten = message.replace(/\$(\d+:)?(\w+)\$/g, (_, order, ref) => {
    matchCount++;
    refs[order ? parseInt(order) : matchCount] = ref;
    return '$' + ref + '$';
  });

  let placeholders;
  if (matchCount) {
    placeholders = {};
    for (let i = 0; i < refs.length; i++) {
      placeholders[refs[i] ?? '_unused_' + i] = { content: '$' + i };
    }
  }
  return { message: rewritten === ' ' ? '' : rewritten, placeholders };
}

/**
 * The Web Store refuses uploads when a shipped locale has no translation for
 * the item's name (and validates the description the same way), even though
 * the browser itself would fall back to the default locale. These keys are
 * backfilled from the default catalogue when a translation is missing.
 */
const STORE_REQUIRED_KEYS = ['manifest_app_name', 'manifest_app_description'];

/** Compile every catalogue into `<outDir>/<locale>/messages.json`. */
export async function buildLocales(localesDir, outDir, defaultLocaleDir = 'en_US') {
  const parse = async (dir) => {
    const po = await readFile(join(localesDir, dir, 'LC_MESSAGES', 'delta-web.po'), 'utf8');
    const result = {};
    for (const [key, value] of Object.entries(parsePo(po))) {
      // Untranslated entries are omitted so Chrome falls back to the
      // default locale instead of showing an empty string.
      if (!value) continue;
      result[key] = toChromeMessage(value);
    }
    return result;
  };
  const fallback = await parse(defaultLocaleDir);

  const built = [];
  for (const dir of (await readdir(localesDir, { withFileTypes: true })).filter((d) =>
    d.isDirectory(),
  )) {
    const locale = LOCALE_NAMES[dir.name] === undefined ? dir.name : LOCALE_NAMES[dir.name];
    if (locale === null) continue;

    const result = await parse(dir.name);
    // A catalogue with no translations at all (e.g. he_IL) only adds an
    // entry the store would validate; ship nothing and let Chrome fall back.
    if (Object.keys(result).length === 0) continue;

    for (const key of STORE_REQUIRED_KEYS) {
      if (!result[key] && fallback[key]) result[key] = fallback[key];
    }

    const dest = join(outDir, locale);
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, 'messages.json'), JSON.stringify(result));
    built.push(locale);
  }
  return built.sort();
}
