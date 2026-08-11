/**
 * Screen renderers for the options page.
 *
 * Each takes the container to fill. Controls carrying `data-option` are bound
 * to the working copy by the shell; anything more involved wires its own
 * listeners.
 */

import { append, downloadFile, h, must, render } from '../lib/dom.js';
import { profileDisplayName, t } from '../lib/i18n.js';
import { api, callBackground, getState, setState } from '../lib/messaging.js';
import { colorFor, getAttachedName, listProfiles, profileColors } from '../lib/profile-view.js';
import {
  adoptOptionsKey,
  applyChanges,
  isDirty,
  markDirty,
  options,
  setNavigationGuard,
} from './main.js';
import { maybeShowSwitchProfileGuide } from './guide.js';
import {
  Conditions,
  parseIp,
  Profiles,
  RuleList,
  type Condition,
  type ConditionType,
  type FixedProfile,
  type PacProfile,
  type Profile,
  type ProxyServer,
  type Rule,
  type RuleListProfile,
  type SwitchProfile,
} from '@switchydelta/pac';

/** Option keys whose absence means "on" (mirrors the background's defaults). */
const DEFAULT_ON = new Set([
  '-confirmDeletion',
  '-refreshOnProfileChange',
  '-showInspectMenu',
  '-showExternalProfile',
  '-monitorWebRequests',
  '-revertProxyChanges',
]);

/** A labelled checkbox bound to a top-level option key. */
function check(key: string, labelKey: string, hint?: string) {
  const input = h('input', {
    type: 'checkbox',
    checked: options[key] !== false,
    dataset: { option: key },
  });
  // Defaults differ per key; only a strict false counts as off.
  input.checked = options[key] === true || (options[key] !== false && DEFAULT_ON.has(key));

  return h(
    'label',
    { class: 'om-check' },
    input,
    h('span', {}, h('span', { text: t(labelKey) }), hint && h('small', { text: ' ' + t(hint) })),
  );
}

function field(labelKey: string, control: HTMLElement) {
  return h('label', { class: 'om-field' }, h('span', { text: t(labelKey) }), control);
}

/** A section heading inside a tab, like the original's `.settings-group h3`. */
function group(labelKey: string) {
  return h('h3', { text: t(labelKey) });
}

/**
 * A help paragraph. Rendered as HTML because several catalogue strings carry
 * inline markup (`<br>`, `<b>`, …); they are our own translations, so this is
 * as trusted as the original's `omega-html` binding was.
 */
function help(labelKey: string, substitutions?: string[]) {
  return h('p', { class: 'om-help', html: t(labelKey, substitutions) });
}

/** Names offered by profile pickers: the builtins plus every user profile. */
function selectableProfileNames(): string[] {
  return ['direct', 'system', ...listProfiles(options).map((profile) => profile.name)];
}

export function renderUi(container: HTMLElement): void {
  container.append(
    h('h2', { text: t('options_tab_ui') }),

    group('options_group_miscOptions'),
    check('-confirmDeletion', 'options_confirmDeletion'),
    check('-refreshOnProfileChange', 'options_refreshOnProfileChange'),
    check('-showInspectMenu', 'options_showInspectMenu'),
    check('-addConditionsToBottom', 'options_addConditionsToBottom'),

    group('options_group_keyboardShortcut'),
    h(
      'p',
      {},
      h('button', {
        type: 'button',
        class: 'om-btn',
        text: t('options_menuShortcutConfigure'),
        // chrome:// pages cannot be linked, only opened through the tabs API.
        onclick: () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }),
      }),
      ' ',
      t('options_menuShortcutHelp'),
    ),
    help('options_menuShortcutMore'),

    group('options_group_switchOptions'),
    field('options_startupProfile', startupProfileSelect()),
    advancedConditionTypesCheck(),
    quickSwitchSection(),
  );
}

function startupProfileSelect(): HTMLSelectElement {
  const current = (options['-startupProfileName'] as string | undefined) ?? '';
  return h(
    'select',
    { dataset: { option: '-startupProfileName' } },
    h('option', { value: '', text: t('options_startupProfile_none'), selected: current === '' }),
    ...selectableProfileNames().map((name) =>
      h('option', { value: name, text: profileDisplayName(name), selected: current === name }),
    ),
  );
}

/** Stored as 1/0 rather than a boolean; kept that way for backup compatibility. */
function advancedConditionTypesCheck(): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const input = h('input', {
    type: 'checkbox',
    checked: Number(options['-showConditionTypes'] ?? 0) > 0,
    onchange: () => {
      options['-showConditionTypes'] = input.checked ? 1 : 0;
      markDirty();
    },
  });
  fragment.append(
    h(
      'label',
      { class: 'om-check' },
      input,
      h('span', {}, h('span', { text: t('options_showConditionTypesAdvanced') })),
    ),
    help('options_showConditionTypesAdvancedHelp'),
  );
  return fragment;
}

/**
 * Quick Switch: the enable toggle plus the cycle editor — which profiles the
 * toolbar icon cycles through, in order. The original used drag-and-drop
 * lists; buttons do the same job at side-panel width.
 */
