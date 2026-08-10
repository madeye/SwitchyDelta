/**
 * Compact IPv4/IPv6 address handling.
 *
 * Replaces the `ip-address` package (204 KB with its jsbn/sprintf-js
 * dependencies) which was used only for parsing, normalising and subnet
 * comparison. Addresses are held as raw bytes, so subnet maths is a byte
 * compare rather than BigInteger arithmetic.
 */

export interface IpAddress {
  /** True for IPv4, false for IPv6. */
  readonly v4: boolean;
  /** 4 bytes for IPv4, 16 for IPv6. */
  readonly bytes: Uint8Array;
  /** Prefix length in bits; defaults to the full width when absent. */
  readonly prefixLength: number;
  /** True when the source text carried an explicit `/prefix`. */
  readonly hasPrefix: boolean;
}

const V4_BITS = 32;
const V6_BITS = 128;

function parseIpv4Bytes(text: string): Uint8Array | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i]!;
    // Digits only, and short enough that Number() cannot lose precision.
    if (part.length === 0 || part.length > 3) return null;
    for (let j = 0; j < part.length; j++) {
      const c = part.charCodeAt(j);
      if (c < 0x30 || c > 0x39) return null;
    }
    const value = Number(part);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

function parseIpv6Bytes(text: string): Uint8Array | null {
  // Drop any zone identifier (fe80::1%eth0); it plays no part in matching.
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.substring(0, zone);
  if (text.length === 0) return null;

  const doubleColon = text.indexOf('::');
  if (doubleColon !== text.lastIndexOf('::')) return null; // at most one "::"

  let headText: string;
  let tailText: string;
  if (doubleColon >= 0) {
    headText = text.substring(0, doubleColon);
    tailText = text.substring(doubleColon + 2);
  } else {
    headText = text;
    tailText = '';
  }

  const head = headText.length > 0 ? headText.split(':') : [];
  const tail = tailText.length > 0 ? tailText.split(':') : [];

  // A trailing group may be a dotted-quad (::ffff:192.0.2.1).
  let embedded: Uint8Array | null = null;
  const groups = tail.length > 0 ? tail : head;
  const last = groups[groups.length - 1];
  if (last !== undefined && last.indexOf('.') >= 0) {
    embedded = parseIpv4Bytes(last);
    if (embedded === null) return null;
    groups.pop();
  }

  const embeddedGroups = embedded ? 2 : 0;
  const total = head.length + tail.length + embeddedGroups;
  if (doubleColon >= 0 ? total > 8 : total !== 8) return null;

  const bytes = new Uint8Array(16);
  let offset = 0;

  const writeGroup = (group: string): boolean => {
    if (group.length === 0 || group.length > 4) return false;
    let value = 0;
    for (let i = 0; i < group.length; i++) {
      const digit = parseHexDigit(group.charCodeAt(i));
      if (digit < 0) return false;
      value = value * 16 + digit;
    }
    bytes[offset++] = value >> 8;
    bytes[offset++] = value & 0xff;
    return true;
  };

  for (const group of head) {
    if (!writeGroup(group)) return null;
  }
  // The "::" run expands to however many zero groups are missing; the bytes are
  // already zero, so we only advance the write cursor.
  offset = 16 - (tail.length + embeddedGroups) * 2;
  for (const group of tail) {
    if (!writeGroup(group)) return null;
  }
  if (embedded) {
    bytes.set(embedded, offset);
  }
  return bytes;
}

function parseHexDigit(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  return -1;
}

/**
 * Parse an address, optionally bracketed (`[::1]`) and optionally carrying a
 * `/prefix` suffix. Returns null when the text is not an IP address at all,
 * which is how callers distinguish hostnames from literals.
 */
