/**
 * Minimal Manifest V3 service worker for SwitchyDelta (Option B).
 *
 * Responsibilities only:
 *  - Load options and re-apply the active proxy profile (startup / wake)
 *  - Handle popup/options RPC (applyProfile, getState, patch, …)
 *  - Answer proxy auth challenges (webRequestAuthProvider)
 *  - Alarms for remote profile / rule-list updates
 *
 * Not included: request monitor, icon drawing, keep-alive, localStorage polyfill.
 */
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}
if (typeof globalThis.global === 'undefined') {
  globalThis.global = globalThis;
}

// log_error.js touches localStorage; skip it in the service worker.
// omega_pac.min.js is match-only (no uglify). PAC compile loads
// omega_pac_full.min.js on demand via ProxyImpl._pacWithCompiler.
importScripts(
  'js/omega_debug.js',
  'js/background_preload.js',
  'js/omega_pac.min.js',
  'js/omega_target.min.js',
  'js/omega_target_chromium_extension.min.js',
  'js/background.js'
);
