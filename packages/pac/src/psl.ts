/**
 * Public-suffix helpers.
 *
 * Kept in a separate entry point because the public suffix list is a large
 * data table. Only the "suggest a wildcard for this site" UI path needs it, so
 * the service worker never has to load it.
 */

import { getDomain } from 'tldts';
import { isIp } from './utils.js';

/**
 * The registrable domain of a host, e.g. `images.google.co.uk` ->
 * `google.co.uk`. IP literals and hosts with no known suffix are returned
 * unchanged.
 */
export function getBaseDomain(domain: string): string {
  if (isIp(domain)) return domain;
  return getDomain(domain) ?? domain;
}

/** A host wildcard pattern covering the whole registrable domain. */
export function wildcardForDomain(domain: string): string {
  if (isIp(domain)) return domain;
  return '*.' + getBaseDomain(domain);
}

/** As {@link wildcardForDomain}, taking a full URL. */
export function wildcardForUrl(url: string): string {
  const hostname = new URL(url).hostname;
  return wildcardForDomain(hostname);
}
