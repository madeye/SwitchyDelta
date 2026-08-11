/**
 * First-run welcome dialog and the guided walkthrough of the options page.
 *
 * Ports `options_guide.coffee` together with the pieces it was inert without:
 * the first-run gate from `master.coffee` (`showFirstRun`) and the
 * `options_welcome` modal partial, whose AngularJS host controller has no
 * other successor. Shepherd.js + Tether (lazily `$script`-loaded at runtime)
 * are replaced by a small popover stepper — four fixed steps do not need a
 * positioning library, and the welcome modal is a native `<dialog>`.
 *
 * Re-showing is prevented the same way as the original: the background's
 * `firstRun` state key is cleared through the messaging API the moment the
 * welcome dialog appears. The page has no direct storage access and
 * `localStorage` here is per-surface (tab vs side panel), so the state RPC is
 * the only shared memory.
 *
 * Also hosts the port of `switch_profile_guide.coffee`, the rule-table
 * walkthrough for the switch profile editor, on the same stepper rather than
 * a second tour integration. Its trigger (`maybeShowSwitchProfileGuide`) is
 * ported from the `switch_profile.coffee` controller, which lazily
 * `$script`-loaded the guide.
 */

import { h } from '../lib/dom.js';
import { t } from '../lib/i18n.js';
import { getState, setState } from '../lib/messaging.js';
import { listProfiles } from '../lib/profile-view.js';
import { options } from './main.js';
import type { SwitchProfile } from '@switchydelta/pac';

interface GuideStep {
  /** Step id from the original tour, kept for cross-reference. */
  id: string;
  /** Catalogue key for the body; these strings carry trusted inline markup. */
  textKey: string;
  /**
   * The element the step points at, resolved lazily: advancing a step often
   * routes to a new screen whose DOM does not exist yet.
   */
  target: () => HTMLElement | null;
  /**
   * Preferred side, from the original's `attachTo: 'selector right|top|...'`.
   * 'top-right' pins the popover to the viewport corner and ignores the
   * target, like the original's `fixed-top-right` class on a body-attached
   * step.
   */
  placement: 'right' | 'top' | 'bottom' | 'top-right';
  /**
   * Advance when the target link is clicked, like the original's
   * `advanceOn: {selector: '.shepherd-target a', event: 'click'}`.
   */
  advanceOnTargetClick?: boolean;
  /** Offer a secondary button that cancels the tour (`tour.cancel`). */
  skipButton?: boolean;
  /**
   * Bring the target to the viewport edge before showing. Replaces the
   * original's animated `html, body` scroll that parked the target row's
   * bottom at the bottom of the window.
   */
  scrollIntoView?: boolean;
  buttonKey: 'options_guideNext' | 'options_guideDone';
}

/** The four steps of `options_guide.coffee`, against the new UI's anchors. */
function guideSteps(): GuideStep[] {
  const query = (selector: string) => () => document.querySelector<HTMLElement>(selector);
  return [
    {
      id: 'fixed-profile-step',
      textKey: 'options_guide_fixedProfileStep',
      // Was `.nav-profile[data-profile-type="FixedProfile"]`; the sidebar
      // links carry the same data attribute for this purpose.
      target: query('#om-nav-profiles .om-item[data-profile-type="FixedProfile"]'),
      placement: 'right',
      advanceOnTargetClick: true,
      buttonKey: 'options_guideNext',
    },
    {
      id: 'fixed-servers-step',
      textKey: 'options_guide_fixedServersStep',
      // Was `.fixed-servers`: the proxy scheme/host/port editor row.
      target: query('.om-proxy-row'),
      placement: 'top',
      buttonKey: 'options_guideNext',
    },
    {
      id: 'auto-switch-profile-step',
      textKey: 'options_guide_autoSwitchProfileStep',
      target: query('#om-nav-profiles .om-item[data-profile-type="SwitchProfile"]'),
      placement: 'right',
      advanceOnTargetClick: true,
      buttonKey: 'options_guideNext',
    },
    {
      id: 'add-more-profiles-step',
      textKey: 'options_guide_addMoreProfilesStep',
      // Was `.nav-new-profile`.
      target: query('#om-nav-profiles .om-item-new'),
      placement: 'right',
      advanceOnTargetClick: true,
      buttonKey: 'options_guideDone',
    },
  ];
}

/**
 * Show the first-run welcome dialog and offer the walkthrough.
 *
 * Call once after the options page has booted (the original ran this from the
 * first options-change callback, guarded by `showFirstRunOnce`).
 */
export async function maybeShowFirstRunGuide(): Promise<void> {
  const { firstRun } = await getState('firstRun');
  if (!firstRun) return;
  // Cleared immediately — before the user answers — exactly like the
  // original, so neither a reload nor the other surface re-offers the guide.
  void setState({ firstRun: '' });

  // The tour opens the example proxy profile; without one there is nothing to
  // walk through (same early return as the original).
  const fixed = listProfiles(options).find(
    (profile) => profile.profileType === 'FixedProfile',
  );
  if (!fixed) return;

  const choice = await showWelcomeDialog(firstRun === 'upgrade');
  if (choice !== 'show') return;

  // The original ran `$state.go('profile', ...)` before starting the tour so
  // that step two's target (the proxy server editor) exists.
  location.hash = '#/profile/' + encodeURIComponent(fixed.name);
  runTour(guideSteps());
}

