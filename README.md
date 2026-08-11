SwitchyDelta
============

Manage and switch between multiple proxies quickly & easily.

[![Translation status](https://hosted.weblate.org/widgets/switchyomega/-/svg-badge.svg)](https://hosted.weblate.org/engage/switchyomega/?utm_source=widget)

SwitchyDelta is a Manifest V3 proxy-switching extension for Chromium-based
browsers (Chrome 114+). It is a ground-up TypeScript rewrite of the
SwitchyOmega codebase — same profile model and PAC generator semantics, none of
the legacy runtime. See [MIGRATION.md](MIGRATION.md) for the full story of the
rewrite, the bugs it found, and the measured results.

Installing
----------

- Load the unpacked build: `npm install && npm run build`, then load the
  `dist/` folder via `chrome://extensions` → Developer mode → *Load unpacked*
  (see Building below).
- Or grab a packaged build from the
  [Releases page](https://github.com/madeye/SwitchyDelta/releases).

Please [report issues on the issue tracker](https://github.com/madeye/SwitchyDelta/issues).

Firefox is not supported: this build targets Chromium's `chrome.proxy.settings`
and side panel APIs, and the old Firefox-only proxy paths were retired in the
rewrite.

Memory footprint
----------------

Measured live via a Chrome DevTools Protocol memory-infra dump (Chrome 151 on
macOS, v3.0.0, 2026-08-11): the extension's whole process has a **private
memory footprint of ~42 MB**, of which the service worker's JavaScript heap is
under 1 MB after GC. The rest is the fixed baseline of an empty Chromium
extension renderer (malloc/V8/GPU), which puts SwitchyDelta at the practical
floor for a Manifest V3 extension. The process only exists while the service
worker is awake; at idle the extension costs no memory at all.

For the detailed breakdown, methodology and a comparison against other popular
extensions, see [MIGRATION.md](MIGRATION.md#measured-memory-footprint).

Architecture
------------

The project is an npm workspace of four TypeScript packages:

| Package | What it is |
| --- | --- |
| [`packages/pac`](packages/pac) (`@switchydelta/pac`) | The profile model and PAC generator: conditions, rule-list parsing (AutoProxy/Switchy formats), a domain trie for fast matching, and a precedence-aware code emitter that compiles profiles into compact PAC scripts with no minifier. Standalone — nothing in it touches browser APIs. The public-suffix list lives behind the separate `@switchydelta/pac/psl` entry point so it stays out of the service worker. |
| [`packages/target`](packages/target) (`@switchydelta/target`) | Browser-independent options management: the options controller, storage abstraction, options sync with rate limiting and quota handling, and the upgrader for legacy SwitchyOmega 2.x / SwitchySharp options blobs. |
| [`packages/extension`](packages/extension) | The Chromium glue: the MV3 service worker, `chrome.storage` / `chrome.proxy.settings` bindings, proxy authentication, scheduled rule-list downloads via `chrome.alarms`, and the action icon. Deliberately reduced to what only a worker can do — see [MIGRATION.md](MIGRATION.md#scope-of-the-service-worker). |
| [`packages/ui`](packages/ui) | The popup and the options page (also registered as a Chrome side panel), built with Vite. Plain DOM TypeScript — no framework, no runtime dependencies. |

Supporting directories:

- [`omega-locales/`](omega-locales) — gettext translation catalogues, compiled
  into `_locales/*/messages.json` at build time.
- [`scripts/`](scripts) — the build pipeline: `build-extension.mjs` (esbuild
  worker bundle + asset assembly into `dist/`), `build-locales.mjs`,
  `render-icons.mjs`, `dev-chrome.mjs` (launch Chrome with the build loaded),
  and `publish-chrome.mjs` (Chrome Web Store upload; see `env.example`).
- [`test/e2e/`](test/e2e) — Puppeteer suites that exercise the built extension
  in a real headless Chrome, including PAC generation from a ~4.5k-rule list
  and traffic through a real CONNECT proxy.

Building
--------

Requires Node 18+ (22+ for the e2e suite, which uses the global `WebSocket`).

```sh
npm install        # workspace root
npm run build      # typecheck + UI + worker bundle -> dist/
npm test           # vitest unit suites (packages/pac, packages/target)
npm run e2e        # end-to-end: drives the built extension in headless Chrome
node scripts/dev-chrome.mjs   # manual testing: Chrome with dist/ installed
```

`dist/` is a complete unpacked extension. For development, rebuild and reload;
`dev-chrome.mjs` keeps a persistent profile between runs.

Translation
-----------

Translation is hosted on Weblate. If you want to help improve the translated
text or start translation for your language, please follow the link of the
picture below.

本项目翻译由Weblate托管。如果您希望帮助改进翻译，或将本项目翻译成一种新的语言，请
点击下方图片链接进入翻译。

[![Translation status](https://hosted.weblate.org/widgets/switchyomega/-/287x66-white.png)](https://hosted.weblate.org/engage/switchyomega/?utm_source=widget)

License
-------
![GPLv3](https://www.gnu.org/graphics/gplv3-127x51.png)

SwitchyDelta is licensed under [GNU General Public License](https://www.gnu.org/licenses/gpl.html) Version 3 or later.

SwitchyDelta is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

SwitchyDelta is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with SwitchyDelta.  If not, see <http://www.gnu.org/licenses/>.

Notice
------

SwitchyDelta currently does not have a dedicated project homepage. `switchydelta.com` and similar webites are NOT affiliated with the SwitchyDelta project in any way, nor are they maintained by SwitchyDelta project members. Please refer to this Github repository and wiki for official information.

SwitchyDelta is not cooperating with any proxy providers, VPN providers or ISPs at the moment. No advertisement is displayed in SwitchyDelta project or software. Proxy providers are welcome to recommend SwitchyDelta as part of the solution in tutorials, but it must be made clear that SwitchyDelta is an independent project, is not affiliated with the provider and therefore cannot provide any support on network connections or proxy technology.

重要声明
--------

SwitchyDelta 目前没有专门的项目主页。 `switchydelta.com` 等网站与 SwitchyDelta 项目并无任何关联，也并非由 SwitchyDelta 项目成员维护。一切信息请以 Github 上的项目和 wiki 为准。

SwitchyDelta 目前未与任何代理提供商、VPN提供商或 ISP 达成任何合作协议，项目或软件中不包含任何此类广告。欢迎代理提供商在教程或说明中推荐 SwitchyDelta ，但请明确说明此软件是独立项目，与代理提供商无关，且不提供任何关于网络连接或代理技术的支持。