function quickSwitchSection(): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const editor = h('div', { class: 'om-quick-switch' });

  const enable = h('input', {
    type: 'checkbox',
    checked: options['-enableQuickSwitch'] === true,
    onchange: () => {
      options['-enableQuickSwitch'] = enable.checked;
      markDirty();
      rerender();
    },
  });

  const rerender = () => {
    editor.hidden = options['-enableQuickSwitch'] !== true;
    if (editor.hidden) {
      render(editor, []);
      return;
    }

    const cycled = ((options['-quickSwitchProfiles'] as string[] | undefined) ?? []).slice();
    const notCycled = selectableProfileNames().filter((name) => !cycled.includes(name));
    const setCycled = (next: string[]) => {
      options['-quickSwitchProfiles'] = next;
      markDirty();
      rerender();
    };

    render(editor, [
      h('h4', { text: t('options_cycledProfiles') }),
      h('p', { class: 'om-help', text: t('options_cycledProfilesHelp') }),
      cycled.length < 2 && h('p', { class: 'om-error', text: t('options_cycledProfilesTooFew') }),
      h(
        'ul',
        { class: 'om-cycle' },
        ...cycled.map((name, index) =>
          h(
            'li',
            {},
            h('span', { text: profileDisplayName(name) }),
            h(
              'span',
              { class: 'om-cycle-buttons' },
              index > 0 &&
                h('button', {
                  type: 'button',
                  class: 'om-mini',
                  text: '↑',
                  onclick: () => {
                    const next = cycled.slice();
                    [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                    setCycled(next);
                  },
                }),
              h('button', {
                type: 'button',
                class: 'om-mini',
                text: '✕',
                onclick: () => setCycled(cycled.filter((other) => other !== name)),
              }),
            ),
          ),
        ),
      ),
      h('h4', { text: t('options_notCycledProfiles') }),
      h(
        'ul',
        { class: 'om-cycle' },
        ...notCycled.map((name) =>
          h(
            'li',
            {},
            h('span', { text: profileDisplayName(name) }),
            h('button', {
              type: 'button',
              class: 'om-mini',
              text: '+',
              onclick: () => setCycled([...cycled, name]),
            }),
          ),
        ),
      ),
    ]);
  };

  rerender();
  fragment.append(
    h(
      'label',
      { class: 'om-check' },
      enable,
      h('span', {}, h('span', { text: t('options_quickSwitch') })),
    ),
    editor,
  );
  return fragment;
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
        text: t(
          minutes < 0 ? 'options_downloadInterval_never' : 'options_downloadInterval_' + minutes,
        ),
        selected: options['-downloadInterval'] === minutes,
      }),
    ),
  );
  const systemName = profileDisplayName('system');

  container.append(
    h('h2', { text: t('options_tab_general') }),

    group('options_group_networkRequests'),
    check('-monitorWebRequests', 'options_monitorWebRequests'),
    help('options_monitorWebRequestsHelp'),

    group('options_downloadOptions'),
    help('options_downloadOptionsHelp'),
    field('options_downloadInterval', select),

    group('options_group_conflicts'),
    h('p', { text: t('options_conflicts_introduction') }),
    h(
      'p',
      { class: 'om-help' },
      h('span', { class: 'om-badge-conflict', text: '=' }),
      ' ',
      t('options_conflicts_lowerPriority'),
    ),
    help('options_conflicts_higherPriority', [systemName]),
    check('-showExternalProfile', 'options_showExternalProfile'),
    help('options_showExternalProfileHelp', [systemName, t('popup_externalProfile')]),
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

  append(container, [
    h('h2', { text: t('options_tab_importExport') }),

    group('options_group_importExportProfile'),
    help('options_exportProfileHelp'),
    // The legacy format only matters for basic condition types, so the
    // original hides this once advanced types are on. Same here.
    Number(options['-showConditionTypes'] ?? 0) <= 0 &&
      check('-exportLegacyRuleList', 'options_exportLegacyRuleList'),
    Number(options['-showConditionTypes'] ?? 0) <= 0 && help('options_exportLegacyRuleListHelp'),

    group('options_group_importExportSettings'),
    h('button', {
      type: 'button',
      class: 'om-btn',
      text: t('options_makeBackup'),
      onclick: () =>
        downloadFile('OmegaOptions.bak', JSON.stringify(options, null, 2), 'application/json'),
    }),
    help('options_makeBackupHelp'),

    field('options_restoreLocal', fileInput),
    help('options_restoreLocalHelp'),
    field('options_restoreOnline', urlInput),
    h('button', {
      type: 'button',
      class: 'om-btn',
      text: t('options_restoreOnlineSubmit'),
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

    group('options_group_syncing'),
    syncSection(),
  ]);
}

/**
 * Options syncing. The state machine lives in the background; this renders
 * the same four states the original page had and calls the same RPCs. Sync
 * actions can replace the whole options bag, so the page reloads after each.
 */
function syncSection(): HTMLElement {
  const wrap = h('div');

  const act = (action: () => Promise<unknown>) => {
    void action().then(
      () => location.reload(),
      (err: unknown) => {
        wrap.append(
          h('p', { class: 'om-error', text: err instanceof Error ? err.message : String(err) }),
        );
      },
    );
  };
  const button = (labelKey: string, action: () => Promise<unknown>) =>
    h('button', {
      type: 'button',
      class: 'om-btn',
      text: t(labelKey),
      onclick: () => act(action),
    });

  void getState('syncOptions').then(({ syncOptions }) => {
    const mode = (syncOptions as string) || 'pristine';
    if (mode === 'unsupported') {
      render(wrap, [help('options_syncUnsupportedHelp')]);
    } else if (mode === 'sync') {
      render(wrap, [
        h('p', { text: t('options_syncSyncAlert') }),
        help('options_syncSyncHelp'),
        h('p', {}, button('options_syncDisable', () => api.setOptionsSync(false))),
      ]);
    } else if (mode === 'conflict') {
      render(wrap, [
        h('p', { text: t('options_syncConflictAlert') }),
        help('options_syncConflictHelp'),
        h(
          'p',
          {},
          button('options_syncEnableForce', () => api.setOptionsSync(true, { force: true })),
          ' ',
          button('options_syncReset', () => api.resetOptionsSync()),
        ),
      ]);
    } else {
      // pristine / disabled
      render(wrap, [
        help('options_syncPristineHelp'),
        h('p', {}, button('options_syncEnable', () => api.setOptionsSync(true))),
      ]);
    }
  });

  return wrap;
}

export function renderAbout(container: HTMLElement): void {
  const version = chrome.runtime.getManifest().version;
  container.append(
    h('h2', { text: t('about_title') }),
    h('p', { text: t('about_app_description') }),
    h('p', { text: t('about_version', [version]) }),
    help('about_disclaimer_networkService'),
    help('about_disclaimer_privacy'),
    help('about_help'),
    help('about_copyright'),
    help('about_license'),
    help('about_credits'),
  );
}

// --- Profile editing --------------------------------------------------------

const PROXY_SCHEMES = ['http', 'https', 'socks4', 'socks5'];
const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443, socks4: 1080, socks5: 1080 };

/** Expand `#rgb` to `#rrggbb` so `<input type="color">` accepts the value. */
function normalizeHex(color: string): string {
  const raw = color.trim();
  const short = /^#([0-9a-fA-F]{3})$/.exec(raw);
  if (short) {
    const [r, g, b] = short[1]!;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const full = /^#([0-9a-fA-F]{6})$/.exec(raw);
  if (full) return `#${full[1]!}`.toLowerCase();
  // Fall back to a palette colour when the stored value is not a hex string.
  return profileColors[0]!;
}

export function renderProfile(container: HTMLElement, name: string): void {
  const profile = Profiles.byName(name, options);
  if (!profile) {
    container.append(h('p', { class: 'om-error', text: t('options_profileNotFound') }));
    return;
  }
  const typeName =
    chrome.i18n.getMessage('options_profileType' + profile.profileType) || profile.profileType;

  const feedback = h('p', { class: 'om-error' });

  // Rename / delete talk to the background directly, so pending edits would be
  // silently dropped by the reload that follows. Same rule as the original:
  // apply first.
  const requireClean = (): boolean => {
    if (!isDirty()) return true;
    feedback.textContent = t('options_applyOptionsRequired');
    return false;
  };

  // --- Rename: an inline row instead of the original's modal. ---------------
  const renameInput = h('input', { type: 'text', value: profile.name });
  const renameRow = h(
    'div',
    { class: 'om-inline-form', hidden: true },
    field('options_renameProfileName', renameInput),
    h('button', {
      type: 'button',
      class: 'om-btn om-btn-primary',
      text: t('dialog_ok'),
      onclick: () => {
        const next = renameInput.value.trim();
        const problem = profileNameProblem(next, profile.name);
        if (problem) {
          feedback.textContent = problem;
          return;
        }
        if (next === profile.name) {
          renameRow.hidden = true;
          return;
        }
        void api.renameProfile(profile.name, next).then(
          () => {
            location.hash = '#/profile/' + encodeURIComponent(next);
            location.reload();
          },
          (err: unknown) => {
            feedback.textContent = err instanceof Error ? err.message : String(err);
          },
        );
      },
    }),
    ' ',
    h('button', {
      type: 'button',
      class: 'om-btn',
      text: t('dialog_cancel'),
      onclick: () => (renameRow.hidden = true),
    }),
  );

  // --- Delete: inline confirm, honouring the confirm-deletion option. -------
  const doDelete = () => {
    if (profileReferencedBy(profile.name)) {
      feedback.textContent = t('options_modalHeader_cannotDeleteProfile');
      return;
    }
    // replaceRef points the applied profile elsewhere if this one is active;
    // with no references left it is otherwise a no-op. The removal itself
    // goes through patch's `[old, 0, 0]` delta — an `undefined` value would
    // be dropped by the message JSON serialization and delete nothing.
    void api
      .replaceRef(profile.name, 'direct')
      .then(() => api.patch({ ['+' + profile.name]: [profile, 0, 0] }))
      .then(
        () => {
          location.hash = '#/ui';
          location.reload();
        },
        (err: unknown) => {
          feedback.textContent = err instanceof Error ? err.message : String(err);
        },
      );
  };
  const deleteRow = h(
    'div',
    { class: 'om-inline-form', hidden: true },
    h('span', { text: t('options_deleteProfileConfirm') + ' ' + profile.name }),
    ' ',
    h('button', {
      type: 'button',
      class: 'om-btn om-btn-danger',
      text: t('dialog_ok'),
      onclick: doDelete,
    }),
    ' ',
    h('button', {
      type: 'button',
      class: 'om-btn',
      text: t('dialog_cancel'),
      onclick: () => (deleteRow.hidden = true),
    }),
  );

  // Virtual profiles inherit colour from their target; only concrete profiles
  // store an editable colour of their own (matches the original spectrum picker).
  const colorEditable = profile.profileType !== 'VirtualProfile';
  const headSwatch = h('span', {
    class: 'om-swatch om-swatch-lg',
    style: { background: colorFor(profile, options) },
    title: colorEditable ? undefined : colorFor(profile, options),
  });

  const setProfileColor = (hex: string) => {
    if (!colorEditable) return;
    profile.color = normalizeHex(hex);
    headSwatch.style.background = profile.color;
    // Keep the sidebar chip in step with the working copy.
    const href = '#/profile/' + encodeURIComponent(profile.name);
    const navLink = document.querySelector<HTMLElement>(
      `.om-sidebar a[href=${JSON.stringify(href)}]`,
    );
    const navSwatch = navLink?.querySelector<HTMLElement>('.om-swatch');
    if (navSwatch) navSwatch.style.background = profile.color;
    for (const chip of colorPalette.querySelectorAll<HTMLButtonElement>('.om-color-chip')) {
      chip.setAttribute('aria-current', chip.dataset['color'] === profile.color ? 'true' : 'false');
    }
    if (colorInput) colorInput.value = profile.color;
    Profiles.updateRevision(profile);
    markDirty();
  };

  const colorPalette = h(
    'div',
    { class: 'om-color-palette', hidden: !colorEditable, role: 'group', 'aria-label': 'Profile color' },
    ...profileColors.map((hex) =>
      h('button', {
        type: 'button',
        class: 'om-color-chip',
        title: hex,
        dataset: { color: hex },
        style: { background: hex },
        'aria-label': hex,
        'aria-current':
          normalizeHex(profile.color ?? '') === normalizeHex(hex) ? 'true' : 'false',
        onclick: () => setProfileColor(hex),
      }),
    ),
  );

  const colorInput = colorEditable
    ? h('input', {
        type: 'color',
        class: 'om-color-input',
        value: normalizeHex(profile.color ?? profileColors[0]!),
        title: profile.color ?? '',
        oninput: (event: Event) => setProfileColor((event.target as HTMLInputElement).value),
      })
    : null;

  const actionsRow = h(
    'div',
    { class: 'om-actions-row' },
    h('button', {
      type: 'button',
      class: 'om-btn',
      text: t('options_renameProfile'),
      onclick: () => {
        if (!requireClean()) return;
        deleteRow.hidden = true;
        renameRow.hidden = false;
        renameInput.focus();
      },
    }),
    h('button', {
      type: 'button',
      class: 'om-btn',
      text: t('options_deleteProfile'),
      onclick: () => {
        if (!requireClean()) return;
        renameRow.hidden = true;
        if (options['-confirmDeletion'] === false) doDelete();
        else deleteRow.hidden = false;
      },
    }),
    h('button', {
      type: 'button',
      class: 'om-btn',
      text: t('options_profileExportPac'),
      onclick: () => exportPac(profile),
    }),
  );

  container.append(
    h(
      'div',
      { class: 'om-profile-head' },
      headSwatch,
      h('h2', { text: profile.name }),
      colorPalette,
      colorInput,
    ),
    h('p', { class: 'om-help', text: typeName }),
    actionsRow,
    renameRow,
    deleteRow,
    feedback,
  );

  if (profile.profileType === 'FixedProfile') {
    renderFixedProfile(container, profile as FixedProfile);
  } else if (profile.profileType === 'SwitchProfile') {
    renderSwitchProfile(container, profile as SwitchProfile, actionsRow);
  } else if (profile.profileType === 'PacProfile') {
    renderPacProfile(container, profile as PacProfile);
  } else {
    // Editors for the remaining profile types are not ported yet; the profile
    // itself still works, it just cannot be edited from this screen.
    container.append(
      h('p', {
        class: 'om-error',
        text: `Editing ${typeName} is not available in this build yet.`,
      }),
    );
  }
}

// --- Switch profile editor --------------------------------------------------

/** Grouped condition types, mirroring the original's basic/advanced split. */
const BASIC_CONDITION_TYPES: Array<[string, ConditionType[]]> = [
  [
    'condition_group_default',
    ['HostWildcardCondition', 'UrlWildcardCondition', 'UrlRegexCondition', 'FalseCondition'],
  ],
];
const ADVANCED_CONDITION_TYPES: Array<[string, ConditionType[]]> = [
  [
    'condition_group_host',
    ['HostWildcardCondition', 'HostRegexCondition', 'HostLevelsCondition', 'IpCondition'],
  ],
  ['condition_group_url', ['UrlWildcardCondition', 'UrlRegexCondition', 'KeywordCondition']],
  ['condition_group_special', ['WeekdayCondition', 'TimeCondition', 'FalseCondition']],
];

/**
 * Types that count as "basic" when deciding whether the legacy rule-list
 * export can represent this profile. TrueCondition belongs here because the
 * original editor migrated it to a `*` host wildcard on sight.
 */
const BASIC_CONDITION_TYPE_SET: ReadonlySet<string> = new Set([
  ...BASIC_CONDITION_TYPES.flatMap(([, types]) => types),
  'TrueCondition',
]);

/** A fresh condition of `type`, carrying the pattern over when both use one. */
function conditionOfType(type: ConditionType, previous: Condition): Condition {
  const pattern = 'pattern' in previous ? (previous.pattern ?? '') : '';
  switch (type) {
    case 'HostLevelsCondition':
      return { conditionType: type, minValue: 1, maxValue: 1 };
    case 'TimeCondition':
      return { conditionType: type, startHour: 0, endHour: 0 };
    case 'WeekdayCondition':
      return { conditionType: type, days: '-------' };
    case 'IpCondition':
      return { conditionType: type, ip: '0.0.0.0', prefixLength: 0 };
    default:
      return { conditionType: type, pattern } as Condition;
  }
}

/** The editing control(s) for one condition, wired straight to the object. */
function conditionDetails(condition: Condition, touch: () => void): HTMLElement {
  const wrap = h('span', { class: 'om-condition-details' });

  const number = (get: () => number, set: (v: number) => void, min: number, max: number) =>
    h('input', {
      type: 'number',
      min: String(min),
      max: String(max),
      value: String(get()),
      oninput: (event: Event) => {
        set(Number((event.target as HTMLInputElement).value));
        touch();
      },
    });

  switch (condition.conditionType) {
    case 'HostLevelsCondition':
      wrap.append(
        number(() => condition.minValue, (v) => (condition.minValue = v), 1, 99),
        h('span', { class: 'om-between', text: t('options_hostLevelsBetween') }),
        number(() => condition.maxValue, (v) => (condition.maxValue = v), 1, 99),
      );
      break;
    case 'TimeCondition':
      wrap.append(
        number(() => condition.startHour, (v) => (condition.startHour = v), 0, 23),
        h('span', { class: 'om-between', text: t('options_hourBetween') }),
        number(() => condition.endHour, (v) => (condition.endHour = v), 0, 23),
      );
      break;
    case 'WeekdayCondition': {
      const flags = Conditions.getWeekdayList(condition);
      wrap.append(
        ...flags.map((enabled, day) => {
          const box = h('input', {
            type: 'checkbox',
            checked: enabled,
            onchange: () => {
              flags[day] = box.checked;
              condition.days = flags.map((on, i) => (on ? 'SMTWTFS'[i] : '-')).join('');
              delete condition.startDay;
              delete condition.endDay;
              touch();
            },
          });
          return h(
            'label',
            { class: 'om-day' },
            box,
            h('span', { text: t('options_weekDayShort_' + day) }),
          );
        }),
      );
      break;
    }
    case 'IpCondition': {
      const input = h('input', {
        type: 'text',
        placeholder: '127.0.0.1/8',
        value: `${condition.ip}/${condition.prefixLength}`,
        oninput: () => {
          const m = /^\s*(.*?)\/(\d{1,3})\s*$/.exec(input.value);
          const parsed = m && m[1] ? parseIp(m[1]) : null;
          input.classList.toggle('om-invalid', !parsed);
          if (!parsed) return;
          condition.ip = m![1]!;
          condition.prefixLength = Number(m![2]);
          touch();
        },
      });
      wrap.append(input);
      break;
    }
    case 'FalseCondition':
      wrap.append(
        h('input', {
          type: 'text',
          value: condition.pattern ?? '',
          placeholder: t('condition_details_FalseCondition'),
          oninput: (event: Event) => {
            condition.pattern = (event.target as HTMLInputElement).value;
            touch();
          },
        }),
      );
      break;
    default:
      wrap.append(
        h('input', {
          type: 'text',
          value: 'pattern' in condition ? (condition.pattern ?? '') : '',
          oninput: (event: Event) => {
            (condition as { pattern: string }).pattern = (event.target as HTMLInputElement).value;
            touch();
          },
        }),
      );
  }
  return wrap;
}

function renderSwitchProfile(
  container: HTMLElement,
  profile: SwitchProfile,
  actions?: HTMLElement,
): void {
  const wrap = h('div');

  const touch = () => {
    Profiles.updateRevision(profile);
    markDirty();
  };

  // The original migrated TrueCondition rules to a `*` host wildcard on sight
  // (updateHasConditionTypes in the coffee controller). Neither condition-type
  // list offers TrueCondition, and the legacy exporter cannot represent it, so
  // the migration is what keeps such rules — creatable through the source
  // editor via 'True: +profile' — editable and exportable. Runs before
  // anything derives state from the rules.
  const migrateTrueConditions = () => {
    let migrated = false;
    for (const rule of profile.rules) {
      if (rule.condition.conditionType === 'TrueCondition') {
        rule.condition = { conditionType: 'HostWildcardCondition', pattern: '*' };
        migrated = true;
      }
    }
    if (migrated) touch();
  };

  // Like the original's sticky hasConditionTypes: once a rule needs the
  // advanced list, it stays for the rest of the visit even if that rule is
  // later deleted.
  let hasAdvancedRules = false;
  const groups = (): Array<[string, ConditionType[]]> => {
    if (Number(options['-showConditionTypes'] ?? 0) > 0) return ADVANCED_CONDITION_TYPES;
    hasAdvancedRules ||= profile.rules.some(
      (rule) => !BASIC_CONDITION_TYPE_SET.has(rule.condition.conditionType),
    );
    if (!hasAdvancedRules) return BASIC_CONDITION_TYPES;
    // The original persisted this fallback (updateHasConditionTypes'
    // write-back) — but only while the option was still unset.
    if (options['-showConditionTypes'] == null) {
      options['-showConditionTypes'] = 1;
      markDirty();
    }
    return ADVANCED_CONDITION_TYPES;
  };

  // --- Attached rule list (gfwlist / AutoProxy import) ----------------------
  // When enabled, the switch's defaultProfileName points at the attached
  // RuleListProfile, whose own defaultProfileName holds the user's real
  // default — same indirection as the original.
  const attachedName = getAttachedName(profile.name);
  const attachedKey = '+' + attachedName;
  const attached = () => options[attachedKey] as RuleListProfile | undefined;
  const attachedEnabled = () => profile.defaultProfileName === attachedName;
  const feedback = h('p', { class: 'om-error' });

  const touchAttached = () => {
    const list = attached();
    if (list) Profiles.updateRevision(list);
    markDirty();
  };

  const effectiveDefault = () =>
    attachedEnabled() && attached() ? attached()!.defaultProfileName : profile.defaultProfileName;
  const setEffectiveDefault = (name: string) => {
    if (attachedEnabled() && attached()) {
      attached()!.defaultProfileName = name;
      touchAttached();
    } else {
      profile.defaultProfileName = name;
      touch();
    }
  };
  const resultNames = () =>
    listProfiles(options, { resultFor: profile.name }).map((other) => other.name);

  const profileSelect = (get: () => string | null, set: (name: string) => void) =>
    h(
      'select',
      {
        onchange: (event: Event) => {
          set((event.target as HTMLSelectElement).value);
          touch();
        },
      },
      ...resultNames().map((name) =>
        h('option', { value: name, text: profileDisplayName(name), selected: get() === name }),
      ),
    );

  const typeSelect = (rule: Rule) =>
    h(
      'select',
      {
        onchange: (event: Event) => {
          rule.condition = conditionOfType(
            (event.target as HTMLSelectElement).value as ConditionType,
            rule.condition,
          );
          touch();
          rerender();
        },
      },
      ...groups().map(([groupKey, types]) => {
        const opts = types.map((type) =>
          h('option', {
            value: type,
            text: t('condition_' + type),
            selected: rule.condition.conditionType === type,
          }),
        );
        const label = t(groupKey);
        // condition_group_default is deliberately empty in the catalogue.
        return label && label !== groupKey
          ? h('optgroup', { label }, ...opts)
          : (opts as unknown as HTMLElement);
      }).flat(),
    );

  // --- Rule list export ------------------------------------------------------

  const advancedInUse = () =>
    Number(options['-showConditionTypes'] ?? 0) > 0 ||
    profile.rules.some((rule) => !BASIC_CONDITION_TYPE_SET.has(rule.condition.conditionType));

  const exportBaseName = () => profile.name.replace(/\W+/g, '_');

  const exportRuleList = () => {
    const eol = '\r\n';
    let info = '\n';
    info += '; Require: SwitchyDelta >= 2.3.2' + eol;
    info += `; Date: ${new Date().toLocaleDateString()}` + eol;
    info += `; Usage: ${t('ruleList_usageUrl')}` + eol;
    // Splice the banner in after the header line (its first "\n").
    const text = RuleList.Switchy.compose({
      rules: profile.rules,
      defaultProfileName: effectiveDefault(),
    }).replace('\n', info);
    downloadFile(`OmegaRules_${exportBaseName()}.sorl`, text, 'text/plain;charset=utf-8');
  };

  const exportLegacyRuleList = () => {
    let wildcardRules = '';
    let regexpRules = '';
    const defaultName = effectiveDefault();
    for (const rule of profile.rules) {
      const mark = rule.profileName === defaultName ? '!' : '';
      switch (rule.condition.conditionType) {
        case 'HostWildcardCondition':
          wildcardRules += mark + '@*://' + rule.condition.pattern + '/*' + '\r\n';
          break;
        case 'UrlWildcardCondition':
          wildcardRules += mark + '@' + rule.condition.pattern + '\r\n';
          break;
        case 'UrlRegexCondition':
          regexpRules += mark + rule.condition.pattern + '\r\n';
          break;
        // Other condition types cannot be represented and are dropped, as in
        // the original exporter.
      }
    }
    const text = [
      '; Summary: Proxy Switchy! Exported Rule List',
      `; Date: ${new Date().toLocaleDateString()}`,
      `; Website: ${t('ruleList_usageUrl')}`,
      '',
      '#BEGIN',
      '',
      '[wildcard]',
      wildcardRules,
      '[regexp]',
      regexpRules,
      '#END',
    ].join('\n');
    downloadFile(`SwitchyRules_${exportBaseName()}.ssrl`, text, 'text/plain;charset=utf-8');
  };

  const exportOmegaButton = h('button', {
    type: 'button',
    class: 'om-btn',
    title: t('options_profileExportRuleListHelp'),
    text: t('options_profileExportRuleList') + ' (.sorl)',
    onclick: exportRuleList,
  });
  const exportLegacyButton = h('button', {
    type: 'button',
    class: 'om-btn',
    title: t('options_exportLegacyRuleList'),
    text: t('options_profileExportRuleList') + ' (.ssrl)',
    onclick: exportLegacyRuleList,
  });
  // The legacy format is offered under the same gate the original used to pick
  // its single export handler: the option is on and every rule fits. Unlike
  // the original, the gate is re-evaluated on every rules re-render — the old
  // controller only re-picked its handler in a watcher on
  // '-showConditionTypes', so a rule edited to an advanced type kept
  // exporting the lossy legacy format until that unrelated option changed.
  const updateExportButtons = () => {
    exportLegacyButton.hidden = !options['-exportLegacyRuleList'] || advancedInUse();
  };
  actions?.append(exportOmegaButton, exportLegacyButton);

  // --- Source editor ---------------------------------------------------------
  // The rules table and a rule-list text form of it, toggled in place. The
  // text carries per-rule results plus the '* +profile' catch-all, so the
  // default profile round-trips too.

  const stateEditorKey = 'web._profileEditor.' + profile.name;
  let editSource = false;
  let sourceTouched = false;

  const sourceError = h('p', { class: 'om-error' });
  const sourceArea = h('textarea', {
    rows: 20,
    spellcheck: false,
    oninput: () => {
      sourceTouched = true;
      // Validated and merged on every edit: without AngularJS's dirty flag on
      // the text itself, eager merging is what keeps the Apply button and the
      // working copy in step with the textarea.
      parseSource();
    },
  });

  /** Translate a rule-list error, keeping the fallback when no catalogue string exists. */
  const ruleListErrorMessage = (reason: string, args: string[], fallback: string): string => {
    const key = 'ruleList_error_' + reason;
    const message = t(key, args);
    return message === key ? fallback : message;
  };

  /**
   * Parse the textarea back into the profile's rules and default. Returns
   * false — leaving the last valid state in place — and shows the error when
   * the text is not an acceptable rule list.
   */
  const parseSource = (): boolean => {
    const code = sourceArea.value.trim();
    const problem = (message: string): false => {
      sourceError.textContent = message;
      return false;
    };
    // '@with result' is required: without it the text carries no result
    // profiles and cannot round-trip back into switch rules.
    const refs = RuleList.Switchy.directReferenceSet?.({ ruleList: code } as RuleListProfile);
    if (!refs) {
      return problem(ruleListErrorMessage('resultNotEnabled', [], 'resultNotEnabled'));
    }
    for (const [key, name] of Object.entries(refs)) {
      if (!Profiles.byKey(key, options)) {
        return problem(ruleListErrorMessage('unknownProfile', [name], name));
      }
    }
    let rules: Rule[];
    try {
      rules = RuleList.Switchy.parseOmega(code, '', '', { strict: true, source: false });
    } catch (err) {
      const failure = err as RuleList.RuleListError;
      return problem(
        failure.reason
          ? ruleListErrorMessage(
              failure.reason,
              [String(failure.sourceLineNo ?? ''), failure.source ?? ''],
              failure.message,
            )
          : failure.message || String(err),
      );
    }
    // The final rule is the '* +profile' catch-all carrying the default (the
    // strict parser rejects lists where it is not last).
    const catchAll = rules.pop();
    if (catchAll?.profileName) setEffectiveDefault(catchAll.profileName);
    // The original diff-merged with jsondiffpatch so AngularJS watchers kept
    // their row identities; this renderer rebuilds rows from the array, so a
    // plain replacement is equivalent.
    profile.rules = rules;
    touch();
    // 'True: +profile' lines are legal input but must not survive as
    // TrueCondition rules (see migrateTrueConditions), and the legacy-export
    // gate depends on the rules just replaced.
    migrateTrueConditions();
    updateExportButtons();
    sourceError.textContent = '';
    return true;
  };

  const toggleSource = () => {
    if (editSource) {
      // Parsed even when untouched, as the original did — closing the editor
      // is what commits the text.
      if (!parseSource()) return;
      editSource = false;
    } else {
      sourceArea.value = RuleList.Switchy.compose(
        { rules: profile.rules, defaultProfileName: effectiveDefault() },
        { withResult: true },
      );
      sourceTouched = false;
      sourceError.textContent = '';
      editSource = true;
    }
    void setState({ [stateEditorKey]: { editSource } });
    rerender();
  };

  // Where the attached rule list's parse error is shown, above its textarea
  // (the original template's attachedRuleListError block).
  const attachedListError = h('p', { class: 'om-error' });
  let attachedListTextarea: HTMLTextAreaElement | null = null;

  /**
   * The attached-list branch of the original's `omegaApplyOptions` handler: a
   * manually maintained attached list must either not look like a Switchy
   * list at all (it may legitimately be AutoProxy) or parse as one, and on a
   * successful detection the stored format is corrected to 'Switchy' so the
   * right parser handles it from then on. Returns whether Apply may proceed.
   */
  const checkAttachedRuleList = (): boolean => {
    const list = attached();
    attachedListError.textContent = '';
    if (!list?.ruleList || list.sourceUrl) return true;
    const code = list.ruleList.trim();
    const problem = (message: string): false => {
      attachedListError.textContent = message;
      attachedListTextarea?.focus();
      return false;
    };
    // Not recognizably Switchy — tolerated, the chosen format stands
    // ('notSwitchy' in the original).
    if (!RuleList.Switchy.detect?.(code)) return true;
    // A missing '@with result' is tolerated too ('resultNotEnabled'):
    // attached lists carry no result profiles of their own.
    const refs = RuleList.Switchy.directReferenceSet?.({ ruleList: code } as RuleListProfile);
    for (const [key, name] of Object.entries(refs ?? {})) {
      if (!Profiles.byKey(key, options)) {
        return problem(ruleListErrorMessage('unknownProfile', [name], name));
      }
    }
    try {
      RuleList.Switchy.parseOmega(code, '', '', { strict: true, source: false });
    } catch (err) {
      const failure = err as RuleList.RuleListError;
      return problem(
        failure.reason
          ? ruleListErrorMessage(
              failure.reason,
              [String(failure.sourceLineNo ?? ''), failure.source ?? ''],
              failure.message,
            )
          : failure.message || String(err),
      );
    }
    if (list.format !== 'Switchy') {
      list.format = 'Switchy';
      touchAttached();
      rerender();
    }
    return true;
  };

  // The original intercepted its `omegaApplyOptions` event to validate the
  // attached rule list and parse a touched source before anything was saved;
  // capturing the Apply click has the same effect. The listener unhooks
  // itself once this editor leaves the page.
  const applyGuard = (event: Event) => {
    if (!wrap.isConnected) {
      document.removeEventListener('click', applyGuard, true);
      return;
    }
    if (!(event.target as Element | null)?.closest?.('#om-apply')) return;
    let ok = checkAttachedRuleList();
    if (editSource && sourceTouched) {
      if (parseSource()) sourceTouched = false;
      else ok = false;
    }
    if (!ok) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  document.addEventListener('click', applyGuard, true);

  // Touched, unparseable source text blocks route changes instead of being
  // silently discarded — the original's `$stateChangeStart` guard. The router
  // clears this when another view renders.
  setNavigationGuard(() => {
    if (!editSource || !sourceTouched) return true;
    return parseSource();
  });

  const rulesHead = () =>
    h(
      'h3',
      {},
      h('span', { text: t('options_group_switchRules') }),
      ' ',
      h('button', {
        type: 'button',
        class: editSource ? 'om-btn om-btn-primary' : 'om-btn',
        text: t('options_profileEditSource'),
        onclick: toggleSource,
      }),
      editSource && ' ',
      editSource &&
        h('a', {
          class: 'om-mini',
          style: { textDecoration: 'none' },
          href: t('options_profileEditSourceHelpUrl'),
          target: '_blank',
          title: t('options_profileEditSourceHelp'),
          text: '?',
        }),
    );

  const rerender = () => {
    migrateTrueConditions();
    updateExportButtons();
    if (editSource) {
      render(wrap, [rulesHead(), sourceError, sourceArea, feedback, ...ruleListSections()]);
      return;
    }
    render(wrap, [
      rulesHead(),
      ...profile.rules.map((rule, index) =>
        h(
          'div',
          { class: 'om-rule' },
          h(
            'div',
            { class: 'om-rule-condition' },
            typeSelect(rule),
            conditionDetails(rule.condition, touch),
          ),
          h(
            'div',
            { class: 'om-rule-result' },
            profileSelect(
              () => rule.profileName,
              (name) => (rule.profileName = name),
            ),
            h(
              'span',
              { class: 'om-cycle-buttons' },
              index > 0 &&
                h('button', {
                  type: 'button',
                  class: 'om-mini',
                  title: t('options_sort'),
                  text: '↑',
                  onclick: () => {
                    const rules = profile.rules;
                    [rules[index - 1], rules[index]] = [rules[index]!, rules[index - 1]!];
                    touch();
                    rerender();
                  },
                }),
              index < profile.rules.length - 1 &&
                h('button', {
                  type: 'button',
                  class: 'om-mini',
                  title: t('options_sort'),
                  text: '↓',
                  onclick: () => {
                    const rules = profile.rules;
                    [rules[index], rules[index + 1]] = [rules[index + 1]!, rules[index]!];
                    touch();
                    rerender();
                  },
                }),
              h('button', {
                type: 'button',
                class: 'om-mini',
                title: t('options_cloneRule'),
                text: '⧉',
                onclick: () => {
                  profile.rules.splice(index + 1, 0, structuredClone(rule));
                  touch();
                  rerender();
                },
              }),
              h('button', {
                type: 'button',
                class: 'om-mini',
                title: t('options_deleteRule'),
                text: '✕',
                onclick: (event: Event) => {
                  const button = event.currentTarget as HTMLButtonElement;
                  // Two-step delete when -confirmDeletion is on (the
                  // default), standing in for the original's confirmation
                  // modal: the first click arms the button, a second within
                  // five seconds deletes.
                  if (options['-confirmDeletion'] !== false && button.dataset['armed'] !== '1') {
                    button.dataset['armed'] = '1';
                    button.classList.add('om-btn-danger');
                    button.textContent = t('options_deleteRule');
                    button.title = t('options_deleteRuleConfirm');
                    setTimeout(() => {
                      if (!button.isConnected || button.dataset['armed'] !== '1') return;
                      delete button.dataset['armed'];
                      button.classList.remove('om-btn-danger');
                      button.textContent = '✕';
                      button.title = t('options_deleteRule');
                    }, 5000);
                    return;
                  }
                  profile.rules.splice(index, 1);
                  touch();
                  rerender();
                },
              }),
            ),
          ),
        ),
      ),
      h('button', {
        type: 'button',
        class: 'om-btn',
        text: t('options_addCondition'),
        onclick: () => {
          // Like the original: clone the last rule with a cleared pattern so
          // consecutive rules keep the same type and target. The fallback for
          // an empty list targets the effective default — with an attached
          // list enabled, profile.defaultProfileName is the hidden
          // '__ruleListOf_*' profile, which the result picker cannot show.
          const last = profile.rules[profile.rules.length - 1];
          const rule: Rule = last
            ? structuredClone(last)
            : {
                condition: { conditionType: 'HostWildcardCondition', pattern: '' },
                profileName: effectiveDefault(),
              };
          if ('pattern' in rule.condition) rule.condition.pattern = '';
          profile.rules.push(rule);
          touch();
          rerender();
        },
      }),
      attachedRow(),
      h(
        'div',
        { class: 'om-rule om-rule-default' },
        h('span', { text: t('options_switchDefaultProfile') }),
        profileSelect(effectiveDefault, setEffectiveDefault),
      ),
      feedback,
      ...ruleListSections(),
    ]);
  };

  // The attached rule list as a pseudo-rule between the rules and the default.
  function attachedRow(): HTMLElement | false {
    const list = attached();
    if (!list) return false;
    const enabled = attachedEnabled();

    const box = h('input', {
      type: 'checkbox',
      checked: enabled,
      onchange: () => {
        profile.defaultProfileName = box.checked ? attachedName : list.defaultProfileName;
        touch();
        rerender();
      },
    });

    return h(
      'div',
      { class: 'om-rule om-rule-attached' },
      h(
        'label',
        { class: 'om-check' },
        box,
        h('span', {}, h('span', { text: t('options_switchAttachedProfileInCondition') })),
      ),
      h('p', {
        class: 'om-help',
        text: t(
          enabled
            ? 'options_switchAttachedProfileInConditionDetails'
            : 'options_switchAttachedProfileInConditionDisabled',
        ),
      }),
      h(
        'div',
        { class: 'om-rule-result' },
        (() => {
          const select = profileSelect(
            () => list.matchProfileName,
            (name) => {
              list.matchProfileName = name;
              touchAttached();
            },
          );
          select.disabled = !enabled;
          return select;
        })(),
        h('button', {
          type: 'button',
          class: 'om-mini',
          title: t('options_deleteAttached'),
          text: '✕',
          onclick: removeAttached,
        }),
      ),
    );
  }

  function removeAttached(): void {
    const list = attached();
    if (!list) return;
    if (isDirty()) {
      feedback.textContent = t('options_applyOptionsRequired');
      return;
    }
    if (options['-confirmDeletion'] !== false && feedback.textContent !== t('options_deleteAttachedConfirm')) {
      feedback.textContent = t('options_deleteAttachedConfirm');
      setTimeout(() => {
        if (feedback.textContent === t('options_deleteAttachedConfirm')) feedback.textContent = '';
      }, 5000);
      return;
    }
    // Point the switch back at the real default, save it, then drop the
    // attached profile through patch's removal delta (undefined would be
    // lost in message serialization).
    profile.defaultProfileName = list.defaultProfileName;
    void callBackground('applyChanges', { ['+' + profile.name]: profile })
      .then(() => api.patch({ [attachedKey]: [list, 0, 0] }))
      .then(
        () => location.reload(),
        (err: unknown) => {
          feedback.textContent = err instanceof Error ? err.message : String(err);
        },
      );
  }

  // The attach button, or the rule list's format/url/text configuration.
  function ruleListSections(): Array<HTMLElement | false> {
    const list = attached();
    if (!list) {
      attachedListTextarea = null;
      return [
        h('h3', { text: t('options_group_attachProfile') }),
        help('options_attachProfileHelp'),
        h('button', {
          type: 'button',
          class: 'om-btn',
          text: t('options_attachProfile'),
          onclick: () => {
            const created = Profiles.create({
              name: attachedName,
              profileType: 'RuleListProfile',
              color: profile.color,
              defaultProfileName: profile.defaultProfileName,
            } as Profile) as RuleListProfile;
            Profiles.updateRevision(created);
            options[attachedKey] = created;
            profile.defaultProfileName = attachedName;
            touch();
            rerender();
          },
        }),
      ];
    }

    const text = h('textarea', {
      value: list.ruleList ?? '',
      disabled: !!list.sourceUrl,
      oninput: () => {
        list.ruleList = text.value;
        touchAttached();
      },
    });
    attachedListTextarea = text;

    // Last-update line, refreshed in place so URL edits and downloads do not
    // need a full re-render (which would swallow the click that caused them).
    const status = h('div');
    const renderStatus = () => {
      const current = attached();
      const lastUpdate = (current as { lastUpdate?: string | number } | undefined)?.lastUpdate;
      render(status, [
        !!current?.sourceUrl &&
          (lastUpdate
            ? h('p', {
                class: 'om-help',
                text: t('options_ruleListLastUpdate', [new Date(lastUpdate).toLocaleString()]),
              })
            : h('p', { class: 'om-error', text: t('options_ruleListObsolete') })),
      ]);
    };
    renderStatus();

    const downloadButton = h('button', {
      type: 'button',
      class: 'om-btn',
      text: t('options_downloadProfileNow'),
      disabled: !list.sourceUrl,
      onclick: () => void download(),
    });

    // Pending edits are applied automatically: a freshly pasted URL should
    // download on the first click, not demand a manual Apply first.
    const download = async () => {
      feedback.textContent = '';
      downloadButton.disabled = true;
      const spinner = h('span', { class: 'om-spinner', 'aria-hidden': 'true' });
      downloadButton.append(spinner);
      try {
        if (isDirty()) await applyChanges();
        // The original passed 'bypass_cache' so a manual download refetches
        // even when the HTTP cache still holds a fresh-enough copy.
        const result = await api.updateProfile(attachedName, true);
        const failed = Object.values(result ?? {}).find(
          (value) => (value as { _error?: string } | null)?._error,
        );
        if (failed) {
          throw new Error((failed as { message?: string }).message ?? 'Download failed');
        }
        // Pull the downloaded list back in without dirtying the page.
        adoptOptionsKey(attachedKey, (await api.getAll())[attachedKey]);
        const fresh = attached();
        text.value = fresh?.ruleList ?? '';
        renderStatus();
      } catch (err) {
        feedback.textContent = err instanceof Error ? err.message : String(err);
      } finally {
        spinner.remove();
        downloadButton.disabled = !attached()?.sourceUrl;
      }
    };

    const urlInput = h('input', {
      type: 'url',
      value: list.sourceUrl ?? '',
      placeholder: 'https://',
      onchange: () => {
        list.sourceUrl = urlInput.value.trim();
        // A different source invalidates the downloaded copy.
        delete (list as { lastUpdate?: unknown }).lastUpdate;
        touchAttached();
        downloadButton.disabled = !list.sourceUrl;
        text.disabled = !!list.sourceUrl;
        renderStatus();
      },
    });

    return [
      h('h3', { text: t('options_group_ruleListConfig') }),
      h(
        'div',
        { class: 'om-radio-row' },
        h('span', { class: 'om-between', text: t('options_ruleListFormat') }),
        ...Profiles.ruleListFormats.map((format) => {
          const radio = h('input', {
            type: 'radio',
            name: 'om-rule-list-format',
            checked: list.format === format,
            onchange: () => {
              list.format = format;
              touchAttached();
            },
          });
          return h(
            'label',
            { class: 'om-day' },
            radio,
            h('span', { text: t('ruleListFormat_' + format) }),
          );
        }),
      ),
      field('options_group_ruleListUrl', urlInput),
      help('options_ruleListUrlHelp'),
      downloadButton,

      h('h3', { text: t('options_group_ruleListText') }),
      status,
      attachedListError,
      text,
    ];
  }

  rerender();
  container.append(wrap);

  // Reopen the source editor when that is how this profile was left last
  // time. Otherwise offer the one-shot rule-table walkthrough, where the old
  // editor controller `$script`-loaded `switch_profile_guide.js` after its
  // rules rendered — the walkthrough only makes sense over the table.
  void getState(stateEditorKey).then((state) => {
    const stored = state[stateEditorKey] as { editSource?: boolean } | undefined;
    if (stored?.editSource) {
      if (!editSource) toggleSource();
    } else {
      void maybeShowSwitchProfileGuide(profile);
    }
  });
}

/** Why `name` cannot be used as a (new) profile name, or null if it can. */
function profileNameProblem(name: string, allowCurrent?: string): string | null {
  if (!name) return t('options_profileNameEmpty');
  if (name.startsWith('__')) return t('options_profileNameReserved');
  if (name !== allowCurrent && Profiles.byName(name, options)) {
    return t('options_profileNameConflict');
  }
  return null;
}

/** Whether other profiles or options still point at `name`. */
function profileReferencedBy(name: string): boolean {
  let referenced = options['-startupProfileName'] === name;
  Profiles.each(options, (_key, other) => {
    const record = other as Profile & {
      defaultProfileName?: string;
      rules?: Array<{ profileName?: string }>;
    };
    if (record.defaultProfileName === name) referenced = true;
    for (const rule of record.rules ?? []) {
      if (rule.profileName === name) referenced = true;
    }
  });
  return referenced;
}

/**
 * Types offered by the new-profile screen. Bare RuleListProfile is deliberately
 * absent — creating one was disallowed in favour of a SwitchProfile with an
 * attached list (commit 6d679e9), and that rule stands. VirtualProfile is also
 * held back until its editor is ported: renderProfile has no VirtualProfile
 * branch and nothing else in this UI can change a virtual profile's target, so
 * creating one here would produce a profile stuck pointing at `direct` forever.
 */
const NEW_PROFILE_TYPES = ['FixedProfile', 'SwitchProfile', 'PacProfile'] as const;

export function renderNewProfile(container: HTMLElement): void {
  const nameInput = h('input', { type: 'text', placeholder: t('options_newProfileName') });
  const error = h('p', { class: 'om-error' });
  let profileType: (typeof NEW_PROFILE_TYPES)[number] = 'FixedProfile';

  const create = () => {
    if (isDirty()) {
      error.textContent = t('options_applyOptionsRequired');
      return;
    }
    const name = nameInput.value.trim();
    const problem = profileNameProblem(name);
    if (problem) {
      error.textContent = problem;
      return;
    }
    const used = listProfiles(options).length;
    const color = profileColors[used % profileColors.length]!;
    const profile: Profile =
      profileType === 'FixedProfile'
        ? {
            profileType: 'FixedProfile',
            name,
            color,
            fallbackProxy: { scheme: 'http', host: 'example.com', port: 80 },
            bypassList: [
              { pattern: '127.0.0.1', conditionType: 'BypassCondition' },
              { pattern: '::1', conditionType: 'BypassCondition' },
              { pattern: 'localhost', conditionType: 'BypassCondition' },
            ],
          }
        : // The handler fills each type's required fields, as the original's
          // creation flow did: a default DIRECT PAC script, or `direct` as the
          // default profile for Switch.
          Profiles.create({ name, profileType, color } as Profile);
    void api.addProfile(profile).then(
      () => {
        location.hash = '#/profile/' + encodeURIComponent(name);
        location.reload();
      },
      (err: unknown) => {
        error.textContent = err instanceof Error ? err.message : String(err);
      },
    );
  };
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') create();
  });

  const typeChoice = (type: (typeof NEW_PROFILE_TYPES)[number]) => {
    const radio = h('input', {
      type: 'radio',
      name: 'om-new-profile-type',
      checked: profileType === type,
      onchange: () => {
        if (radio.checked) profileType = type;
      },
    });
    return h(
      'label',
      { class: 'om-check' },
      radio,
      h(
        'span',
        {},
        h('span', { text: t('options_profileType' + type) }),
        h('small', { text: ' ' + t('options_profileDesc' + type) }),
        type === 'PacProfile' &&
          h('small', { text: ' ' + t('options_profileDescMorePacProfile') }),
      ),
    );
  };

  container.append(
    h('h2', { text: t('options_modalHeader_newProfile') }),
    field('options_newProfileName', nameInput),
    h('p', { class: 'om-help', text: t('options_profileType') }),
    ...NEW_PROFILE_TYPES.map(typeChoice),
    error,
    h('button', {
      type: 'button',
      class: 'om-btn om-btn-primary',
      text: t('options_createProfile'),
      onclick: create,
    }),
  );
}

/** Chromium can answer HTTP(S) proxy 407 challenges via webRequestAuthProvider. */
const AUTH_SUPPORTED = new Set(['http', 'https']);

// Bitwarden-style: simple eye outline + pupil; slashed when the password is visible.
const svgIcon = (paths: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const eyeShape =
  '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>';
// Password hidden → click to show.
const eyeIcon = svgIcon(eyeShape);
// Password visible → click to hide.
const eyeSlashIcon = svgIcon(`${eyeShape}<line x1="3" y1="3" x2="21" y2="21"/>`);

function renderFixedProfile(container: HTMLElement, profile: FixedProfile): void {
  const proxy: ProxyServer = profile.fallbackProxy ?? { scheme: 'http', host: '', port: 80 };
  profile.fallbackProxy = proxy;

  const touch = () => {
    Profiles.updateRevision(profile);
    markDirty();
  };

  /** Keep `auth.fallbackProxy` in sync with the single proxy this editor owns. */
  const writeAuth = (username: string, password: string) => {
    if (!username) {
      if (profile.auth) {
        delete profile.auth.fallbackProxy;
        if (Object.keys(profile.auth).length === 0) delete profile.auth;
      }
      return;
    }
    profile.auth ??= {};
    profile.auth.fallbackProxy = { username, password };
  };

  const scheme = h(
    'select',
    {
      onchange: (event: Event) => {
        proxy.scheme = (event.target as HTMLSelectElement).value;
        if (!port.value) proxy.port = DEFAULT_PORTS[proxy.scheme] ?? 80;
        // Drop credentials when the protocol cannot carry them.
        if (!AUTH_SUPPORTED.has(proxy.scheme)) {
          writeAuth('', '');
          username.value = '';
          password.value = '';
          password.disabled = true;
          authWarning.hidden = false;
          authWarning.innerHTML = t('options_proxy_authNotSupported', [
            proxy.scheme.toUpperCase(),
          ]);
        } else {
          authWarning.hidden = true;
          password.disabled = !username.value;
        }
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

  const existing = profile.auth?.fallbackProxy;
  const username = h('input', {
    type: 'text',
    value: existing?.username ?? '',
    autocomplete: 'username',
    placeholder: t('options_proxyAuthUsername'),
    oninput: (event: Event) => {
      const value = (event.target as HTMLInputElement).value;
      password.disabled = !value;
      if (!value) {
        password.value = '';
        password.placeholder = t('options_proxyAuthNone');
      } else {
        password.placeholder = t('options_proxyAuthPassword');
      }
      writeAuth(value, password.value);
      touch();
    },
  });

  const password = h('input', {
    type: 'password',
    value: existing?.password ?? '',
    autocomplete: 'current-password',
    placeholder: t(existing?.username ? 'options_proxyAuthPassword' : 'options_proxyAuthNone'),
    disabled: !existing?.username,
    oninput: (event: Event) => {
      writeAuth(username.value, (event.target as HTMLInputElement).value);
      touch();
    },
  });

  const setPasswordVisible = (visible: boolean) => {
    password.type = visible ? 'text' : 'password';
    const label = t(visible ? 'options_proxyAuthHidePassword' : 'options_proxyAuthShowPassword');
    showPassword.title = label;
    showPassword.setAttribute('aria-label', label);
    showPassword.setAttribute('aria-pressed', visible ? 'true' : 'false');
    showPassword.innerHTML = visible ? eyeSlashIcon : eyeIcon;
  };

  const showPassword = h('button', {
    type: 'button',
    class: 'om-password-toggle',
    title: t('options_proxyAuthShowPassword'),
    'aria-label': t('options_proxyAuthShowPassword'),
    'aria-pressed': 'false',
    onclick: () => setPasswordVisible(password.type === 'password'),
  });
  showPassword.innerHTML = eyeIcon;

  const authWarning = h('p', {
    class: 'om-help om-auth-warning',
    html: t('options_proxy_authNotSupported', [proxy.scheme.toUpperCase()]),
    hidden: AUTH_SUPPORTED.has(proxy.scheme),
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
    h(
      'div',
      { class: 'om-proxy-row' },
      field('options_proxy_protocol', scheme),
      field('options_proxy_server', host),
      field('options_proxy_port', port),
    ),
    h(
      'div',
      { class: 'om-auth-row' },
      field('options_proxyAuthUsername', username),
      h(
        'label',
        { class: 'om-field' },
        h('span', { text: t('options_proxyAuthPassword') }),
        h('div', { class: 'om-auth-password' }, password, showPassword),
      ),
    ),
    authWarning,
    field('options_group_bypassList', bypass),
  );
}

// --- PAC profile editor -----------------------------------------------------

/**
 * URL shape accepted for the PAC source, from AngularJS's `input[url]`
 * validator, which the original bound via `ng-pattern`. The second form adds
 * the `file:` scheme, allowed only while nothing references this profile.
 */
const PAC_URL_PATTERN =
  /^(ftp|http|https):\/\/(\w+:{0,1}\w*@)?(\S+)(:[0-9]+)?(\/|\/([\w#!:.?+=&%@!\-/]))?$/;
const PAC_URL_WITH_FILE_PATTERN =
  /^(ftp|http|https|file):\/\/(\w+:{0,1}\w*@)?(\S+)(:[0-9]+)?(\/|\/([\w#!:.?+=&%@!\-/]))?$/;

/** `lastUpdate` is bookkeeping the background writes; it is not in the type. */
type Downloadable = { lastUpdate?: string | number | null };

function renderPacProfile(container: HTMLElement, profile: PacProfile): void {
  const profileKey = '+' + profile.name;
  const current = () => (options[profileKey] as PacProfile | undefined) ?? profile;

  const touch = () => {
    Profiles.updateRevision(profile);
    markDirty();
  };

  // File-URL PAC profiles cannot be a switch result (the browser cannot fetch
  // local files for splicing), so a referenced profile refuses file: URLs.
  const referenced = Object.keys(Profiles.referencedBySet(profile, options)).length > 0;
  const urlPattern = referenced ? PAC_URL_PATTERN : PAC_URL_WITH_FILE_PATTERN;

  const feedback = h('p', { class: 'om-error' });

  // Reverting the URL to its previous value restores the script downloaded
  // from it instead of forcing a redownload — same stash the original kept in
  // its `$watch('profile', ...)` callback.
  let oldPacUrl: string | undefined;
  let oldLastUpdate: Downloadable['lastUpdate'];
  let oldPacScript: string | undefined;

  const setPacUrl = (url: string) => {
    if (url === (profile.pacUrl ?? '')) return;
    const stamped = profile as PacProfile & Downloadable;
    if (stamped.lastUpdate) {
      oldPacUrl = profile.pacUrl;
      oldLastUpdate = stamped.lastUpdate;
      oldPacScript = profile.pacScript;
      // A different source invalidates the downloaded copy. (The original
      // assigned null; removal is what the rule-list editor above does.)
      delete stamped.lastUpdate;
    } else if (oldPacUrl && url === oldPacUrl) {
      stamped.lastUpdate = oldLastUpdate;
      profile.pacScript = oldPacScript;
      script.value = profile.pacScript ?? '';
    }
    profile.pacUrl = url;
    touch();
  };

  // --- PAC URL ---------------------------------------------------------------

  const urlInput = h('input', {
    type: 'url',
    value: profile.pacUrl ?? '',
    placeholder: 'https://',
    oninput: () => {
      const value = urlInput.value.trim();
      const valid = !value || urlPattern.test(value);
      urlInput.classList.toggle('om-invalid', !valid);
      // Like ng-pattern: an invalid view value never reaches the model.
      if (valid) setPacUrl(value);
      syncUi();
    },
  });
  // ng-pattern also judged the stored value on load (e.g. a file: URL on a
  // profile that has since become referenced).
  urlInput.classList.toggle(
    'om-invalid',
    !!urlInput.value.trim() && !urlPattern.test(urlInput.value.trim()),
  );

  const fileWarning = h(
    'div',
    {},
    h('p', { class: 'om-help', text: t('options_pacUrlFile') }),
  );
  const fileError = h(
    'div',
    {},
    h('p', { class: 'om-error', text: t('options_pacUrlFile') }),
    h('p', { class: 'om-error', text: t('options_pacUrlFileDisabled') }),
  );

  // --- Download (same shape as the rule-list section's download-now) ---------

  const downloadButton = h('button', {
    type: 'button',
    class: 'om-btn',
    text: t('options_downloadProfileNow'),
    onclick: () => void download(),
  });

  // Pending edits are applied automatically: a freshly pasted URL should
  // download on the first click, not demand a manual Apply first.
  const download = async () => {
    feedback.textContent = '';
    downloadButton.disabled = true;
    const spinner = h('span', { class: 'om-spinner', 'aria-hidden': 'true' });
    downloadButton.append(spinner);
    try {
      if (isDirty()) await applyChanges();
      // The original passed 'bypass_cache' so a manual download refetches
      // even when the HTTP cache still holds a fresh-enough copy.
      const result = await api.updateProfile(profile.name, true);
      const failed = Object.values(result ?? {}).find(
        (value) => (value as { _error?: string } | null)?._error,
      );
      if (failed) {
        throw new Error((failed as { message?: string }).message ?? 'Download failed');
      }
      // Pull the downloaded script back in without dirtying the page, then
      // re-attach the object this editor mutates so later edits still land
      // in the working copy.
      adoptOptionsKey(profileKey, (await api.getAll())[profileKey]);
      const fresh = current();
      profile.pacScript = fresh.pacScript;
      profile.revision = fresh.revision;
      (profile as PacProfile & Downloadable).lastUpdate = (
        fresh as PacProfile & Downloadable
      ).lastUpdate;
      options[profileKey] = profile;
      script.value = profile.pacScript ?? '';
    } catch (err) {
      feedback.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      spinner.remove();
      downloadButton.disabled = false;
      syncUi();
    }
  };

  // --- Proxy auth for the PAC's own `all` scope ------------------------------
  // The original opened the fixed-profile auth modal for `auth['all']`; the
  // same inline row the fixed editor uses does that job here.

  const authProp = 'all';
  const writeAuth = (username: string, password: string) => {
    if (!username) {
      // The original left `auth[all] = undefined` behind; dropping the empty
      // objects keeps the stored profile clean, as the fixed editor does.
      if (profile.auth) {
        delete profile.auth[authProp];
        if (Object.keys(profile.auth).length === 0) delete profile.auth;
      }
      return;
    }
    profile.auth ??= {};
    profile.auth[authProp] = { username, password };
  };

  const existing = profile.auth?.[authProp];
  const username = h('input', {
    type: 'text',
    value: existing?.username ?? '',
    autocomplete: 'username',
    placeholder: t('options_proxyAuthUsername'),
    oninput: (event: Event) => {
      const value = (event.target as HTMLInputElement).value;
      password.disabled = !value;
      if (!value) {
        password.value = '';
        password.placeholder = t('options_proxyAuthNone');
      } else {
        password.placeholder = t('options_proxyAuthPassword');
      }
      writeAuth(value, password.value);
      touch();
      syncUi();
    },
  });

  const password = h('input', {
    type: 'password',
    value: existing?.password ?? '',
    autocomplete: 'current-password',
    placeholder: t(existing?.username ? 'options_proxyAuthPassword' : 'options_proxyAuthNone'),
    disabled: !existing?.username,
    oninput: (event: Event) => {
      writeAuth(username.value, (event.target as HTMLInputElement).value);
      touch();
    },
  });

  const setPasswordVisible = (visible: boolean) => {
    password.type = visible ? 'text' : 'password';
    const label = t(visible ? 'options_proxyAuthHidePassword' : 'options_proxyAuthShowPassword');
    showPassword.title = label;
    showPassword.setAttribute('aria-label', label);
    showPassword.setAttribute('aria-pressed', visible ? 'true' : 'false');
    showPassword.innerHTML = visible ? eyeSlashIcon : eyeIcon;
  };

  const showPassword = h('button', {
    type: 'button',
    class: 'om-password-toggle',
    title: t('options_proxyAuthShowPassword'),
    'aria-label': t('options_proxyAuthShowPassword'),
    'aria-pressed': 'false',
    onclick: () => setPasswordVisible(password.type === 'password'),
  });
  showPassword.innerHTML = eyeIcon;

  // Credentials for `all` go to whatever server the script names, so the
  // original showed a standing warning while any are set.
  const authWarnings = h('div');
  const renderAuthWarnings = () => {
    render(
      authWarnings,
      profile.auth?.[authProp]
        ? [
            h('p', {
              class: 'om-help om-auth-warning',
              text: t('options_proxy_authAllWarningPac'),
            }),
            h('p', {
              class: 'om-help om-auth-warning',
              text: t(
                profile.pacUrl
                  ? 'options_proxy_authAllWarningPacUrl'
                  : 'options_proxy_authAllWarningPacScript',
              ),
            }),
            referenced &&
              h('p', {
                class: 'om-help om-auth-warning',
                text: t('options_proxy_authReferencedWarning'),
              }),
          ]
        : [],
    );
  };

  // --- PAC script ------------------------------------------------------------

  const script = h('textarea', {
    value: profile.pacScript ?? '',
    oninput: () => {
      profile.pacScript = script.value;
      touch();
    },
  });

  // Last-update line, refreshed in place like the rule-list section's.
  const status = h('div');
  const renderStatus = () => {
    const lastUpdate = (current() as PacProfile & Downloadable).lastUpdate;
    render(status, [
      !!current().pacUrl &&
        (lastUpdate
          ? h('p', {
              class: 'om-help',
              text: t('options_pacScriptLastUpdate', [new Date(lastUpdate).toLocaleString()]),
            })
          : h('p', { class: 'om-error', text: t('options_pacScriptObsolete') })),
    ]);
  };

  const scriptSection = h('div', {}, status, script);

  /** Refresh everything derived from the URL's value and validity. */
  const syncUi = () => {
    const isFile = Profiles.isFileUrl(profile.pacUrl);
    const viewIsFile = Profiles.isFileUrl(urlInput.value.trim());
    const invalid = urlInput.classList.contains('om-invalid');
    fileWarning.hidden = !(isFile && !referenced);
    fileError.hidden = !(viewIsFile && referenced);
    downloadButton.hidden = !profile.pacUrl || isFile;
    downloadButton.classList.toggle(
      'om-btn-primary',
      !!profile.pacUrl && !(profile as PacProfile & Downloadable).lastUpdate,
    );
    // The script cannot be edited while it mirrors a URL, and a file: URL
    // needs no script at all.
    scriptSection.hidden = isFile;
    script.disabled = invalid || !!profile.pacUrl;
    renderStatus();
    renderAuthWarnings();
  };
  syncUi();

  container.append(
    h('h3', { text: t('options_group_pacUrl') }),
    h('label', { class: 'om-field' }, urlInput),
    help('options_pacUrlHelp'),
    fileWarning,
    fileError,
    downloadButton,
    feedback,

    h('h3', { text: t('options_group_pacScript') }),
    h(
      'div',
      { class: 'om-auth-row' },
      field('options_proxyAuthUsername', username),
      h(
        'label',
        { class: 'om-field' },
        h('span', { text: t('options_proxyAuthPassword') }),
        h('div', { class: 'om-auth-password' }, password, showPassword),
      ),
    ),
    authWarnings,
    scriptSection,
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
