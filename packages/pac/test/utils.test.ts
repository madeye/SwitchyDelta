import { describe, it, expect } from 'vitest';
// getBaseDomain moved from utils.js to the psl.js entry point in the port
// (kept separate because the public-suffix list is a large data table).
import { getBaseDomain } from '../src/psl.js';
import { isIp } from '../src/utils.js';

describe('isIp', () => {
  it('should treat IPv6 literals beginning with a colon as IPs', () => {
    expect(isIp('::')).toBe(true);
    expect(isIp('::1')).toBe(true);
    expect(isIp('::f')).toBe(true);
    expect(isIp(':1')).toBe(true);
  });
  it('should treat IPv6 literals with an interior colon as IPs', () => {
    expect(isIp('fe80::')).toBe(true);
    expect(isIp('fe80::1')).toBe(true);
  });
  it('should treat a trailing digit as IPv4', () => {
    expect(isIp('127.0.0.1')).toBe(true);
  });
  it('should not treat ordinary hostnames as IPs', () => {
    expect(isIp('example.com')).toBe(false);
    expect(isIp('localhost')).toBe(false);
  });
});

describe('getBaseDomain', () => {
  it('should return domains with zero level unchanged', () => {
    expect(getBaseDomain('someinternaldomain')).toBe('someinternaldomain');
  });
  it('should return domains with one level unchanged', () => {
    expect(getBaseDomain('example.com')).toBe('example.com');
    expect(getBaseDomain('e.test')).toBe('e.test');
    expect(getBaseDomain('a.b')).toBe('a.b');
  });
  it('should treat two-segment TLD as one component', () => {
    expect(getBaseDomain('images.google.co.uk')).toBe('google.co.uk');
    expect(getBaseDomain('images.google.co.jp')).toBe('google.co.jp');
    expect(getBaseDomain('example.com.cn')).toBe('example.com.cn');
  });
  it('should not mistake short domains with two-segment TLDs', () => {
    expect(getBaseDomain('a.bc.com')).toBe('bc.com');
    expect(getBaseDomain('i.t.co')).toBe('t.co');
  });
  it('should not try to modify IP address literals', () => {
    expect(getBaseDomain('127.0.0.1')).toBe('127.0.0.1');
    expect(getBaseDomain('[::1]')).toBe('[::1]');
    expect(getBaseDomain('::f')).toBe('::f');
  });
});