export function parseIp(text: string): IpAddress | null {
  if (text.length === 0) return null;
  let body = text.trim();

  let prefixLength = -1;
  const slash = body.lastIndexOf('/');
  if (slash >= 0) {
    const suffix = body.substring(slash + 1);
    if (suffix.length === 0 || !/^\d+$/.test(suffix)) return null;
    prefixLength = Number(suffix);
    body = body.substring(0, slash);
  }

  // Brackets are only stripped when they enclose the whole address. Anything
  // trailing them (`[::1]:8080`) means this is not a bare address, and the
  // caller is expected to split the port off first.
  if (body.charCodeAt(0) === 0x5b /* [ */) {
    if (body.charCodeAt(body.length - 1) !== 0x5d /* ] */) return null;
    body = body.substring(1, body.length - 1);
  }

  const v4 = parseIpv4Bytes(body);
  if (v4 !== null) {
    if (prefixLength > V4_BITS) return null;
    return {
      v4: true,
      bytes: v4,
      prefixLength: prefixLength < 0 ? V4_BITS : prefixLength,
      hasPrefix: prefixLength >= 0,
    };
  }

  const v6 = parseIpv6Bytes(body);
  if (v6 !== null) {
    if (prefixLength > V6_BITS) return null;
    return {
      v4: false,
      bytes: v6,
      prefixLength: prefixLength < 0 ? V6_BITS : prefixLength,
      hasPrefix: prefixLength >= 0,
    };
  }

  return null;
}

function formatIpv4(bytes: Uint8Array): string {
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
}

/**
 * RFC 5952 canonical text: lowercase, no leading zeros, and the longest run of
 * two or more zero groups replaced by "::" (leftmost wins on a tie).
 */
function formatIpv6(bytes: Uint8Array): string {
  const groups = new Array<number>(8);
  for (let i = 0; i < 8; i++) {
    groups[i] = (bytes[i * 2]! << 8) | bytes[i * 2 + 1]!;
  }

  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  let runLength = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === 0) {
      if (runStart < 0) runStart = i;
      runLength++;
      if (runLength > bestLength) {
        bestStart = runStart;
        bestLength = runLength;
      }
    } else {
      runStart = -1;
      runLength = 0;
    }
  }
  if (bestLength < 2) {
    bestStart = -1;
    bestLength = 0;
  }

  let out = '';
  for (let i = 0; i < 8; i++) {
    if (bestStart >= 0 && i === bestStart) {
      out += i === 0 ? '::' : ':';
      i += bestLength - 1;
      continue;
    }
    out += groups[i]!.toString(16);
    if (i < 7) out += ':';
  }
  return out;
}

/** Canonical text form, without any prefix suffix. */
export function formatIp(address: IpAddress): string {
  return address.v4 ? formatIpv4(address.bytes) : formatIpv6(address.bytes);
}

/** The `/prefix` suffix, e.g. `"/33"`. */
export function subnetSuffix(address: IpAddress): string {
  return '/' + address.prefixLength;
}

function maskBytes(width: number, prefixLength: number): Uint8Array {
  const bytes = new Uint8Array(width);
  let bits = prefixLength;
  for (let i = 0; i < width && bits > 0; i++) {
    const take = Math.min(8, bits);
    bytes[i] = (0xff << (8 - take)) & 0xff;
    bits -= take;
  }
  return bytes;
}

/** The netmask of `address` as an address of the same family (e.g. 255.255.255.0). */
export function netmask(address: IpAddress): IpAddress {
  const width = address.v4 ? 4 : 16;
  return {
    v4: address.v4,
    bytes: maskBytes(width, address.prefixLength),
    prefixLength: address.v4 ? V4_BITS : V6_BITS,
    hasPrefix: false,
  };
}

/** True when `address` falls inside the subnet described by `subnet`. */
export function isInSubnet(address: IpAddress, subnet: IpAddress): boolean {
  if (address.v4 !== subnet.v4) return false;
  const width = subnet.v4 ? 4 : 16;
  let bits = subnet.prefixLength;
  for (let i = 0; i < width; i++) {
    if (bits <= 0) break;
    const take = Math.min(8, bits);
    const mask = (0xff << (8 - take)) & 0xff;
    if ((address.bytes[i]! & mask) !== (subnet.bytes[i]! & mask)) return false;
    bits -= take;
  }
  return true;
}
