/**
 * Options controller: applyProfile, addTempRule, matchProfile cycle,
 * loadOptions wipe-vs-transport, setExternalProfile, updateProfile revision,
 * transformValueForSync auth stripping, and malformed-payload guards.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Conditions, Profiles, Revision } from '@switchydelta/pac';
import type { FixedProfile, PacProfile, Profile, SwitchProfile } from '@switchydelta/pac';
import { Options } from '../src/options.js';
import type { DeltaOptions, ProxyImpl } from '../src/options.js';
import { ProfileNotExistError, SchemaTooNewError } from '../src/errors.js';
import { Log } from '../src/log.js';
import { Storage } from '../src/storage.js';

beforeAll(() => {
  vi.spyOn(Log, 'log').mockImplementation(() => undefined);
  vi.spyOn(Log, 'error').mockImplementation(() => undefined);
});

afterAll(() => {
  vi.restoreAllMocks();
});

const proxyImpl: ProxyImpl = {
  applyProfile: async () => undefined,
};

function bag(extra: DeltaOptions = {}): DeltaOptions {
  return {
    schemaVersion: 2,
    '+proxy': {
      name: 'proxy',
      profileType: 'FixedProfile',
      color: '#99ccee',
      fallbackProxy: { scheme: 'http', host: 'proxy.example.com', port: 8080 },
    } satisfies FixedProfile,
    ...extra,
  };
}

class HarnessOptions extends Options {
  fetchResult: Promise<string> = Promise.resolve('');

  dropProfile(name: string): void {
    delete this._options[Profiles.nameAsKey(name)];
  }

  replaceProfile(name: string, profile: Profile): void {
    this._options[Profiles.nameAsKey(name)] = profile;
  }

  currentName(): string | null {
    return this._currentProfileName;
  }

  tempProfile(): SwitchProfile | null {
    return this._tempProfile;
  }

  tempActive(): boolean {
    return this._tempProfileActive;
  }

  revertToName(): string | null {
    return this._revertToProfileName;
  }

  override fetchUrl(): Promise<string> {
    return this.fetchResult;
  }
}

function recordingProxy(): { impl: ProxyImpl; applied: Profile[] } {
  const applied: Profile[] = [];
  return {
    applied,
    impl: {
      applyProfile: async (profile) => {
        applied.push(profile);
      },
    },
  };
}

function createLoaded(
  options: DeltaOptions,
  impl: ProxyImpl = proxyImpl,
): Promise<HarnessOptions> {
  const opts = new HarnessOptions(options, new Storage(), new Storage(), Log, null, impl);
  return opts.ready.then(() => opts);
}

describe('Options#loadOptions wipe policy', () => {
  it('does not wipe stored options on a storage transport error', async () => {
    const storage = new Storage();
    const userBag = bag({ '+keep': { name: 'keep', profileType: 'FixedProfile', color: '#000' } });
    await storage.set(userBag);
    vi.spyOn(storage, 'get').mockRejectedValue(new Error('transient I/O'));

    const opts = new Options(null, storage, new Storage(), Log, null, proxyImpl);
    await expect(opts.optionsLoaded).rejects.toThrow('transient I/O');

    vi.mocked(storage.get).mockRestore();
    expect(await storage.get(null)).toEqual(userBag);
  });

  it('backs up and refuses to overwrite a newer schemaVersion', async () => {
    const storage = new Storage();
    const state = new Storage();
    const userBag = bag({ schemaVersion: 3, '+custom': { name: 'custom', profileType: 'FixedProfile' } });
    await storage.set(userBag);

    const opts = new Options(null, storage, state, Log, null, proxyImpl);
    await expect(opts.optionsLoaded).rejects.toBeInstanceOf(SchemaTooNewError);

    expect(await storage.get(null)).toEqual(userBag);
    expect(await state.get('optionsSchemaBackup')).toEqual({ optionsSchemaBackup: userBag });
  });

  it('wipes only on genuinely corrupt options', async () => {
    const storage = new Storage();
    await storage.set({
      schemaVersion: 0,
      '+keep': { name: 'keep', profileType: 'FixedProfile' },
    });

    const opts = new Options(null, storage, new Storage(), Log, null, proxyImpl);
    const loaded = await opts.optionsLoaded;

    expect(loaded['schemaVersion']).toBe(2);
    expect(loaded['+keep']).toBeUndefined();
    expect(loaded['+proxy']).toBeTruthy();
    expect((await storage.get('schemaVersion'))['schemaVersion']).toBe(2);
  });
});

describe('Options#matchProfile', () => {
  it('breaks on a two-profile reference cycle', async () => {
    const opts = await createLoaded(
      bag({
        '+a': {
          name: 'a',
          profileType: 'SwitchProfile',
          color: '#111111',
          defaultProfileName: 'b',
          rules: [],
        } satisfies SwitchProfile,
        '+b': {
          name: 'b',
          profileType: 'SwitchProfile',
          color: '#222222',
          defaultProfileName: 'a',
          rules: [],
        } satisfies SwitchProfile,
      }),
    );
    await opts.applyProfile('a');

    const request = { url: 'http://example.com/', host: 'example.com', scheme: 'http' };
    const matched = await opts.matchProfile(request);
    expect(matched.profile?.name).toBeTruthy();
    expect(matched.results.length).toBeGreaterThan(0);
  });
});

describe('Options#addTempRule', () => {
  it('bails when the current profile is missing', async () => {
    const opts = await createLoaded(bag());
    await opts.applyProfile('proxy');
    opts.dropProfile('proxy');
    await expect(opts.addTempRule('example.com', 'direct')).resolves.toBeUndefined();
  });
});

describe('Options#updateProfile', () => {
  it('aborts when the profile key disappears mid-fetch', async () => {
    const pac = {
      name: 'pac',
      profileType: 'PacProfile',
      pacUrl: 'http://example.com/p.pac',
      pacScript: 'old',
      revision: Revision.fromTime(1),
    } satisfies PacProfile;

    const opts = await createLoaded(bag({ '+pac': pac }));
    let release!: (data: string) => void;
    opts.fetchResult = new Promise((resolve) => {
      release = resolve;
    });

    const updating = opts.updateProfile('pac');
    opts.dropProfile('pac');
    release('function FindProxyForURL(){ return "DIRECT"; }');

    const result = await updating;
    expect(result['+pac']).toEqual(pac);
  });
});

describe('Options.transformValueForSync', () => {
  it('strips auth credentials from Fixed and Switch profiles', () => {
    const fixed: FixedProfile = {
      name: 'proxy',
      profileType: 'FixedProfile',
      fallbackProxy: { scheme: 'http', host: 'proxy.example.com', port: 8080 },
      auth: { all: { username: 'user', password: 's3cret' } },
    };
    const strippedFixed = Options.transformValueForSync(fixed, '+proxy') as Profile;
    expect(strippedFixed).not.toHaveProperty('auth');
    expect((strippedFixed as FixedProfile).fallbackProxy).toEqual(fixed.fallbackProxy);
    expect(fixed.auth).toEqual({ all: { username: 'user', password: 's3cret' } });

    const auto: SwitchProfile & { auth?: unknown } = {
      name: 'auto switch',
      profileType: 'SwitchProfile',
      defaultProfileName: 'direct',
      rules: [],
      auth: { all: { username: 'user', password: 's3cret' } },
    };
    const strippedSwitch = Options.transformValueForSync(auto, '+auto switch') as Record<
      string,
      unknown
    >;
    expect(strippedSwitch).not.toHaveProperty('auth');
    expect(strippedSwitch['defaultProfileName']).toBe('direct');
    expect(auto.auth).toBeTruthy();
  });

  it('still drops downloaded payloads on updateUrl profiles', () => {
    const pac: PacProfile & { lastUpdate?: string } = {
      name: 'pac',
      profileType: 'PacProfile',
      pacUrl: 'http://example.com/p.pac',
      pacScript: 'function FindProxyForURL(){ return "DIRECT"; }',
      lastUpdate: '2020-01-01T00:00:00.000Z',
      auth: { all: { username: 'user', password: 's3cret' } },
    };
    const stripped = Options.transformValueForSync(pac, '+pac') as Record<string, unknown>;
    expect(stripped).not.toHaveProperty('auth');
    expect(stripped).not.toHaveProperty('pacScript');
    expect(stripped).not.toHaveProperty('lastUpdate');
    expect(stripped['pacUrl']).toBe('http://example.com/p.pac');
  });
});

describe('Options#applyProfile', () => {
  it('rejects a missing profile', async () => {
    const opts = await createLoaded(bag());
    await expect(opts.applyProfile('missing')).rejects.toBeInstanceOf(ProfileNotExistError);
  });

  it('pushes the named profile through ProxyImpl', async () => {
    const { impl, applied } = recordingProxy();
    const opts = await createLoaded(bag(), impl);
    applied.length = 0;
    await opts.applyProfile('proxy');
    expect(applied).toHaveLength(1);
    expect(applied[0]?.name).toBe('proxy');
    expect(opts.currentName()).toBe('proxy');
    expect(opts.isSystem()).toBe(false);
  });

  it('skips ProxyImpl when proxy is false but still records the current profile', async () => {
    const { impl, applied } = recordingProxy();
    const opts = await createLoaded(bag(), impl);
    applied.length = 0;
    await opts.applyProfile('proxy', { proxy: false });
    expect(applied).toHaveLength(0);
    expect(opts.currentName()).toBe('proxy');
  });

  it('layers temp rules over an includable profile and drops stale ones', async () => {
    const other: FixedProfile = {
      name: 'other',
      profileType: 'FixedProfile',
      color: '#abcdef',
      fallbackProxy: { scheme: 'http', host: 'other.example', port: 9 },
    };
    const { impl, applied } = recordingProxy();
    const opts = await createLoaded(bag({ '+other': other }), impl);
    await opts.applyProfile('proxy');
    await opts.addTempRule('example.com', 'other');
    expect(opts.tempActive()).toBe(true);
    expect(opts.tempProfile()?.rules).toHaveLength(1);

    opts.dropProfile('other');
    applied.length = 0;
    await opts.applyProfile('proxy');
    const temp = applied[0] as SwitchProfile;
    expect(temp.profileType).toBe('SwitchProfile');
    expect(temp.rules).toHaveLength(0);
    expect(temp.defaultProfileName).toBe('proxy');
  });
});

describe('Options#addTempRule', () => {
  it('indexes a domain once and is a no-op when repeated', async () => {
    const { impl } = recordingProxy();
    const opts = await createLoaded(bag(), impl);
    await opts.applyProfile('proxy');
    await opts.addTempRule('example.com', 'direct');
    await opts.addTempRule('example.com', 'direct');
    expect(opts.tempProfile()?.rules).toHaveLength(1);
    expect(opts.queryTempRule('example.com')).toBe('direct');
  });

  it('retargets an existing domain without duplicating the rule', async () => {
    const other: FixedProfile = {
      name: 'other',
      profileType: 'FixedProfile',
      color: '#abcdef',
      fallbackProxy: { scheme: 'http', host: 'other.example', port: 9 },
    };
    const opts = await createLoaded(bag({ '+other': other }));
    await opts.applyProfile('proxy');
    await opts.addTempRule('example.com', 'direct');
    await opts.addTempRule('example.com', 'other');
    expect(opts.tempProfile()?.rules).toHaveLength(1);
    expect(opts.queryTempRule('example.com')).toBe('other');
  });

  it('rejects a missing target profile', async () => {
    const opts = await createLoaded(bag());
    await opts.applyProfile('proxy');
    await expect(opts.addTempRule('example.com', 'nope')).rejects.toBeInstanceOf(
      ProfileNotExistError,
    );
  });
});

describe('Options#setExternalProfile', () => {
  it('reverts the first external change to the currently applied profile', async () => {
    const { impl, applied } = recordingProxy();
    const opts = await createLoaded(bag({ '-revertProxyChanges': true }), impl);
    await opts.applyProfile('proxy');
    applied.length = 0;
    opts.setExternalProfile({ name: 'intruder', profileType: 'FixedProfile' });
    await vi.waitFor(() => {
      expect(applied.map((p) => p.name)).toEqual(['proxy']);
    });
    expect(opts.currentName()).toBe('proxy');
    expect(opts.revertToName()).toBeNull();
  });

  it('remembers the applied profile under noRevert and reverts later changes to it', async () => {
    const { impl, applied } = recordingProxy();
    const opts = await createLoaded(bag({ '-revertProxyChanges': true }), impl);
    await opts.applyProfile('proxy');
    opts.setExternalProfile(
      { name: 'direct', profileType: 'DirectProfile' },
      { noRevert: true },
    );
    expect(opts.currentName()).toBe('direct');
    expect(opts.revertToName()).toBe('proxy');

    applied.length = 0;
    opts.setExternalProfile({ name: 'intruder', profileType: 'FixedProfile' });
    await vi.waitFor(() => {
      expect(applied.map((p) => p.name)).toEqual(['proxy']);
    });
  });

  it('adopts an unknown profile when revert is off', async () => {
    const opts = await createLoaded(bag({ '-revertProxyChanges': false }));
    await opts.applyProfile('proxy');
    const external: Profile = { name: 'other-ext', profileType: 'SystemProfile' };
    opts.setExternalProfile(external);
    expect(opts.currentName()).toBeNull();
    expect(opts.currentProfile()).toEqual({
      name: 'other-ext',
      profileType: 'SystemProfile',
      color: '#49afcd',
    });
    expect(opts.tempActive()).toBe(false);
  });

  it('applies a known profile without touching the proxy when internal', async () => {
    const { impl, applied } = recordingProxy();
    const opts = await createLoaded(bag({ '-revertProxyChanges': false }), impl);
    await opts.applyProfile('proxy');
    applied.length = 0;
    opts.setExternalProfile(
      { name: 'direct', profileType: 'DirectProfile' },
      { internal: true },
    );
    await vi.waitFor(() => {
      expect(opts.currentName()).toBe('direct');
    });
    expect(applied).toHaveLength(0);
  });
});

describe('Options#updateProfile revision', () => {
  it('keeps a concurrently edited profile instead of applying the fetch', async () => {
    const pac = {
      name: 'pac',
      profileType: 'PacProfile',
      pacUrl: 'http://example.com/p.pac',
      pacScript: 'old',
      revision: Revision.fromTime(1),
    } satisfies PacProfile;

    const opts = await createLoaded(bag({ '+pac': pac }));
    let release!: (data: string) => void;
    opts.fetchResult = new Promise((resolve) => {
      release = resolve;
    });

    const updating = opts.updateProfile('pac');
    const edited: PacProfile = {
      ...pac,
      revision: Revision.fromTime(9),
      pacScript: 'edited-locally',
    };
    opts.replaceProfile('pac', edited);
    release('function FindProxyForURL(){ return "PROXY x:1"; }');

    const result = await updating;
    expect(result['+pac']).toEqual(edited);
    expect((opts.profile('pac') as PacProfile).pacScript).toBe('edited-locally');
  });

  it('writes a new revision when the fetch lands on an unchanged profile', async () => {
    const pac = {
      name: 'pac',
      profileType: 'PacProfile',
      pacUrl: 'http://example.com/p.pac',
      pacScript: 'old',
      revision: Revision.fromTime(1),
    } satisfies PacProfile;

    const opts = await createLoaded(bag({ '+pac': pac }));
    opts.fetchResult = Promise.resolve('function FindProxyForURL(){ return "DIRECT"; }');
    const result = await opts.updateProfile('pac');
    const updated = result['+pac'] as PacProfile & { lastUpdate?: string };
    expect(updated.pacScript).toBe('function FindProxyForURL(){ return "DIRECT"; }');
    expect(updated.revision).not.toBe(pac.revision);
    expect(updated.lastUpdate).toBeTruthy();
  });
});

describe('Options malformed payloads', () => {
  it('loads cyclic profiles and breaks the cycle in matchProfile', async () => {
    const storage = new Storage();
    await storage.set({
      schemaVersion: 2,
      '+a': {
        name: 'a',
        profileType: 'SwitchProfile',
        color: '#111111',
        defaultProfileName: 'b',
        rules: [],
      } satisfies SwitchProfile,
      '+b': {
        name: 'b',
        profileType: 'SwitchProfile',
        color: '#222222',
        defaultProfileName: 'c',
        rules: [],
      } satisfies SwitchProfile,
      '+c': {
        name: 'c',
        profileType: 'SwitchProfile',
        color: '#333333',
        defaultProfileName: 'a',
        rules: [],
      } satisfies SwitchProfile,
    });

    const opts = new HarnessOptions(null, storage, new Storage(), Log, null, proxyImpl);
    await opts.ready;
    expect(opts.getAll()['+a']).toBeTruthy();
    await opts.applyProfile('a');

    const matched = await opts.matchProfile(Conditions.requestFromUrl('http://example.com/'));
    expect(matched.profile?.name).toBeTruthy();
    expect(matched.results.length).toBeGreaterThan(0);
    expect(matched.results.length).toBeLessThanOrEqual(3);
  });

  it('does not wipe a bag that contains a profile missing profileType', async () => {
    const storage = new Storage();
    const broken = { name: 'broken' };
    await storage.set({
      schemaVersion: 2,
      '+broken': broken,
      '+proxy': bag()['+proxy'],
    });

    const opts = new Options(null, storage, new Storage(), Log, null, proxyImpl);
    const loaded = await opts.optionsLoaded;
    expect(loaded['+broken']).toEqual(broken);
    expect(loaded['schemaVersion']).toBe(2);
  });

  it('stops matchProfile on a missing profileType instead of throwing', async () => {
    const opts = await createLoaded(bag());
    await opts.applyProfile('proxy');
    opts.replaceProfile('proxy', { name: 'proxy' } as Profile);

    const matched = await opts.matchProfile(Conditions.requestFromUrl('http://example.com/'));
    expect(matched.profile).toBeUndefined();
    expect(matched.results).toEqual([]);
  });

  it('stops matchProfile when a switch chain hits a typeless profile', async () => {
    const opts = await createLoaded(
      bag({
        '+auto': {
          name: 'auto',
          profileType: 'SwitchProfile',
          color: '#99dd99',
          defaultProfileName: 'proxy',
          rules: [],
        } satisfies SwitchProfile,
      }),
    );
    await opts.applyProfile('auto');
    opts.replaceProfile('proxy', { name: 'proxy' } as Profile);
    const matched = await opts.matchProfile(Conditions.requestFromUrl('http://example.com/'));
    expect(matched.profile?.name).toBe('auto');
    expect(matched.results).toHaveLength(1);
  });
});
