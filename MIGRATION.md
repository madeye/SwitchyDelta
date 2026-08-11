# TypeScript rewrite

SwitchyDelta is being moved off CoffeeScript + Grunt + Browserify + Bower +
AngularJS onto TypeScript + npm workspaces + Vite/esbuild + Vitest.

## Layout

| New package | Replaces | State |
| --- | --- | --- |
| `packages/pac` (`@switchydelta/pac`) | `omega-pac` | Done, 174 tests |
| `packages/target` (`@switchydelta/target`) | `omega-target` | Done, 46 tests |
| `packages/extension` | `omega-target-chromium-extension` | Done (reduced worker, see below) |
| `packages/ui` (`@switchydelta/ui`) | `omega-web` | Done |

The old CoffeeScript directories were kept until every replacement was verified
and v3.0.1 had shipped, then deleted. `omega-locales` (the gettext catalogues)
is data, not code, and stays: the build compiles it into `_locales/`.

## Commands

```sh
npm install          # workspace root
npm test             # vitest, all packages
npm run typecheck    # tsc --build across project references
npm run build        # per-package builds
```

## The main optimisations

**The PAC generator no longer uses a minifier.** The CoffeeScript version built
an UglifyJS 2 AST and then ran Uglify's compressor and mangler over it. A
general-purpose minifier is only needed when you do not control the input; this
generator controls every byte it emits, so it now emits compact code directly
through a small precedence-aware string emitter (`packages/pac/src/codegen.ts`).

That removed `uglify-js` (1.4 MB) and, with it, the reason for the two-bundle
architecture: `omega_pac.min.js` (match only, 448 KB) plus a lazily
`importScripts`-ed `omega_pac_full.min.js` (743 KB) existed purely to keep the
minifier out of the service worker's startup path. There is now one bundle.

`ip-address` (204 KB with `jsbn` and `sprintf-js`) is replaced by
`packages/pac/src/ip.ts`, which holds addresses as bytes, so subnet tests are a
byte compare rather than BigInteger arithmetic.

`tldjs` (356 KB, almost all of it the public suffix list) was reachable from the
service worker for exactly one call site — suggesting `*.example.com` when a
user adds a rule. It now lives behind the separate `@switchydelta/pac/psl`
entry point.

Net: **743 KB -> 30 KB** (10.7 KB gzipped), with the generator included.

Across the whole packaged extension, JavaScript goes from **1,730,921 bytes to
122,174** (93% smaller), both minified.

**The UI drops its framework.** 19 bower runtime packages become 44 KB of JS and
CSS with no runtime dependency. See the commit message on the UI package for why
Vite rather than Next.js.

**Other reductions in flight:** bluebird replaced by native `async`/`await`;
`limiter` replaced by a ~60-line token bucket; `heap` dropped with the dead
`WebRequestMonitor`; `xhr` replaced by `fetch`. `jsondiffpatch` stays only where
a real structural diff is needed.

**Logging.** `Log.method` ran on every storage read and write and pretty-prints
its subject with `JSON.stringify(..., 4)`, i.e. it serialised the whole options
object on every operation. Tracing is now opt-in via `setTracing`.

## Bugs found while porting

Each is fixed in the rewrite and noted in a comment at the site.

- `BypassCondition.analyze` assigned to `normalizedPattern` instead of appending,
  so `Conditions.str` silently dropped the scheme from patterns like
  `http://*.example.com`. Round-tripping such a rule changed its meaning.
- `Conditions.regTest` called `regexSafe()`, which is defined nowhere. Dead only
  because every caller happens to pass a `RegExp` rather than a string.
- `Options.init`: `if not err instanceof ProfileNotExistError` parses as
  `(not err) instanceof ...`, which is always false, so startup errors were
  never logged.
- `Options.loadOptions`: a branch tested an `options` identifier that does not
  exist in that scope, making it permanently dead.
