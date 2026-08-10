/**
 * Screen renderers for the options page.
 *
 * Each takes the container to fill. Controls carrying `data-option` are bound
 * to the working copy by the shell; anything more involved wires its own
 * listeners.
 */

import { append, downloadFile, h, must, render } from '../lib/dom.js';
import { profileDisplayName, t } from '../lib/i18n.js';
import { api, callBackground, getState } from '../lib/messaging.js';
import { colorFor, getAttachedName, listProfiles, profileColors } from '../lib/profile-view.js';
import { adoptOptionsKey, applyChanges, isDirty, markDirty, options } from './main.js';
import {
  Conditions,
  parseIp,
  Profiles,
  type Condition,
  type ConditionType,
  type FixedProfile,
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

  container.append(
    h(
      'div',
      { class: 'om-profile-head' },
      h('span', { class: 'om-swatch', style: { background: colorFor(profile, options) } }),
      h('h2', { text: profile.name }),
    ),
    h('p', { class: 'om-help', text: typeName }),
    h(
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
    ),
    renameRow,
    deleteRow,
    feedback,
  );

  if (profile.profileType === 'FixedProfile') {
    renderFixedProfile(container, profile as FixedProfile);
  } else if (profile.profileType === 'SwitchProfile') {
    renderSwitchProfile(container, profile as SwitchProfile);
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

function renderSwitchProfile(container: HTMLElement, profile: SwitchProfile): void {
  const wrap = h('div');
  const groups =
    Number(options['-showConditionTypes'] ?? 0) > 0
      ? ADVANCED_CONDITION_TYPES
      : BASIC_CONDITION_TYPES;

  const touch = () => {
    Profiles.updateRevision(profile);
    markDirty();
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
      ...groups.map(([groupKey, types]) => {
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

  const rerender = () => {
    render(wrap, [
      h('h3', { text: t('options_group_switchRules') }),
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
                onclick: () => {
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
          // consecutive rules keep the same type and target.
          const last = profile.rules[profile.rules.length - 1];
          const rule: Rule = last
            ? structuredClone(last)
            : {
                condition: { conditionType: 'HostWildcardCondition', pattern: '' },
                profileName: profile.defaultProfileName,
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
        const result = await api.updateProfile(attachedName);
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
      text,
    ];
  }

  rerender();
  container.append(wrap);
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

export function renderNewProfile(container: HTMLElement): void {
  const nameInput = h('input', { type: 'text', placeholder: t('options_newProfileName') });
  const error = h('p', { class: 'om-error' });

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
    const profile: FixedProfile = {
      profileType: 'FixedProfile',
      name,
      color: profileColors[used % profileColors.length]!,
      fallbackProxy: { scheme: 'http', host: 'example.com', port: 80 },
      bypassList: [
        { pattern: '127.0.0.1', conditionType: 'BypassCondition' },
        { pattern: '::1', conditionType: 'BypassCondition' },
        { pattern: 'localhost', conditionType: 'BypassCondition' },
      ],
    };
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

  container.append(
    h('h2', { text: t('options_modalHeader_newProfile') }),
    // Only the proxy profile editor is ported, so that is the type created.
    h('p', { class: 'om-help', text: t('options_profileTypeFixedProfile') }),
    field('options_newProfileName', nameInput),
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

  // Bitwarden-style: simple eye outline + pupil; slashed when the password is visible.
  const icon = (paths: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const eyeShape =
    '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>';
  // Password hidden → click to show.
  const eyeIcon = icon(eyeShape);
  // Password visible → click to hide.
  const eyeSlashIcon = icon(`${eyeShape}<line x1="3" y1="3" x2="21" y2="21"/>`);

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
