import { describe, expect, it } from 'vitest';
import type { FixedProfile, OptionsBag, Profile } from '@switchydelta/pac';
import {
  colorFor,
  isProxyScheme,
  sanitizeFallbackProxySchemes,
  sanitizeHexColor,
} from '../src/lib/profile-view.js';

function fixed(overrides: Partial<FixedProfile> = {}): FixedProfile {
  return {
    name: 'Proxy',
    profileType: 'FixedProfile',
    color: '#99ccee',
    fallbackProxy: { scheme: 'http', host: 'example.com', port: 80 },
    ...overrides,
  };
}

describe('sanitizeHexColor', () => {
  it('accepts #rgb and expands it', () => {
    expect(sanitizeHexColor('#AbC')).toBe('#aabbcc');
  });

  it('accepts #rrggbb', () => {
    expect(sanitizeHexColor('#99CCEE')).toBe('#99ccee');
  });

  it('rejects CSS that is not a hex colour', () => {
    expect(sanitizeHexColor('url("https://evil.example/x")')).toBeUndefined();
    expect(sanitizeHexColor('red')).toBeUndefined();
    expect(sanitizeHexColor('#gg0000')).toBeUndefined();
    expect(sanitizeHexColor('#1234')).toBeUndefined();
  });
});

describe('colorFor', () => {
  it('returns a stored hex colour', () => {
    expect(colorFor(fixed({ color: '#ff9966' }), {})).toBe('#ff9966');
  });

  it('falls back when the stored colour is not hex', () => {
    expect(colorFor(fixed({ color: 'url("https://evil.example/x")' }), {})).toBe('#cccccc');
  });

  it('does not inherit a non-hex colour from a virtual target', () => {
    const bag: OptionsBag = {
      '+real': fixed({ name: 'real', color: 'url(https://evil.example/x)' }),
    };
    const virtual: Profile = {
      name: 'v',
      profileType: 'VirtualProfile',
      defaultProfileName: 'real',
      rules: [],
    };
    expect(colorFor(virtual, bag)).toBe('#cccccc');
  });
});

describe('sanitizeFallbackProxySchemes', () => {
  it('clamps a bogus fallbackProxy.scheme to http', () => {
    const bag: OptionsBag = {
      '+Proxy': fixed({
        fallbackProxy: { scheme: 'http"><img src=x>', host: 'h', port: 80 },
      }),
    };
    sanitizeFallbackProxySchemes(bag);
    expect((bag['+Proxy'] as FixedProfile).fallbackProxy!.scheme).toBe('http');
  });

  it('leaves accepted schemes alone', () => {
    for (const scheme of ['http', 'https', 'socks4', 'socks5']) {
      const bag: OptionsBag = {
        '+Proxy': fixed({ fallbackProxy: { scheme, host: 'h', port: 80 } }),
      };
      sanitizeFallbackProxySchemes(bag);
      expect((bag['+Proxy'] as FixedProfile).fallbackProxy!.scheme).toBe(scheme);
    }
  });

  it('does not invent a fallbackProxy on profiles that have none', () => {
    const bag: OptionsBag = { '+Proxy': fixed({ fallbackProxy: undefined }) };
    delete (bag['+Proxy'] as FixedProfile).fallbackProxy;
    sanitizeFallbackProxySchemes(bag);
    expect((bag['+Proxy'] as FixedProfile).fallbackProxy).toBeUndefined();
  });
});

describe('isProxyScheme', () => {
  it('accepts only the four editor schemes', () => {
    expect(isProxyScheme('socks5')).toBe(true);
    expect(isProxyScheme('HTTP')).toBe(false);
    expect(isProxyScheme('direct')).toBe(false);
  });
});