- `Options` declared `_watchingProfiles: {}` and friends at prototype level,
  which shares one mutable object across all instances.
- `AttachedCache` used `Object.defineProperty` to hang a `_cache` property on
  caller-owned profile objects. It now uses a `WeakMap`, so profiles stay clean
  for serialisation.
- `OptionsSync._doPush` cleared its `_waiting` latch only on the success path.
  One transient failure reading remote state left the latch set, so every later
  push returned early and syncing stayed wedged for the life of the object. The
  same read also sat outside the `catch`, producing an unhandled rejection.
- `OptionsSync._legacyGet` declared its parsed `value` function-scoped and only
  assigned it inside a `try`, so a key whose JSON failed to parse inherited the
  previous key's value instead of falling back to the supplied default.
- `Options`'s constructor defaulted its storages with `@_storage ?= Storage()`,
  calling a class without `new`. That yields `undefined`, so the fallback never
  produced a usable storage.
- `Options.addTempRule` indexed the rule into `_tempProfileRulesByProfile`
  unconditionally, so calling it twice for the same domain and profile appended
  the same object again. The stale-rule cleanup in `applyProfile` then spliced
  by `indexOf` once per duplicate, and after the first removal `indexOf` returns
  `-1` — `splice(-1, 1)` deletes the last, unrelated rule. Both the duplicate
  push and the two unguarded splices are fixed.
- `Options.loadOptions` dereferenced `this.sync` unguarded while bootstrapping
  `syncOptions`. The write that would set `'unsupported'` is fire-and-forget, so
  with no sync available there is a window where the key is still empty and the
  dereference throws. That `TypeError` lands in the retry `catch`, which treats
  it as a serious failure and **reinstalls default options over the user's**.
- `Options.setExternalProfile` called `applyProfile(this._revertToProfileName)`
  on the first external change, when nothing had been remembered yet. It passed
  null, rejected with `ProfileNotExistError`, and nothing awaited it — so
  `-revertProxyChanges` silently never reverted the first change.
- `Options._setOptions` did not chain `_storage.remove(removed)`, so the
  returned promise could resolve before the keys were gone.
- `reloadQuickSwitch` and `_replaceRefChanges` dereferenced
  `-quickSwitchProfiles` with no guard against the key being absent.
- `renameProfile`, `addCondition` and `setDefaultProfile` built error messages
  from identifiers that did not resolve: an undeclared `name` (which found the
  *global* `name`, an empty string), and `@profile.name` where `profile` is a
  method, yielding the literal string `"profile"`.
- `ChromeStorage.parseStorageErrors` built the new `RateLimitExceededError`
  first and then tested `err.message` on that *new* error, whose message is
  empty. The `perHour` / `perMinute` flags were therefore never set.
- `ChromeStorage.watch` only converted the array form of `keys` into a lookup
  map. A single string key stayed a string, so the membership test indexed it
  by character and never matched — watches on one key silently never fired.
- `ChromeStorage.watch` derived its watcher id from `Date.now()` in a `while`
  loop, busy-spinning until the clock ticked whenever two watchers registered
  in the same millisecond.
- `proxy_impl_settings` iterated `profile.bypassList` unguarded, though it is
  optional on a FixedProfile, so a profile without one threw.
- `proxy_impl.coffee` referenced a free `OmegaPac` variable it never required.
  It worked only because the built worker happened to expose it as a global.
- The `h()` DOM helper assigned every unrecognised key as a JS property, so
  `aria-current` created a plain property instead of the attribute and the
  `[aria-current="true"]` rule that highlights the active profile in the popup
  never matched. Found only once the UI was added to the typecheck, which it
  had never been in.
- `fetch_url` compared the raw `Content-Type` header against a hint, so
  `text/html; charset=utf-8` never equalled `text/html`. Servers almost always
  send a charset, so the "response must not be HTML" guard silently never fired
  and HTML error pages were accepted as rule lists. The port compares the media
  type without parameters.

