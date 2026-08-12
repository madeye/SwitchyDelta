/**
 * /pac: profile, condition and PAC-script logic.
 *
 * This entry point is dependency-free and safe to load in a service worker.
 * Public-suffix helpers live in the separate `./psl` entry point because they
 * carry a large data table that most callers never need.
 */

export * as Conditions from './conditions.js';
export * as PacGenerator from './pac-generator.js';
export * as Profiles from './profiles.js';
export * as RuleList from './rule-list.js';
export * as ShexpUtils from './shexp.js';

export { DomainTrie } from './domain-trie.js';
export { AttachedCache, Revision, isIp, hostnameOf, unbracket } from './utils.js';
export { parseIp, formatIp, isInSubnet, netmask, subnetSuffix } from './ip.js';
export type { IpAddress } from './ip.js';

export type * from './types.js';
