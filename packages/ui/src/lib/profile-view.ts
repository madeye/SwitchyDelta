/**
 * Presentation rules for profiles.
 *
 * The CoffeeScript UI defined all of this twice — once in the AngularJS
 * `omegaDecoration` module for the options page and again as plain objects in
 * the popup's `profiles.js`. The two copies had already drifted. This is the
 * single definition.
 */

import { Profiles, type OptionsBag, type Profile } from '@switchydelta/pac';

/** Palette offered by the profile colour picker. */
export const profileColors: readonly string[] = [
  '#99ccee',
  '#ffcc00',
  '#cc99cc',
  '#77dd77',
  '#ff9966',
  '#dd7788',
  '#99cc99',
  '#cccccc',
  '#66bbdd',
];

/** Icon name per profile type. */
export const profileIcons: Readonly<Record<string, string>> = {
  DirectProfile: 'transfer',
  SystemProfile: 'off',
  FixedProfile: 'globe',
  PacProfile: 'file',
  VirtualProfile: 'question-sign',
  SwitchProfile: 'retweet',
  RuleListProfile: 'list',
  SwitchyRuleListProfile: 'list',
  AutoProxyRuleListProfile: 'list',
};

/** Sort weight per profile type; lower sorts first. */
const typeOrder: Readonly<Record<string, number>> = {
  FixedProfile: 1,
  PacProfile: 2,
  VirtualProfile: 3,
  SwitchProfile: 4,
  RuleListProfile: 5,
  SwitchyRuleListProfile: 5,
  AutoProxyRuleListProfile: 5,
};

/** A rule list profile implicitly attached to a switch profile. */
export function getAttachedName(name: string): string {
  return '__ruleListOf_' + name;
}

export function getParentName(name: string): string | undefined {
  return name.startsWith('__ruleListOf_') ? name.substring('__ruleListOf_'.length) : undefined;
}

/** Hidden profiles are not offered in pickers. */
export function isProfileNameHidden(name: string): boolean {
  return name.startsWith('_');
}

/** Reserved profiles are internal machinery, never user-visible. */
export function isProfileNameReserved(name: string): boolean {
  return name.startsWith('__');
}

/**
 * Follow a virtual profile to the profile it currently resolves to.
 *
 * Virtual profiles are indirection: they display the icon and colour of their
 * target so the UI shows where traffic actually goes.
 */
export function getVirtualTarget(profile: Profile, options: OptionsBag): Profile {
  let current = profile;
  const seen = new Set<string>();
  while (current.profileType === 'VirtualProfile') {
    if (seen.has(current.name)) break; // defensive: options can contain cycles
    seen.add(current.name);
    const next = Profiles.byName(
      (current as Profile & { defaultProfileName: string }).defaultProfileName,
      options,
    );
    if (!next) break;
    current = next;
  }
  return current;
}

export function iconFor(profile: Profile, options: OptionsBag): string {
  const target = getVirtualTarget(profile, options);
  return profileIcons[target.profileType] ?? 'question-sign';
}

export function colorFor(profile: Profile, options: OptionsBag): string {
  const target = getVirtualTarget(profile, options);
  return target.color ?? profile.color ?? '#cccccc';
}

/** Order profiles by type then name, the way both old UIs did. */
export function compareProfiles(a: Profile, b: Profile): number {
  const orderA = typeOrder[a.profileType] ?? 99;
  const orderB = typeOrder[b.profileType] ?? 99;
  if (orderA !== orderB) return orderA - orderB;
  return a.name.localeCompare(b.name);
}

/**
 * The profiles a picker should offer.
 *
 * `resultFor` narrows the list to profiles that the named profile may target
 * without creating a reference cycle.
 */
export function listProfiles(
  options: OptionsBag,
  { includeBuiltin = false, resultFor }: { includeBuiltin?: boolean; resultFor?: string } = {},
): Profile[] {
  if (resultFor) {
    return Profiles.validResultProfilesFor(resultFor, options)
      .filter((p) => !isProfileNameHidden(p.name))
      .sort(compareProfiles);
  }

  const result: Profile[] = [];
  Profiles.each(options, (_key, profile) => {
    if (isProfileNameReserved(profile.name)) return;
    if (!includeBuiltin && profile.builtin) return;
    if (!includeBuiltin && isProfileNameHidden(profile.name)) return;
    result.push(profile);
  });
  return result.sort(compareProfiles);
}