### Needs a decision

`OptionsSync.copyTo` has a pass meant to delete local profiles that are gone
upstream. Its guard reads `not base[key]?.syncOptions == 'disabled'`, which
compiles to `!(...) === 'disabled'` — a boolean compared against a string, so it
is always false. The intent was plainly `!=`. **This pass has therefore never
run.** It is preserved as-is, because "fixing" it would start deleting
local-only profiles on the first sync of an existing install. Enabling it should
be a deliberate, separately tested change.

Two smaller judgement calls, both deliberate:

- The token bucket starts **full**, whereas `limiter`'s starts empty (its
  `RateLimiter` wrapper refilled it, which is why nobody noticed). An empty
  start costs 6 s before the first sync write. Under MV2's persistent background
  page that was once per session; under MV3 the worker is recycled constantly,
  so it would be 6 s after every wake-up.
- The quota handler mutates caller-owned profile objects in place and depends on
  them being the same references already re-queued into `_pending`. Preserved,
  with the ordering dependency commented, and verified not to retry forever.

## Deliberate behaviour changes

- Requests are parsed with the WHATWG `URL` instead of Node's legacy
  `url.parse`. IPv6 hosts are therefore canonicalised the way Chrome
  canonicalises them before invoking a PAC script, so `http://[::1.2.3.4]/`
  presents as `::102:304`. This changes `<local>` matching for that input and is
  covered by a comment in `packages/pac/test/conditions.test.ts`.
- Generated PAC is always compact. The old exporter could emit a beautified,
  commented script; the emitter does not implement a pretty mode.
- `hostPatternToTrieKeys` is exported so tests can assert that the DomainTrie
  keys stay in lockstep with the regexes `Conditions` builds for the same
  pattern.

## Scope of the service worker

The worker is deliberately reduced to what only it can do:

- **proxy authentication** — `chrome.webRequest.onAuthRequired` has no other
  host, and its listener must be registered in the worker's first turn or the
  event that woke the worker is lost. Host access is an
  `optional_host_permissions` grant in this build: the popup offers it when a
  profile carries credentials, and until it is granted the listeners are
  registered but never fire.
- **scheduled downloads** — `chrome.alarms` is the only timer that survives
  suspension
- **applying the profile** to `chrome.proxy.settings`
- **answering RPC** from the options page and popup

Dropped from this build: quick-switch cycling, the badge and per-tab
icons/titles, the request monitor, the inspect context menus, and the
SwitchySharp / external-extension bridges. `proxy_impl_script` and
`proxy_impl_listener` are Firefox-only and were already dead on Chromium.

The per-tab icon later returned in reduced form: with an auto-switch (or
rule-list) profile active, the single global icon is tinted with the profile
that the *active tab's* URL matches (`active-tab-icon.ts`). Unlike the
original, no per-tab state is kept and only active-tab changes wake the
worker — and with a static profile a session-storage flag short-circuits the
event before the options controller boots. This is what brought the `tabs`
permission back.

Also dropped, UI-side only: the popup's temp-rule dropdown (and its `t`
shortcut), which let the user route the current domain through another profile
without saving a permanent rule. Unlike the drops above, the backend capability
survives — `Options.addTempRule` was ported and is still exposed over RPC
(`addTempRule` in the UI messaging layer) — so a future popup or side-panel
surface can reattach to it without worker changes.

Note that this does not reduce idle memory: MV3 workers are already
event-driven and terminate when idle. The 743 KB -> 30 KB PAC reduction is what
actually addresses the cost that motivated the previous `af4efbe` work.

## Measured memory footprint

Measured 2026-08-11 on Chrome 151 (macOS) against the running v3.0.0 build,
using a `disabled-by-default-memory-infra` tracing dump taken over the DevTools
protocol — the same attribution Chrome's own Task Manager uses. Only the
service worker was alive (no popup, options page or side panel open).

Private memory footprint of the extension's process: **41.7 MB**. The largest
allocators inside it:

| Allocator | Effective size |
| --- | --- |
| `malloc` | 22.2 MB |
| `v8` (2.0 MB of which is the shared read-only space) | 3.9 MB |
| `gpu` | 3.1 MB |
| `partition_alloc` | 1.4 MB |
| `blink_gc` | 0.9 MB |

The service worker's own JS heap is **0.7 MB after GC** (1.5 MB reserved;
`v8/workers/heap` = 1.1 MB in the dump). Everything else is the baseline cost
of an empty Chromium extension renderer — i.e. this build sits at the floor
for what a Manifest V3 extension can cost while its worker is running.

Extension processes in the same browser session, for scale (private footprint
from the same dump): MetaMask 389.3 MB, Claude in Chrome 108.6 MB, Bitwarden
89.8 MB, **SwitchyDelta 41.7 MB**, ChatGPT 37.7 MB.

Two caveats. `ps` RSS (~170 MB for the same process) overstates the cost on
macOS because it counts Chromium framework pages shared by every process —
private footprint is the honest number. And the process exists only while the
worker is awake: as noted above, at idle the extension costs no memory at all.

## Surfaces

The settings page is registered as a Chrome side panel
(`side_panel.default_path`), and the popup's settings button opens it via
`chrome.sidePanel.open`. `sidePanel` landed in Chrome 114, so
`minimum_chrome_version` moved from 109 to 114.

At panel width the sidebar collapses from a column into a horizontally
scrollable strip of chips, and an "open in tab" button appears, since the rule
tables are not usable at ~360px. The page is still registered as
`options_page`/`options_ui`, so the full-tab route is unchanged.

## The final porting round

Everything on the old remaining-work list is done. An audit of all 138 leftover
`.coffee` files classified each as already ported, deliberately dropped, or
build glue replaced by `scripts/*.mjs` — except seven that still carried real
behaviour or coverage, which were ported last:

- `omega-target/test/options_sync.coffee` → `packages/target/test/options-sync.test.ts`
  (17 tests, the first coverage of `OptionsSync`).
- `omega-target-chromium-extension/src/module/upgrade.coffee` →
  `packages/target/src/upgrade-legacy.ts` (29 tests) — the SwitchyOmega 2.x /
  SwitchySharp options upgrader, called from `chrome-options.ts` on first run.
- `omega-web/src/omega/controllers/pac_profile.coffee` → the PAC profile editor
  in `packages/ui/src/options/views.ts`, plus the profile-type choice on the
  new-profile screen (previously every profile type could be displayed but only
  Fixed/Switch/RuleList could be created).
- `omega-web/src/omega/controllers/switch_profile.coffee` — the remaining
  parity gaps in the Switch editor: the navigation guard for unparsed source
  edits, attached-rule-list validation on apply, `-confirmDeletion` on rule
  delete, the `TrueCondition` → `HostWildcardCondition('*')` legacy-import
  migration, and the effective-default fallback for new rules.
- `omega-web/src/coffee/options_guide.coffee` and `switch_profile_guide.coffee`
  → `packages/ui/src/options/guide.ts` (the guided tours, without Shepherd).
- `omega-web/src/coffee/popup.coffee` → `packages/ui/src/popup/shortcuts.ts`
  (the popup keyboard bindings; `?` shows the overlay).

Each port was adversarially reviewed against the CoffeeScript line by line;
the confirmed findings are fixed and commented at the site.

## Verification

`packages/pac` behaviour is pinned by the ported suite. The important invariant
is in `conditions.test.ts`: for every fixture, `match()` evaluated in-process and
the compiled PAC expression evaluated as real JavaScript must agree. That is what
makes replacing the code generator safe.

The built extension is exercised by the Puppeteer e2e suite (`npm run e2e`:
smoke, side panel, profiles, rule list against a real CONNECT proxy) and has
shipped to the Chrome Web Store as v3.0.x.
