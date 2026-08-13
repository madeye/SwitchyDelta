import { describe, expect, it } from 'vitest';
import { formatIp, isInSubnet, netmask, parseIp, subnetSuffix } from '../src/ip.js';
import { isIp } from '../src/utils.js';

describe('parseIp', () => {
  it('parses IPv4 with and without a prefix', () => {
    const plain = parseIp('192.0.2.1');
    expect(plain).toMatchObject({ v4: true, hasPrefix: false, prefixLength: 32 });
    expect([...plain!.bytes]).toEqual([192, 0, 2, 1]);

    const cidr = parseIp('192.0.2.0/24');
    expect(cidr).toMatchObject({ v4: true, hasPrefix: true, prefixLength: 24 });
    expect([...cidr!.bytes]).toEqual([192, 0, 2, 0]);
  });

  it('parses IPv6, brackets, zone ids, and embedded v4', () => {
    const loopback = parseIp('::1');
    expect(loopback).toMatchObject({ v4: false, hasPrefix: false, prefixLength: 128 });
    expect(loopback!.bytes[15]).toBe(1);
    expect(loopback!.bytes.slice(0, 15).every((b) => b === 0)).toBe(true);

    const bracketed = parseIp('[2001:db8::1]/64');
    expect(bracketed).toMatchObject({ v4: false, hasPrefix: true, prefixLength: 64 });
    expect(formatIp(bracketed!)).toBe('2001:db8::1');

    const zoned = parseIp('fe80::1%eth0');
    expect(zoned).not.toBeNull();
    expect(formatIp(zoned!)).toBe('fe80::1');

    const mapped = parseIp('::ffff:192.0.2.1');
    expect(mapped).not.toBeNull();
    expect(formatIp(mapped!)).toBe('::ffff:c000:201');
  });

  it('rejects hostnames, ports, and illegal prefixes', () => {
    expect(parseIp('')).toBeNull();
    expect(parseIp('example.com')).toBeNull();
    expect(parseIp('256.0.0.1')).toBeNull();
    expect(parseIp('1.2.3')).toBeNull();
    expect(parseIp('[::1]:8080')).toBeNull();
    expect(parseIp('192.0.2.0/33')).toBeNull();
    expect(parseIp('::1/129')).toBeNull();
    expect(parseIp('192.0.2.0/')).toBeNull();
    expect(parseIp('::1:2:3:4:5:6:7:8:9')).toBeNull();
    // A single leading colon is not a valid IPv6 literal (isIp still says yes).
    expect(parseIp(':1')).toBeNull();
  });
});

describe('formatIp / netmask / isInSubnet', () => {
  it('canonicalises IPv6 per RFC 5952', () => {
    expect(formatIp(parseIp('2001:0db8:0000:0000:0000:0000:0000:0001')!)).toBe('2001:db8::1');
    // Leftmost of two equal-length zero runs wins.
    expect(formatIp(parseIp('2001:0:0:1:0:0:0:1')!)).toBe('2001:0:0:1::1');
    expect(formatIp(parseIp('::')!)).toBe('::');
    expect(formatIp(parseIp('0:0:0:0:0:0:0:0')!)).toBe('::');
  });

  it('builds a family-matching netmask', () => {
    const v4 = netmask(parseIp('192.0.2.0/24')!);
    expect(v4.v4).toBe(true);
    expect(formatIp(v4)).toBe('255.255.255.0');
    expect(v4.hasPrefix).toBe(false);
    expect(subnetSuffix(parseIp('192.0.2.0/24')!)).toBe('/24');

    const v6 = netmask(parseIp('2001:db8::/32')!);
    expect(v6.v4).toBe(false);
    expect(formatIp(v6)).toBe('ffff:ffff::');
  });

  it('tests subnet membership, including IPv6 and mixed families', () => {
    const net = parseIp('192.0.2.0/24')!;
    expect(isInSubnet(parseIp('192.0.2.1')!, net)).toBe(true);
    expect(isInSubnet(parseIp('192.0.2.255')!, net)).toBe(true);
    expect(isInSubnet(parseIp('192.0.3.1')!, net)).toBe(false);

    const v6net = parseIp('2001:db8::/32')!;
    expect(isInSubnet(parseIp('2001:db8::1')!, v6net)).toBe(true);
    expect(isInSubnet(parseIp('2001:db9::1')!, v6net)).toBe(false);
    expect(isInSubnet(parseIp('192.0.2.1')!, v6net)).toBe(false);
    expect(isInSubnet(parseIp('::1')!, parseIp('127.0.0.1')!)).toBe(false);
  });
});

describe('isIp leading-colon', () => {
  // Cheap classifier in utils.ts: any colon means "this is an IP", including
  // the `::1` / `:1` forms that used to be treated as hostnames.
  it('treats IPv6 literals that begin with a colon as IPs', () => {
    expect(isIp('::')).toBe(true);
    expect(isIp('::1')).toBe(true);
    expect(isIp(':1')).toBe(true);
    expect(isIp('example.com')).toBe(false);
  });
});