/** The steps of `switch_profile_guide.coffee`, against the new anchors. */
function switchGuideSteps(): GuideStep[] {
  const query = (selector: string) => () => document.querySelector<HTMLElement>(selector);
  return [
    {
      id: 'condition-step',
      textKey: 'options_guide_conditionStep',
      // Was `.switch-rule-row`: the first rule row. `.om-rule-default` and
      // `.om-rule-attached` also carry `.om-rule`, but real rules render
      // first and the guide only runs when at least one exists.
      target: query('.om-rule'),
      placement: 'bottom',
      // Only this first step offered Skip (`tour.cancel`) in the original.
      skipButton: true,
      buttonKey: 'options_guideNext',
    },
    // The original's second step (`condition-type-step`) is dropped, not
    // ported: its translated copy ends with "Click on the question mark to
    // open the type reference", pointing at the `.toggle-condition-help` "?"
    // in the old rules-table header that opened `.condition-help-section`
    // (the step hid itself while the panel was open and advanced on
    // `.close-condition-help`). Neither the "?" toggle nor the reference
    // panel exists in this build's rule editor, so the instruction is
    // unsatisfiable, and the copy lives in the shared gettext catalogues
    // where rewording would discard every translation. The remaining intro
    // to conditions is covered by `condition-step` above.
    {
      id: 'condition-profile-step',
      textKey: 'options_guide_conditionProfileStep',
      // Was `.switch-rule-row-target`: the rule's result profile cell.
      target: query('.om-rule .om-rule-result'),
      placement: 'bottom',
      buttonKey: 'options_guideNext',
    },
    {
      id: 'switch-default-step',
      textKey: 'options_guide_switchDefaultStep',
      target: query('.om-rule-default'),
      placement: 'top',
      scrollIntoView: true,
      buttonKey: 'options_guideNext',
    },
    {
      id: 'apply-switch-profile-step',
      // The text points at the toolbar icon / popup menu, so the original
      // attached it to `body top` with the `fixed-top-right` class.
      textKey: 'options_guide_applySwitchProfileStep',
      target: () => null,
      placement: 'top-right',
      buttonKey: 'options_guideDone',
    },
  ];
}

/**
 * Highlight the rule table the first time a SwitchProfile with existing rules
 * is edited.
 *
 * Trigger conditions ported from the `switch_profile.coffee` controller. The
 * old editor also skipped the guide when it reopened directly into
 * source-editing mode; this build's editor has no such mode.
 */
export async function maybeShowSwitchProfileGuide(profile: SwitchProfile): Promise<void> {
  const state = await getState(['web.switchGuide', 'firstRun']);
  if (state['firstRun'] || state['web.switchGuide'] === 'shown') return;
  // Marked shown before the rules check, exactly like the original: opening a
  // rule-less switch profile burns the one-shot offer without showing
  // anything. Deliberately preserved — the popup treated 'showOnFirstUse' as
  // "open this editor instead", so keeping the flag alive until rules exist
  // would turn that redirect into a loop for empty switch profiles.
  void setState({ 'web.switchGuide': 'shown' });
  if (profile.rules.length === 0) return;

  // `jQuery('html, body').scrollTop(0)` — start from the top of the table.
  window.scrollTo(0, 0);
  runTour(switchGuideSteps());
}

/**
 * The welcome modal (`options_welcome.jade`).
 *
 * Resolves 'show' for the primary button; the close cross and the skip
 * button both end the flow, as `$dismiss`/`$close('skip')` did.
 */
