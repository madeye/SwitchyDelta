# TypeScript rewrite

SwitchyDelta is being moved off CoffeeScript + Grunt + Browserify + Bower +
AngularJS onto TypeScript + npm workspaces + Vite/esbuild + Vitest.

## Layout

| New package | Replaces | State |
| --- | --- | --- |
| `packages/pac` (`@switchydelta/pac`) | `omega-pac` | Done, 174 tests |
| `packages/target` (`@switchydelta/target`) | `omega-target` | In progress |
| `packages/extension` | `omega-target-chromium-extension` | Not started |
| `packages/ui` (`@switchydelta/ui`) | `omega-web` | Foundation done |

The old directories are still present and untouched. Nothing is deleted until
the replacement is verified, so the two can be diffed against each other.

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

## Remaining work

1. **`packages/target`** — `options.ts` (the 1059-line controller) is the last
   file; the rest is ported and typechecks. It has no tests yet: the only
   existing suite was `omega-target/test/options_sync.coffee`, which still needs
   porting, and `Options` itself was never covered.
2. **`packages/extension`** — not started. Port `src/module/*` and the service
   worker. Notes from the survey worth keeping:
   - `ProxyAuth` must keep registering `onAuthRequired` synchronously in the
     worker's first turn, or the wake-up event that started the worker is lost.
     Its `chrome.storage.session` + `chrome.storage.local` dual-write is what
     survives worker suspension; do not "simplify" it away.
   - `_pacWithCompiler` and its `importScripts` hack should disappear with the
     single-bundle PAC package.
   - `proxy_impl.coffee` calls a bare global `OmegaPac`, relying on
     `importScripts` ordering. Give it a real import.
   - `tabs.coffee`, `web_request_monitor.coffee` and `inspect.coffee` are not
     wired into the current build. Decide whether to revive or drop them rather
     than porting them by reflex.
   - The Firefox-only `proxy_impl_script` / `proxy_impl_listener` paths are dead
     on Chromium; the comment forbidding bluebird in `onRequest` becomes moot
     with native promises.
3. **`packages/ui`** — editors for Pac, Switch, RuleList and Virtual profiles;
   the rule table with drag reorder; the modal flows (new/rename/replace/delete);
   options sync UI; the guided tours. The `switch_profile` controller was the
   largest piece of the old UI (460 lines) and carries the attached-rule-list
   logic, which is the subtlest part.
4. **Build glue** — a manifest generator and a step to compile the `omega-locales`
   `.po` catalogues into `_locales/*/messages.json`, replacing `grunt-po2crx`.
5. **Delete the old packages** once the extension loads and is exercised.

## Verification

`packages/pac` behaviour is pinned by the ported suite. The important invariant
is in `conditions.test.ts`: for every fixture, `match()` evaluated in-process and
the compiled PAC expression evaluated as real JavaScript must agree. That is what
makes replacing the code generator safe.

Nothing has been loaded in a browser yet.
