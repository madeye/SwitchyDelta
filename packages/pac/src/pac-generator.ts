/**
 * PAC script generation.
 *
 * The generated script resolves a profile chain iteratively: each profile is
 * either a literal PAC result string or a function returning the next profile
 * key (prefixed with `+`), so following references costs no recursion.
 *
 * Output is emitted already-compact, which is why no minifier is involved.
 */

import * as g from './codegen.js';
import * as Profiles from './profiles.js';
import type { OptionsBag, Profile, ProfileNotFoundAction } from './types.js';

export interface ScriptArgs {
  profileNotFound?: ProfileNotFoundAction;
}

/**
 * Escape every non-ASCII character so the script survives transports that do
 * not declare an encoding.
 *
 * String literals are already escaped at emit time; this remains exported for
 * callers that splice in externally-sourced PAC text.
 */
export function ascii(str: string): string {
  return str.replace(/[\u0080-\uffff]/g, (char) => {
    return '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0');
  });
}

/** Generate a complete PAC script defining `FindProxyForURL`. */
export function script(
  options: OptionsBag,
  profile: string | Profile,
  args?: ScriptArgs,
): string {
  const resolved = typeof profile === 'string' ? Profiles.byName(profile, options) : profile;
  if (!resolved) {
    throw new Error(`Profile ${String(profile)} does not exist!`);
  }

  const refs = Profiles.allReferenceSet(resolved, options, {
    profileNotFound: args?.profileNotFound,
  });

  const properties: string[] = [];
  for (const [key, name] of Object.entries(refs)) {
    if (key === '+direct') continue;
    let target: Profile | null | undefined =
      resolved.name === name ? resolved : Profiles.byName(name, options);
    if (!target) {
      target = Profiles.profileNotFound(name, args?.profileNotFound);
      if (!target) continue;
    }
    properties.push(`${g.str(key)}:${Profiles.compile(target).code}`);
  }

  const profilesObject = g.raw(`{${properties.join(',')}}`);

  // var result = init, scheme = url.substr(0, url.indexOf(":"));
  const schemeInit = g.call(g.member(g.ref('url'), 'substr'), [
    g.num(0),
    g.call(g.member(g.ref('url'), 'indexOf'), [g.string(':')]),
  ]);

  // result = profiles[result];
  // if (typeof result === "function") result = result(url, host, scheme);
  const step =
    g.exprStmt(
      g.raw(`result=${g.index(g.ref('profiles'), g.ref('result')).code}`, g.Prec.Lowest),
    ) +
    g.ifThen(
      g.binary('===', g.unary('typeof', g.ref('result')), g.string('function')),
      g.exprStmt(
        g.raw(
          `result=${g.call(g.ref('result'), [g.ref('url'), g.ref('host'), g.ref('scheme')]).code}`,
          g.Prec.Lowest,
        ),
      ),
    );

  // Keep resolving while the value is not yet a PAC result string, i.e. while
  // it is a function or a "+profile" reference.
  const loopTest = g.or([
    g.binary('!==', g.unary('typeof', g.ref('result')), g.string('string')),
    g.binary(
      '===',
      g.call(g.member(g.ref('result'), 'charCodeAt'), [g.num(0)]),
      g.num('+'.charCodeAt(0)),
    ),
  ]);

  const findProxyForUrl = g.func(
    ['url', 'host'],
    '"use strict";' +
      `var result=init,scheme=${schemeInit.code};` +
      g.doWhile(step, loopTest) +
      g.ret(g.ref('result')),
  );

  const factory = g.func(['init', 'profiles'], g.ret(findProxyForUrl));

  const call = g.call(factory, [Profiles.profileResult(resolved.name), profilesObject]);

  return `var FindProxyForURL=${call.code};`;
}
