/**
 * Screen renderers for the options page.
 *
 * Each takes the container to fill. Controls carrying `data-option` are bound
 * to the working copy by the shell; anything more involved wires its own
 * listeners.
 */

import { downloadFile, h, must } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { api, callBackground } from '../lib/messaging.js';
import { markDirty, options } from './main.js';
import { Profiles, type FixedProfile, type Profile, type ProxyServer } from '@switchydelta/pac';

/** A labelled checkbox bound to a top-level option key. */
function check(key: string, labelKey: string, hint?: string) {
  const input = h('input', {
    type: 'checkbox',
    checked: options[key] !== false,
    dataset: { option: key },
  });
  // Defaults differ per key; only a strict false counts as off.
  input.checked = options[key] === true || (options[key] !== false && defaultsOn(key));

  return h(
    'label',
    { class: 'om-check' },
    input,
    h('span', {}, h('span', { text: t(labelKey) }), hint && h('small', { text: ' ' + t(hint) })),
  );
}

function defaultsOn(key: string): boolean {
  return key === '-confirmDeletion' || key === '-showExternalProfile';
}

function field(labelKey: string, control: HTMLElement) {
  return h('label', { class: 'om-field' }, h('span', { text: t(labelKey) }), control);
}

export function renderUi(container: HTMLElement): void {
  container.append(
    h('h2', { text: t('options_navInterface') }),
    check('-confirmDeletion', 'options_confirmDeletion'),
    check('-refreshOnProfileChange', 'options_refreshOnProfileChange'),
    check('-addConditionsToBottom', 'options_addConditionsToBottom'),
    check('-showExternalProfile', 'options_showExternalProfile'),
    check('-enableQuickSwitch', 'options_enableQuickSwitch'),
  );
}

/** Download interval choices, in minutes; -1 means never. */
const DOWNLOAD_INTERVALS = [15, 60, 180, 360, 720, 1440, -1];

export function renderGeneral(container: HTMLElement): void {
  const select = h(
    'select',
    { dataset: { option: '-downloadInterval' } },
    ...DOWNLOAD_INTERVALS.map((minutes) =>
      h('option', {
        value: String(minutes),
        text: minutes < 0 ? t('options_updateInterval_never') : String(minutes),
        selected: options['-downloadInterval'] === minutes,
      }),
    ),
  );

  container.append(
    h('h2', { text: t('options_navGeneral') }),
    field('options_downloadInterval', select),
    check('-monitorWebRequests', 'options_monitorWebRequests'),
  );
}

export function renderIo(container: HTMLElement): void {
  const urlInput = h('input', { type: 'url', placeholder: 'https://' });
  const status = h('p', { class: 'om-status' });

  const restore = async (text: string) => {
    try {
      await api.reset(JSON.parse(text));
      location.reload();
    } catch (err) {
      status.className = 'om-error';
      status.textContent = err instanceof Error ? err.message : String(err);
    }
  };

  const fileInput = h('input', {
    type: 'file',
    accept: '.bak,application/json',
    onchange: async (event: Event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) await restore(await file.text());
    },
  });

  container.append(
    h('h2', { text: t('options_navImportExport') }),

    h('h3', { text: t('options_exportOptions') }),
    h('button', {
      type: 'button',
      class: 'om-btn',
      text: t('options_exportOptions'),
      onclick: () =>
        downloadFile('OmegaOptions.bak', JSON.stringify(options, null, 2), 'application/json'),
    }),

    h('h3', { text: t('options_importOptions') }),
    field('options_restoreLocal', fileInput),
    field('options_restoreOnline', urlInput),
    h('button', {
      type: 'button',
      class: 'om-btn',
      text: t('options_restoreOnline'),
      onclick: async () => {
        try {
          const response = await fetch(urlInput.value);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          await restore(await response.text());
        } catch (err) {
          status.className = 'om-error';
          status.textContent = err instanceof Error ? err.message : String(err);
        }
      },
    }),
    status,
  );
}

export function renderAbout(container: HTMLElement): void {
  const version = chrome.runtime.getManifest().version;
  container.append(
    h('h2', { text: t('options_navAbout') }),
    h('p', { text: `${t('appNameShort')} ${version}` }),
    h('p', {}, h('a', { href: 'https://github.com/madeye/SwitchyDelta', text: 'GitHub' })),
  );
}

// --- Profile editing --------------------------------------------------------

const PROXY_SCHEMES = ['http', 'https', 'socks4', 'socks5'];
const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443, socks4: 1080, socks5: 1080 };

export function renderProfile(container: HTMLElement, name: string): void {
  const profile = Profiles.byName(name, options);
  if (!profile) {
    container.append(h('p', { class: 'om-error', text: t('options_profileNotFound') }));
    return;
  }

  container.append(h('h2', { text: profile.name }));

  if (profile.profileType === 'FixedProfile') {
    renderFixedProfile(container, profile as FixedProfile);
  } else {
    // Editors for the remaining profile types are not ported yet; the profile
    // itself still works, it just cannot be edited from this screen.
    container.append(
      h('p', {
        text: `${t('options_profileType')}: ${profile.profileType}`,
      }),
      h('p', {
        class: 'om-error',
        text: `Editing ${profile.profileType} is not available in this build yet.`,
      }),
    );
  }

  container.append(
    h('button', {
      type: 'button',
      class: 'om-btn',
      text: t('options_exportPacFile'),
      onclick: () => exportPac(profile),
    }),
  );
}

function renderFixedProfile(container: HTMLElement, profile: FixedProfile): void {
  const proxy: ProxyServer = profile.fallbackProxy ?? { scheme: 'http', host: '', port: 80 };
  profile.fallbackProxy = proxy;

  const touch = () => {
    Profiles.updateRevision(profile);
    markDirty();
  };

  const scheme = h(
    'select',
    {
      onchange: (event: Event) => {
        proxy.scheme = (event.target as HTMLSelectElement).value;
        if (!port.value) proxy.port = DEFAULT_PORTS[proxy.scheme] ?? 80;
        touch();
      },
    },
    ...PROXY_SCHEMES.map((s) =>
      h('option', { value: s, text: s.toUpperCase(), selected: proxy.scheme === s }),
    ),
  );

  const host = h('input', {
    type: 'text',
    value: proxy.host,
    oninput: (event: Event) => {
      proxy.host = (event.target as HTMLInputElement).value;
      touch();
    },
  });

  const port = h('input', {
    type: 'number',
    value: String(proxy.port),
    min: '1',
    max: '65535',
    oninput: (event: Event) => {
      proxy.port = Number((event.target as HTMLInputElement).value);
      touch();
    },
  });

  const bypass = h('textarea', {
    value: (profile.bypassList ?? []).map((c) => c.pattern).join('\n'),
    oninput: (event: Event) => {
      profile.bypassList = (event.target as HTMLTextAreaElement).value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((pattern) => ({ conditionType: 'BypassCondition' as const, pattern }));
      touch();
    },
  });

  container.append(
    field('options_proxyProtocol', scheme),
    field('options_proxyServer', host),
    field('options_proxyPort', port),
    field('options_bypassList', bypass),
  );
}

async function exportPac(profile: Profile): Promise<void> {
  try {
    const pac = await callPac(profile.name);
    downloadFile(`OmegaProfile_${profile.name}.pac`, pac, 'application/x-ns-proxy-autoconfig');
  } catch (err) {
    must('#om-status').textContent = err instanceof Error ? err.message : String(err);
  }
}

/** PAC generation runs in the background, which owns the resolved options. */
function callPac(name: string): Promise<string> {
  return callBackground<string>('pacForProfile', name);
}