function showWelcomeDialog(upgrade: boolean): Promise<'show' | 'skip'> {
  return new Promise((resolve) => {
    const done = (result: 'show' | 'skip') => {
      dialog.close();
      dialog.remove();
      resolve(result);
    };
    const dialog = h(
      'dialog',
      { class: 'om-dialog' },
      h('button', {
        type: 'button',
        class: 'om-dialog-close',
        'aria-label': t('dialog_close'),
        text: '×',
        onclick: () => done('skip'),
      }),
      h('h2', { class: 'om-dialog-title', text: t('options_modalHeader_welcome') }),
      h('p', { text: t(upgrade ? 'options_welcomeUpgrade' : 'options_welcomeNormal') }),
      h('p', { text: t(upgrade ? 'options_welcomeUpgradeGuide' : 'options_welcomeNormalGuide') }),
      h(
        'div',
        { class: 'om-dialog-footer' },
        h('button', {
          type: 'button',
          class: 'om-btn',
          text: t('options_guideSkip'),
          onclick: () => done('skip'),
        }),
        h('button', {
          type: 'button',
          class: 'om-btn om-btn-primary',
          text: t('options_guideNext'),
          onclick: () => done('show'),
        }),
      ),
    );
    // The original opened with `keyboard: false` and a static backdrop:
    // Escape and outside clicks do not dismiss.
    dialog.addEventListener('cancel', (event) => event.preventDefault());
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** How many frames to wait for a step's target to be routed into the DOM. */
const TARGET_RETRY_FRAMES = 20;

/** Cancel handle for the tour currently on screen (`Shepherd.activeTour`). */
let cancelActiveTour: (() => void) | null = null;

/** Run the step popovers. Only steps marked `scrollIntoView` scroll. */
function runTour(steps: GuideStep[]): void {
  // `Shepherd.activeTour?.cancel()` — the switch guide starting while the
  // first-run tour is on its switch-profile step replaces that tour, exactly
  // as the original's shared Shepherd singleton did.
  cancelActiveTour?.();

  let index = -1;
  let popover: HTMLElement | null = null;
  let target: HTMLElement | null = null;
  let advanceHandler: (() => void) | null = null;

  const reposition = () => {
    if (!popover) return;
    const margin = 8;
    const gap = 12;
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    let left: number;
    let top: number;
    const step = steps[index]!;

    if (step.placement === 'top-right') {
      left = window.innerWidth - width - margin;
      top = margin;
    } else if (!target || !target.isConnected) {
      // FIX: with a missing target the original threw from Shepherd's
      // getAttachTo and the tour silently died — reachable by pressing Next
      // on step one instead of opening the profile, because `.fixed-servers`
      // only exists on the profile screen. Show the step centred instead so
      // its instructions still get the user unstuck.
      left = (window.innerWidth - width) / 2;
      top = (window.innerHeight - height) / 2;
    } else {
      const rect = target.getBoundingClientRect();
      if (step.placement === 'right' && rect.right + gap + width <= window.innerWidth - margin) {
        left = rect.right + gap;
        top = rect.top + rect.height / 2 - height / 2;
      } else if (step.placement === 'top' && rect.top - gap - height >= margin) {
        left = rect.left + rect.width / 2 - width / 2;
        top = rect.top - gap - height;
      } else if (
        step.placement === 'bottom' &&
        rect.bottom + gap + height <= window.innerHeight - margin
      ) {
        left = rect.left + rect.width / 2 - width / 2;
        top = rect.bottom + gap;
      } else {
        // No room on the preferred side (the side panel's sidebar is a
        // horizontal strip, so `right` rarely fits there): drop below.
        left = rect.left;
        top = rect.bottom + gap;
      }
    }

    popover.style.left =
      Math.max(margin, Math.min(left, window.innerWidth - width - margin)) + 'px';
    popover.style.top =
      Math.max(margin, Math.min(top, window.innerHeight - height - margin)) + 'px';
  };

  const cleanup = () => {
    popover?.remove();
    popover = null;
    if (target && advanceHandler) target.removeEventListener('click', advanceHandler);
    target?.classList.remove('om-guide-target');
    target = null;
    advanceHandler = null;
  };

  const finish = () => {
    cleanup();
    window.removeEventListener('resize', reposition);
    document.removeEventListener('scroll', reposition, true);
    if (cancelActiveTour === finish) cancelActiveTour = null;
  };
  cancelActiveTour = finish;

  const next = () => {
    cleanup();
    index += 1;
    const step = steps[index];
    if (!step) {
      finish();
      return;
    }
    resolveTarget(step, TARGET_RETRY_FRAMES);
  };

  // Advancing by clicking a nav link routes to a new screen; poll a few
  // frames so the next step can attach to the freshly rendered DOM.
  const resolveTarget = (step: GuideStep, frames: number) => {
    const el = step.target();
    if (!el && frames > 0) {
      requestAnimationFrame(() => resolveTarget(step, frames - 1));
      return;
    }
    show(step, el);
  };

  const show = (step: GuideStep, el: HTMLElement | null) => {
    target = el;
    if (el && step.advanceOnTargetClick) {
      advanceHandler = () => next();
      el.addEventListener('click', advanceHandler);
    }
    // Shepherd/Tether marked the attached element (`shepherd-target`); the
    // arrows theme is replaced by an outline highlight.
    el?.classList.add('om-guide-target');
    if (el && step.scrollIntoView) {
      // The original animated `html, body` so the row's bottom landed at the
      // bottom of the viewport; 'nearest' gives the same minimal alignment.
      // The tour's scroll listener keeps the popover attached on the way.
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    popover = h(
      'div',
      { class: 'om-guide-popover', role: 'dialog', dataset: { step: step.id } },
      h('div', { html: t(step.textKey) }),
      h(
        'div',
        { class: 'om-dialog-footer' },
        step.skipButton &&
          h('button', {
            type: 'button',
            class: 'om-btn',
            text: t('options_guideSkip'),
            onclick: () => finish(),
          }),
        h('button', {
          type: 'button',
          class: 'om-btn om-btn-primary',
          text: t(step.buttonKey),
          onclick: () => next(),
        }),
      ),
    );
    document.body.append(popover);
    reposition();
  };

  window.addEventListener('resize', reposition);
  document.addEventListener('scroll', reposition, true);
  next();
}
